#!/usr/bin/env node
/**
 * Find local dev servers to sweep. Lists listening TCP ports (via lsof/ss when
 * available, plus common dev ports), probes each over HTTP and prints the ones
 * that answer with HTML, with their <title>.
 *
 *   node detect-server.mjs            # human-readable list
 *   node detect-server.mjs --json     # [{ url, status, title, process }]
 *   node detect-server.mjs --ports 3000,5173
 *
 * Exit codes: 0 found at least one server, 3 none found.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('*/')[0].split('/**')[1].replace(/^ \* ?/gm, '').trim());
  process.exit(0);
}
const json = args.includes('--json');
const portsIdx = args.indexOf('--ports');
const COMMON = [3000, 3001, 3002, 3003, 3010, 3020, 3030, 3040, 3333, 4000, 4173, 4200, 4321, 4400, 5000, 5173, 5174, 5500, 6006, 8000, 8008, 8080, 8081, 8443, 8787, 8888, 9000];

const found = new Map(); // port -> process name
if (portsIdx >= 0) {
  for (const p of String(args[portsIdx + 1] || '').split(',').map(Number).filter(Boolean)) found.set(p, '');
} else {
  const lsof = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (lsof.status === 0) {
    for (const line of lsof.stdout.split('\n').slice(1)) {
      const m = line.match(/^(\S+)\s+\d+.*TCP\s+(?:\*|127\.0\.0\.1|\[::1?\]|localhost|0\.0\.0\.0):(\d+)\s+\(LISTEN\)/);
      if (m) found.set(+m[2], m[1].replace(/\\x20/g, ' '));
    }
  } else {
    const ss = spawnSync('ss', ['-ltnpH'], { encoding: 'utf8' });
    if (ss.status === 0) for (const line of ss.stdout.split('\n')) {
      const m = line.match(/:(\d+)\s+\S+\s*(?:users:\(\("([^"]+)")?/);
      if (m) found.set(+m[1], m[2] || '');
    }
  }
  for (const p of COMMON) if (!found.has(p)) found.set(p, '');
}

// Skip ports that are clearly not web dev servers.
const NOT_WEB = new Set([22, 25, 53, 111, 445, 548, 631, 3306, 5432, 5433, 5434, 5435, 6379, 7000, 11211, 27017]);
const ports = [...found.keys()].filter((p) => !NOT_WEB.has(p) && p >= 1024).sort((a, b) => a - b);

async function probe(port) {
  for (const host of ['localhost', '127.0.0.1']) {
    const url = `http://${host}:${port}/`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1200), redirect: 'follow' });
      const type = res.headers.get('content-type') || '';
      if (!/html/i.test(type)) return null;
      const body = (await res.text()).slice(0, 20000);
      const title = (body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
      return { url: `http://localhost:${port}/`, status: res.status, title, process: found.get(port) || undefined };
    } catch (_) {}
  }
  return null;
}

const results = (await Promise.all(ports.map(probe))).filter(Boolean);
if (json) console.log(JSON.stringify(results, null, 2));
else if (!results.length) console.log('✖ No local HTML servers found. Start your dev server (npm run dev) or pass a file path to sweep.mjs.');
else {
  console.log(`◆ ${results.length} local server${results.length === 1 ? '' : 's'} serving HTML:`);
  for (const r of results) console.log(`  ${r.url.padEnd(26)} ${String(r.status).padEnd(4)} ${r.title || '(no title)'}${r.process ? `  [${r.process}]` : ''}`);
}
process.exitCode = results.length ? 0 : 3;
