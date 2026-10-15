// Tiny, offset-preserving parsers. Everything here keeps character offsets
// identical to the source (comments are blanked with spaces, never removed) so
// findings map back to exact file:line:col and fixes can splice in place.

const blank = (s) => s.replace(/[^\n]/g, ' ');

/** Blank /* *\/ comments (and // comments for scss/less) outside strings. */
export function blankCssComments(text, lang = 'css') {
  let out = '';
  let i = 0;
  const lineComments = lang === 'scss' || lang === 'less' || lang === 'sass';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const end = findStringEnd(text, i, ch);
      out += text.slice(i, end); i = end; continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += blank(text.slice(i, stop)); i = stop; continue;
    }
    if (lineComments && ch === '/' && text[i + 1] === '/' && text[i - 1] !== ':' ) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += blank(text.slice(i, stop)); i = stop; continue;
    }
    out += ch; i++;
  }
  return out;
}

function findStringEnd(text, start, q) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === q) return i + 1;
    if (ch === '\n' && q !== '`') return i; // unterminated: stop at EOL
    i++;
  }
  return text.length;
}

/**
 * Walk CSS-like text (comments already blanked). Calls
 *   onDecl({ prop, value, valueStart, propStart, selectors })
 *   onAt({ name, params, paramsStart, selectors })     // block-less at-rules: @apply, @include …
 * `selectors` is the stack of block preludes enclosing the declaration.
 * Handles nesting (SCSS/LESS/native), #{…} and ${…} interpolation, strings and parens.
 */
export function walkCss(text, { onDecl, onAt, base = 0 } = {}) {
  const stack = [];
  let segStart = 0;
  let paren = 0;
  const flush = (end) => {
    const raw = text.slice(segStart, end);
    const lead = raw.length - raw.trimStart().length;
    const seg = raw.trim();
    if (!seg) return;
    const s0 = segStart + lead;
    if (seg.startsWith('@')) {
      const m = seg.match(/^@([\w-]+)\s*:?\s*/);
      if (!m) return;
      if (seg[m[0].length - 1] === ':' || /^@[\w-]+\s*:/.test(seg)) {
        // LESS variable definition  @name: value
        const colon = raw.indexOf(':');
        const vRaw = raw.slice(colon + 1);
        const vLead = vRaw.length - vRaw.trimStart().length;
        onDecl && onDecl({ prop: '@' + m[1], value: vRaw.trim(), valueStart: base + segStart + colon + 1 + vLead, propStart: base + s0, selectors: stack.slice() });
        return;
      }
      onAt && onAt({ name: m[1], params: seg.slice(m[0].length), paramsStart: base + s0 + m[0].length, selectors: stack.slice() });
      return;
    }
    // find first ':' outside parens/brackets
    let depth = 0, colon = -1;
    for (let k = 0; k < raw.length; k++) {
      const ch = raw[k];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ':' && depth === 0) { colon = k; break; }
    }
    if (colon === -1) return;
    const prop = raw.slice(0, colon).trim();
    if (!/^(--[\w-]+|\$[\w-]+|-?[a-zA-Z][\w-]*)$/.test(prop)) return;
    const vRaw = raw.slice(colon + 1);
    const vLead = vRaw.length - vRaw.trimStart().length;
    const value = vRaw.trim();
    onDecl && onDecl({ prop, value, valueStart: base + segStart + colon + 1 + vLead, propStart: base + s0, selectors: stack.slice() });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = findStringEnd(text, i, ch) - 1; continue; }
    if (ch === '(') { paren++; continue; }
    if (ch === ')') { paren = Math.max(0, paren - 1); continue; }
    if (paren > 0) continue;
    if (ch === '{') {
      if (text[i - 1] === '#' || text[i - 1] === '$') { // interpolation
        let d = 1, j = i + 1;
        for (; j < text.length && d; j++) { if (text[j] === '{') d++; else if (text[j] === '}') d--; }
        i = j - 1; continue;
      }
      stack.push(text.slice(segStart, i).trim().replace(/\s+/g, ' '));
      segStart = i + 1;
    } else if (ch === ';') {
      flush(i); segStart = i + 1;
    } else if (ch === '}') {
      flush(i); stack.pop(); segStart = i + 1;
    }
  }
  flush(text.length);
}

