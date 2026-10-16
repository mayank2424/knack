#!/usr/bin/env node
/**
 * Procedural score + sound design for motion-video compositions. Zero dependencies.
 * render.mjs calls this automatically when a composition uses Motion.score() or Motion.cue().
 *
 *   node score.mjs cues.json -o score.wav      # { duration, score: {...}, cues: [...] }
 *
 * score: { bpm = 120, key = 'A', scale = 'minor', mood = 'driving' | 'minimal' | 'cinematic',
 *          drums = true, start = 0, end = duration (aliases: from, to), gain = 1,
 *          sections: [{ at, drums, bass, arp, pad, filter }] }   // arrangement: break down, build, drop
 *   sections: each entry switches parts on/off from `at` (seconds) onward; `filter` (Hz) low-passes
 *   the music bed and glides between sections. Example drop: [{ at: 7.8, drums: false, filter: 600 },
 *   { at: 9.84, drums: true, filter: 20000 }]
 * Loudness: integrated loudness is measured per ITU-R BS.1770 (K-weighted, gated) and normalized to
 * -14 LUFS with a -1 dBFS sample-peak ceiling.
 * cues:  [{ t, type, gain, length }] with type in
 *        whoosh | impact | hit | tick | riser | swell | glitch | pop | drop
 *        (riser/swell END at t: they build up to the moment. whoosh is centred just before t,
 *         so its loudest point lands on the cut.)
 */
import fs from 'node:fs';

const SR = 48000;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- dsp
function rng(seed = 1) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let r = Math.imul(a ^ (a >>> 15), 1 | a); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return (((r ^ (r >>> 14)) >>> 0) / 4294967296) * 2 - 1; };
}
/** RBJ biquad. type: lp | hp | bp. Coefficients can be updated per sample via set(). */
function biquad(type, f, q = 0.707) {
  let b0, b1, b2, a1, a2, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const set = (freq, Q = q) => {
    const w = (TAU * Math.min(freq, SR * 0.45)) / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * Q);
    let n0, n1, n2;
    if (type === 'lp') { n0 = (1 - c) / 2; n1 = 1 - c; n2 = (1 - c) / 2; }
    else if (type === 'hp') { n0 = (1 + c) / 2; n1 = -(1 + c); n2 = (1 + c) / 2; }
    else { n0 = al; n1 = 0; n2 = -al; }
    const d0 = 1 + al;
    b0 = n0 / d0; b1 = n1 / d0; b2 = n2 / d0; a1 = (-2 * c) / d0; a2 = (1 - al) / d0;
  };
  set(f);
  const run = (x) => { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
  run.set = set;
  return run;
}
const noteFreq = (semisFromA4) => 440 * Math.pow(2, semisFromA4 / 12);
const KEYS = { C: -9, 'C#': -8, Db: -8, D: -7, 'D#': -6, Eb: -6, E: -5, F: -4, 'F#': -3, Gb: -3, G: -2, 'G#': -1, Ab: -1, A: 0, 'A#': 1, Bb: 1, B: 2 };
const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10] };

/** Stereo buffer with additive writers. */
function makeBus(n) { return { L: new Float32Array(n), R: new Float32Array(n) }; }
const add = (bus, i, l, r = l) => { if (i >= 0 && i < bus.L.length) { bus.L[i] += l; bus.R[i] += r; } };

// ------------------------------------------------------------ voices
function kick(bus, t0, g = 1) {
  const s0 = Math.round(t0 * SR), n = Math.round(0.45 * SR);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = 46 + 110 * Math.exp(-t * 38);
    ph += (TAU * f) / SR;
    const env = Math.exp(-t * 7.5) * (t < 0.002 ? t / 0.002 : 1);
    const click = i < 90 ? Math.sin(i * 0.9) * (1 - i / 90) * 0.25 : 0;
    const v = Math.tanh(Math.sin(ph) * env * 1.6) * 0.9 * g + click * g;
    add(bus, s0 + i, v);
  }
}
function clap(bus, t0, g = 1, seed = 3) {
  const s0 = Math.round(t0 * SR), n = Math.round(0.28 * SR), r = rng(seed), bp = biquad('bp', 1600, 0.9), hp = biquad('hp', 600);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    // three quick bursts then a tail, like hands slightly out of sync
    const burst = t < 0.03 ? (Math.floor(t / 0.01) % 1 === 0 ? Math.exp(-((t % 0.01) * 300)) : 0) : 0;
    const env = Math.max(burst, Math.exp(-(t - 0.02) * 22) * (t > 0.02 ? 1 : 0));
    const v = hp(bp(r())) * env * 0.55 * g;
    add(bus, s0 + i, v * 0.95, v * 1.05);
  }
}
function hat(bus, t0, g = 1, open = false, seed = 5) {
  const s0 = Math.round(t0 * SR), dec = open ? 0.22 : 0.045, n = Math.round((dec * 5) * SR), r = rng(seed + Math.round(t0 * 1000)), hp = biquad('hp', 7500, 0.8), bp = biquad('bp', 10000, 0.6);
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = Math.exp(-t / dec);
    const v = (hp(r()) * 0.7 + bp(r()) * 0.3) * env * 0.16 * g;
    add(bus, s0 + i, v * 0.8, v * 1.2);
  }
}
/** Detuned saw stack through a low-pass, used for pad, bass and arp. */
function synthNote(bus, t0, dur, freq, { voices = 3, detune = 0.12, cutoff = 1800, q = 0.8, attack = 0.01, release = 0.2, g = 0.2, pan = 0, sweep = null, shape = 'saw' } = {}) {
  const s0 = Math.round(t0 * SR), n = Math.round((dur + release) * SR);
  const lp = biquad('lp', cutoff, q), phases = Array.from({ length: voices }, (_, k) => (k * 0.37) % 1);
  const ratios = Array.from({ length: voices }, (_, k) => Math.pow(2, ((k - (voices - 1) / 2) * detune) / 12));
  const pl = Math.cos(((pan + 1) * Math.PI) / 4), pr = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (sweep && i % 64 === 0) lp.set(sweep(t));
    let v = 0;
    for (let k = 0; k < voices; k++) {
      phases[k] = (phases[k] + (freq * ratios[k]) / SR) % 1;
      const p = phases[k];
      v += shape === 'square' ? (p < 0.5 ? 1 : -1) : shape === 'sine' ? Math.sin(TAU * p) : 2 * p - 1;
    }
    v /= voices;
    const env = (t < attack ? t / attack : 1) * (t > dur ? Math.exp(-(t - dur) / (release / 4)) : 1);
    const y = lp(v) * env * g;
    add(bus, s0 + i, y * pl * 1.41, y * pr * 1.41);
  }
}

// ---------------------------------------------------------------- sfx
function noiseSweep(bus, t0, len, f0, f1, g, q = 4, seed = 9, panFrom = -0.6, panTo = 0.6, shape = 'swell') {
  const s0 = Math.round(t0 * SR), n = Math.round(len * SR), r = rng(seed), bp = biquad('bp', f0, q), lp = biquad('lp', 9000);
  for (let i = 0; i < n; i++) {
    const p = i / n;
    if (i % 32 === 0) bp.set(f0 * Math.pow(f1 / f0, p), q);
    const env = shape === 'riser' ? Math.pow(p, 2.2) : Math.sin(Math.PI * Math.pow(p, 0.75)) ** 2;
    const v = lp(bp(r())) * env * g * 1.6;
    const pan = panFrom + (panTo - panFrom) * p, pl = Math.cos(((pan + 1) * Math.PI) / 4), pr = Math.sin(((pan + 1) * Math.PI) / 4);
    add(bus, s0 + i, v * pl * 1.41, v * pr * 1.41);
  }
}
const SFX = {
  whoosh: (bus, c) => noiseSweep(bus, c.t - (c.length ?? 0.45) * 0.55, c.length ?? 0.45, 300, 4200, 0.5 * (c.gain ?? 1), 3.5, 11 + Math.round(c.t * 10)),
  riser: (bus, c) => {
    const len = c.length ?? 1.5;
    noiseSweep(bus, c.t - len, len, 400, 9000, 0.32 * (c.gain ?? 1), 2.5, 21, 0, 0, 'riser');
    const s0 = Math.round((c.t - len) * SR), n = Math.round(len * SR); let ph = 0;
    for (let i = 0; i < n; i++) { const p = i / n; ph += (TAU * (220 * Math.pow(4, p))) / SR; add(bus, s0 + i, Math.sin(ph) * p * p * 0.08 * (c.gain ?? 1)); }
  },
  swell: (bus, c) => { const len = c.length ?? 1.2; noiseSweep(bus, c.t - len, len, 200, 2500, 0.22 * (c.gain ?? 1), 1.2, 31, -0.2, 0.2, 'riser'); },
  impact: (bus, c) => {
    const g = c.gain ?? 1, s0 = Math.round(c.t * SR), n = Math.round(1.6 * SR), r = rng(41), lp = biquad('lp', 1800);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR; ph += (TAU * (38 + 60 * Math.exp(-t * 18))) / SR;
      const boom = Math.tanh(Math.sin(ph) * Math.exp(-t * 2.6) * 2.2) * 0.75;
      const crack = lp(r()) * Math.exp(-t * 14) * 0.5;
      add(bus, s0 + i, (boom + crack) * g);
    }
  },
  drop: (bus, c) => { SFX.impact(bus, { ...c, gain: (c.gain ?? 1) * 1.1 }); kick(bus, c.t, c.gain ?? 1); },
  hit: (bus, c) => { kick(bus, c.t, 0.8 * (c.gain ?? 1)); clap(bus, c.t, 0.9 * (c.gain ?? 1), 13); },
  tick: (bus, c) => {
    const s0 = Math.round(c.t * SR), n = Math.round(0.03 * SR);
    for (let i = 0; i < n; i++) add(bus, s0 + i, Math.sin((TAU * 2400 * i) / SR) * Math.exp(-i / (0.004 * SR)) * 0.25 * (c.gain ?? 1));
  },
  pop: (bus, c) => {
    const s0 = Math.round(c.t * SR), n = Math.round(0.14 * SR); let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / SR; ph += (TAU * (900 * Math.exp(-t * 30) + 300)) / SR; add(bus, s0 + i, Math.sin(ph) * Math.exp(-t * 28) * 0.35 * (c.gain ?? 1)); }
  },
  glitch: (bus, c) => {
    const g = c.gain ?? 1, len = c.length ?? 0.25, r = rng(51 + Math.round(c.t * 100)), s0 = Math.round(c.t * SR), n = Math.round(len * SR);
    let hold = 0, v = 0;
    for (let i = 0; i < n; i++) {
      if (i % 1600 < 800) { if (hold-- <= 0) { v = Math.round(r() * 4) / 4; hold = 18 + Math.floor((r() + 1) * 40); } add(bus, s0 + i, v * 0.22 * g, -v * 0.22 * g); }
    }
  },
};