/**
 * Lex JS/TS/JSX just enough to: blank comments, and list string literals
 * (with their content offsets). Unterminated ' or " (JSX text apostrophes) are
 * treated as plain characters. Template literals record ${…} spans.
 */
export function lexJs(text) {
  const strings = [];
  let out = '';
  let i = 0;
  const n = text.length;
  const lexTemplate = (start) => {
    // returns end index (after closing backtick); pushes string literal
    let j = start + 1;
    const holes = [];
    while (j < n) {
      const ch = text[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '`') break;
      if (ch === '$' && text[j + 1] === '{') {
        const hs = j;
        let d = 1; j += 2;
        while (j < n && d) {
          const c2 = text[j];
          if (c2 === '`') { j = lexTemplate(j); continue; }
          if (c2 === '"' || c2 === "'") { j = findStringEnd(text, j, c2); continue; }
          if (c2 === '{') d++; else if (c2 === '}') d--;
          j++;
        }
        holes.push([hs, j]);
        continue;
      }
      j++;
    }
    strings.push({ quote: '`', start, end: Math.min(j + 1, n), contentStart: start + 1, content: text.slice(start + 1, j), holes });
    return Math.min(j + 1, n);
  };
  while (i < n) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += blank(text.slice(i, stop)); i = stop; continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(text.slice(i, stop)); i = stop; continue;
    }
    if (ch === '"' || ch === "'") {
      const end = findStringEnd(text, i, ch);
      if (text[end - 1] === ch && end - 1 > i) {
        strings.push({ quote: ch, start: i, end, contentStart: i + 1, content: text.slice(i + 1, end - 1), holes: [] });
        out += text.slice(i, end); i = end; continue;
      }
      out += ch; i++; continue; // unterminated → plain char
    }
    if (ch === '`') {
      const end = lexTemplate(i);
      out += text.slice(i, end); i = end; continue;
    }
    out += ch; i++;
  }
  strings.sort((a, b) => a.start - b.start);
  return { blanked: out, strings };
}

/** Split an SFC/HTML file into <style>, <script> and markup regions (offsets preserved). */
export function splitSfc(text) {
  const regions = [];
  const re = /<(style|script)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  const taken = [];
  while ((m = re.exec(text))) {
    const kind = m[1].toLowerCase();
    const attrs = m[2];
    const contentStart = m.index + m[0].indexOf('>') + 1;
    const lang = (attrs.match(/\blang\s*=\s*["']?(\w+)/i) || [])[1]?.toLowerCase();
    regions.push({ kind, lang: kind === 'style' ? (lang || 'css') : (lang || 'js'), start: contentStart, content: m[3] });
    taken.push([m.index, m.index + m[0].length]);
  }
  // markup = text with style/script blocks and <!-- --> comments blanked
  let markup = text;
  for (const [s, e] of taken) markup = markup.slice(0, s) + blank(markup.slice(s, e)) + markup.slice(e);
  markup = markup.replace(/<!--[\s\S]*?-->/g, blank);
  return { regions, markup };
}

/** Ranges [start,end) inside `value` covered by var(…), url(…), env(…), theme(…) calls. */
export function maskedRanges(value) {
  const ranges = [];
  const re = /\b(var|url|env|theme|image-set)\(/g;
  let m;
  while ((m = re.exec(value))) {
    let d = 1, j = m.index + m[0].length;
    for (; j < value.length && d; j++) { if (value[j] === '(') d++; else if (value[j] === ')') d--; }
    ranges.push([m.index, j]);
    re.lastIndex = j;
  }
  return ranges;
}
export const inRanges = (ranges, i) => ranges.some(([s, e]) => i >= s && i < e);