// ------------------------------------------------------------ loudness
/** Integrated loudness (LUFS) per ITU-R BS.1770-4: K-weighting, 400 ms blocks, absolute + relative gates. */
export function measureLufs(L, R, sr = SR) {
  const kw = () => {
    // Stage 1 high shelf + stage 2 high-pass (coefficients for 48 kHz).
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, v1 = 0, v2 = 0;
    return (x) => {
      const y = 1.53512485958697 * x - 2.69169618940638 * x1 + 1.19839281085285 * x2 + 1.69065929318241 * y1 - 0.73248077421585 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const v = y - 2 * u1 + u2 + 1.99004745483398 * v1 - 0.99007225036621 * v2;
      u2 = u1; u1 = y; v2 = v1; v1 = v;
      return v;
    };
  };
  const fl = kw(), fr = kw(), n = L.length, sq = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = fl(L[i]), b = fr(R[i]); sq[i] = a * a + b * b; }
  const block = Math.round(0.4 * sr), hop = Math.round(0.1 * sr), blocks = [];
  // prefix sums for fast block means
  const cs = new Float64Array(n + 1); for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + sq[i];
  for (let s0 = 0; s0 + block <= n; s0 += hop) blocks.push((cs[s0 + block] - cs[s0]) / block);
  if (!blocks.length) blocks.push(cs[n] / Math.max(1, n));
  const lk = (z) => -0.691 + 10 * Math.log10(z || 1e-12);
  const abs = blocks.filter((z) => lk(z) > -70);
  if (!abs.length) return -70;
  const relGate = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((z) => lk(z) > relGate);
  return lk(rel.reduce((a, b) => a + b, 0) / rel.length);
}

// -------------------------------------------------------------- reverb
function reverb(bus, mix = 0.18) {
  const combsL = [1557, 1617, 1491, 1422].map((d) => ({ buf: new Float32Array(d), i: 0, f: 0.82 }));
  const combsR = [1580, 1640, 1514, 1445].map((d) => ({ buf: new Float32Array(d), i: 0, f: 0.82 }));
  const aps = (ds) => ds.map((d) => ({ buf: new Float32Array(d), i: 0 }));
  const apL = aps([556, 441]), apR = aps([579, 464]);
  const proc = (x, combs, ap) => {
    let y = 0;
    for (const c of combs) { const o = c.buf[c.i]; c.buf[c.i] = x + o * c.f; c.i = (c.i + 1) % c.buf.length; y += o; }
    y *= 0.25;
    for (const a of ap) { const o = a.buf[a.i]; const v = -y + o; a.buf[a.i] = y + o * 0.5; a.i = (a.i + 1) % a.buf.length; y = v; }
    return y;
  };
  const hpL = biquad('hp', 250), hpR = biquad('hp', 250);
  for (let i = 0; i < bus.L.length; i++) {
    const wl = proc(hpL(bus.L[i]), combsL, apL), wr = proc(hpR(bus.R[i]), combsR, apR);
    bus.L[i] += wl * mix; bus.R[i] += wr * mix;
  }
}

// ---------------------------------------------------------------- main
export function renderScore({ duration, score = {}, cues = [] }) {
  const n = Math.ceil((duration + 0.01) * SR);
  const music = makeBus(n), sfx = makeBus(n), drums = makeBus(n);
  const bpm = score.bpm || 120, beat = 60 / bpm, mood = score.mood || 'driving';
  const startT = score.start ?? score.from ?? 0, endT = score.end ?? score.to ?? duration;
  // Arrangement: sections switch parts on/off from their `at` time onward.
  const secs = (score.sections || []).slice().sort((a, b) => a.at - b.at);
  const part = (name, t, dflt = true) => { let v = dflt; for (const sc of secs) if (sc.at <= t + 1e-6 && sc[name] !== undefined) v = sc[name]; return v; };
  const root = KEYS[score.key || 'A'] ?? 0, scale = SCALES[score.scale || 'minor'] || SCALES.minor;
  const deg = (d, oct = 0) => noteFreq(root - 12 + scale[((d % 7) + 7) % 7] + 12 * (Math.floor(d / 7) + oct));
  // i – VI – III – VII in minor (i – vi – IV – V feel in major), one chord per bar.
  const prog = [0, 5, 2, 6];
  const bars = Math.ceil(duration / (beat * 4));
  const drumsOn = score.drums !== false && mood !== 'cinematic';
  const kickTimes = [];

  for (let bar = 0; bar < bars; bar++) {
    const t0 = startT + bar * beat * 4;
    if (t0 >= endT) break;
    const d = prog[bar % prog.length], barLen = Math.min(beat * 4, endT - t0);
    // Pad: 1-3-5-7-9 voicing, filter opens over the first bar for a lift.
    if (part('pad', t0)) for (const [k, iv] of [[0, 0], [1, 2], [2, 4], [3, 6], [4, 8]]) {
      synthNote(music, t0, barLen, deg(d + iv, 1) , { voices: 3, detune: 0.14, cutoff: mood === 'cinematic' ? 1400 : 2200, attack: bar === 0 ? 0.6 : 0.08, release: 0.5, g: 0.045, pan: (k - 2) * 0.25,
        sweep: bar === 0 ? (t) => 400 + 1800 * Math.min(1, t / barLen) : null });
    }
    if (mood === 'cinematic') { synthNote(music, t0, barLen, deg(d, -1), { voices: 2, cutoff: 300, g: 0.16, attack: 0.3, release: 0.6, shape: 'sine' }); continue; }
    // Bass: offbeat 8ths on the root (classic sidechained drive).
    for (let e = 0; e < 8; e++) {
      const tt = t0 + e * beat / 2;
      if (tt >= endT) break;
      if ((mood === 'driving' || e % 2 === 1) && part('bass', tt)) synthNote(music, tt, beat / 2 * 0.85, deg(d, -1), { voices: 2, detune: 0.05, cutoff: 700, q: 1.2, attack: 0.004, release: 0.05, g: 0.17, shape: 'saw' });
    }
    // Arp: 16ths over chord tones (driving only), stereo-spread.
    if (mood === 'driving' && bar > 0) {
      const tones = [0, 2, 4, 7, 9, 7, 4, 2];
      for (let s = 0; s < 16; s++) {
        const tt = t0 + s * beat / 4;
        if (tt >= endT) break;
        if (!part('arp', tt)) continue;
        synthNote(music, tt, beat / 4 * 0.6, deg(d + tones[s % 8], 2), { voices: 1, cutoff: 3400, q: 2, attack: 0.002, release: 0.06, g: 0.035, pan: s % 2 ? 0.45 : -0.45, shape: 'square' });
      }
    }
    if (!drumsOn) continue;
    for (let b = 0; b < 4; b++) {
      const tb = t0 + b * beat;
      if (tb >= endT) break;
      const dOn = (tt) => part('drums', tt);
      if ((mood === 'driving' || b % 2 === 0) && dOn(tb)) { kick(drums, tb, 1); kickTimes.push(tb); }
      if (b % 2 === 1 && (bar > 0 || mood !== 'driving') && dOn(tb)) clap(drums, tb, 0.85, 3 + b);
      if (dOn(tb + beat / 2)) hat(drums, tb + beat / 2, 1, mood === 'driving' && b % 2 === 1);
      if (mood === 'driving') { if (dOn(tb + beat / 4)) hat(drums, tb + beat / 4, 0.45); if (dOn(tb + 3 * beat / 4)) hat(drums, tb + 3 * beat / 4, 0.45); }
    }
  }
  // Filter automation from sections: glide the music bed's low-pass between section cutoffs.
  const fpts = secs.filter((sc) => sc.filter !== undefined).map((sc) => [sc.at, sc.filter]);
  if (fpts.length) {
    const cutoff = (t) => {
      if (t <= fpts[0][0]) return 20000;
      for (let k = 0; k < fpts.length - 1; k++) if (t < fpts[k + 1][0]) {
        // hold, then glide over the last 40% of the gap so builds sweep into the next section
        const [a, fa] = fpts[k], [b, fb] = fpts[k + 1], g = Math.max(0, (t - (a + (b - a) * 0.6)) / ((b - a) * 0.4));
        return fa * Math.pow(fb / fa, Math.min(1, g));
      }
      return fpts[fpts.length - 1][1];
    };
    const lpL = biquad('lp', 20000, 0.9), lpR = biquad('lp', 20000, 0.9);
    for (let i = 0; i < n; i++) {
      if (i % 64 === 0) { const f = cutoff(i / SR); lpL.set(f, 0.9); lpR.set(f, 0.9); }
      music.L[i] = lpL(music.L[i]); music.R[i] = lpR(music.R[i]);
    }
  }

  // Sidechain the music bed to the kick (the "pump").
  const duck = new Float32Array(n).fill(1);
  for (const kt of kickTimes) { const s0 = Math.round(kt * SR), len = Math.round(beat * 0.9 * SR); for (let i = 0; i < len && s0 + i < n; i++) duck[s0 + i] = Math.min(duck[s0 + i], 1 - 0.65 * Math.exp(-(i / SR) / (beat * 0.28))); }
  for (let i = 0; i < n; i++) { music.L[i] *= duck[i]; music.R[i] *= duck[i]; }

  for (const c of cues) { const f = SFX[c.type]; if (f) f(sfx, c); else console.warn(`[score] unknown cue type "${c.type}"`); }

  const mix = makeBus(n), mg = score.gain ?? 1;
  for (let i = 0; i < n; i++) {
    mix.L[i] = music.L[i] * mg + drums.L[i] * 0.9 * mg + sfx.L[i];
    mix.R[i] = music.R[i] * mg + drums.R[i] * 0.9 * mg + sfx.R[i];
  }
  reverb(mix, 0.16);
  // Master: gentle drive, then normalize to -14 LUFS (BS.1770) with a -1 dBFS sample-peak ceiling.
  for (let i = 0; i < n; i++) { mix.L[i] = Math.tanh(mix.L[i] * 1.2); mix.R[i] = Math.tanh(mix.R[i] * 1.2); }
  const lufs0 = measureLufs(mix.L, mix.R);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mix.L[i]), Math.abs(mix.R[i]));
  const gain = Math.min(Math.pow(10, (-14 - lufs0) / 20), Math.pow(10, -1 / 20) / (peak || 1));
  const fadeIn = Math.round(0.01 * SR);
  for (let i = 0; i < n; i++) { const f = i < fadeIn ? i / fadeIn : 1; mix.L[i] *= gain * f; mix.R[i] *= gain * f; }
  const lufs = lufs0 + 20 * Math.log10(gain);
  return { ...mix, sampleRate: SR, lufs, rmsDb: lufs, peakDb: 20 * Math.log10(peak * gain) };
}

export function writeWav(path, { L, R, sampleRate = SR }) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(path, buf);
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  if (!a[0] || a.includes('--help')) { console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('*/')[0].replace('/**', '').replace(/^ \* ?/gm, '')); process.exit(a[0] ? 0 : 1); }
  const spec = JSON.parse(fs.readFileSync(a[0], 'utf8'));
  const out = a[a.indexOf('-o') + 1] || 'score.wav';
  const res = renderScore(spec);
  writeWav(out, res);
  console.log(`◆ Score → ${out} (${spec.duration}s, ${res.lufs.toFixed(1)} LUFS, peak ${res.peakDb.toFixed(1)} dBFS, ${spec.cues?.length || 0} cues)`);
}
