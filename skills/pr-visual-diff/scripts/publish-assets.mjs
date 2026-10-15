#!/usr/bin/env node
/**
 * Host compare images on an orphan "assets" branch so a PR description can embed them.
 * GitHub has no API for uploading images into PR bodies; a branch in the same repo is the
 * scriptable option. Uses git plumbing only: no checkout, your working tree is untouched.
 *
 * DRY RUN BY DEFAULT. Nothing is pushed unless you pass --push (ask the user first).
 *
 *   node publish-assets.mjs --prefix pr-123                 # show what would be pushed
 *   node publish-assets.mjs --prefix pr-123 --push          # push and write summary.pr.md
 *   node publish-assets.mjs --prefix feat-hero --include all --push
 *
 * Options:
 *   --dir <path>         capture.mjs output folder (default: ./.knack/pr-visual-diff)
 *   --prefix <name>      Folder on the assets branch, e.g. pr-123 or the branch name (required)
 *   --branch <name>      Assets branch (default: pr-visual-diff-assets)
 *   --remote <name>      Remote to push to (default: origin)
 *   --include <what>     changed (default: compare.png of changed + minor pairs) | all (every png)
 *   --markdown <file>    Markdown whose relative image links get rewritten
 *                        (default: <dir>/summary.md → writes <dir>/summary.pr.md)
 *   --push               Actually push. Without it, only prints the plan.
 *
 * Image URLs use https://github.com/<owner>/<repo>/raw/<commit-sha>/<path>, pinned to the
 * commit so later pushes never change what an old PR shows.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, printHelp, log, ok, warn, die, git, repoRoot } from './lib.mjs';

const opts = parseArgs(process.argv.slice(2), { values: ['dir', 'prefix', 'branch', 'remote', 'include', 'markdown', 'repo'] });
if (opts.help) { printHelp(import.meta.url); process.exit(0); }
if (!opts.prefix) { printHelp(import.meta.url); die('--prefix is required (e.g. pr-123 or your branch name).'); }

const repo = repoRoot(opts.repo ? path.resolve(opts.repo) : process.cwd());
const dir = path.resolve(opts.dir || '.knack/pr-visual-diff');
const branch = opts.branch || 'pr-visual-diff-assets';
const remote = opts.remote || 'origin';
const prefix = String(opts.prefix).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
const summaryFile = path.join(dir, 'summary.json');
if (!fs.existsSync(summaryFile)) die(`No summary.json in ${dir}. Run capture.mjs first (or pass --dir).`);
const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));

// ------------------------------------------------------------- pick files
const files = [];
for (const r of summary.results) {
  if (!r.files?.compare) continue;
  if (opts.include === 'all') files.push(...Object.values(r.files));
  else if (r.status === 'changed' || r.status === 'minor') files.push(r.files.compare);
}
if (!files.length) die('Nothing to publish: no changed or minor pairs (use --include all to publish everything).');
const missing = files.filter((f) => !fs.existsSync(path.join(dir, f)));
if (missing.length) die(`Missing files (re-run capture.mjs?): ${missing.join(', ')}`);
const bytes = files.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);

// ------------------------------------------------------------ remote info
const remoteUrl = git(['config', '--get', `remote.${remote}.url`], repo, { allowFail: true }); // raw, before insteadOf rewriting
if (!remoteUrl) die(`No git remote named "${remote}". Pass --remote <name>.`);
const gh = remoteUrl.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/);
if (!gh) warn(`Remote ${remoteUrl} is not on github.com; URLs below assume GitHub's /raw/ layout and may need adjusting.`);
const [owner, name] = gh ? [gh[1], gh[2]] : ['OWNER', path.basename(remoteUrl).replace(/\.git$/, '')];

console.log(`Plan${opts.push ? '' : ' (dry run, nothing pushed)'}:`);
console.log(`  remote:  ${remote} (${remoteUrl})`);
console.log(`  branch:  ${branch}  (orphan branch holding only screenshots)`);
console.log(`  folder:  ${prefix}/`);
console.log(`  files:   ${files.length} PNG(s), ${(bytes / 1e6).toFixed(2)} MB`);
files.forEach((f) => console.log(`           ${prefix}/${f}`));
if (!opts.push) {
  console.log('\nThis adds a branch to the shared repository that everyone with access can see.');
  console.log('After the user agrees, re-run with --push.');
  process.exit(0);
}

// ---------------------------------------------------------- build commit
// Start from the remote branch if it exists, so earlier PRs' images stay reachable.
let parent = null;
const fetched = git(['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/knack/${branch}`], repo, { allowFail: true });
if (fetched !== null) parent = git(['rev-parse', '--verify', '--quiet', `refs/knack/${branch}`], repo, { allowFail: true });
const index = path.join(os.tmpdir(), `knack-pvd-index-${process.pid}`);
const env = { GIT_INDEX_FILE: index };
try {
  if (parent) git(['read-tree', parent], repo, { env });
  else git(['read-tree', '--empty'], repo, { env });
  git(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', `${prefix}/`], repo, { env, allowFail: true });
  for (const f of files) {
    const sha = git(['hash-object', '-w', path.join(dir, f)], repo);
    git(['update-index', '--add', '--cacheinfo', `100644,${sha},${prefix}/${f}`], repo, { env });
  }
  const readme = `# Screenshots for pull requests\n\nWritten by Knack pr-visual-diff. Each folder belongs to one PR. Safe to delete old folders or the whole branch.\n`;
  const rsha = spawnHash(readme);
  git(['update-index', '--add', '--cacheinfo', `100644,${rsha},README.md`], repo, { env });
  const tree = git(['write-tree'], repo, { env });
  const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `pr-visual-diff: screenshots for ${prefix}`], repo);
  log(`Pushing ${commit.slice(0, 7)} to ${remote}/${branch} …`);
  git(['push', '--quiet', remote, `${commit}:refs/heads/${branch}`], repo);
  ok(`Pushed ${files.length} image(s) to ${remote}/${branch}`);

  const urlFor = (f) => `https://github.com/${owner}/${name}/raw/${commit}/${prefix}/${f}`;
  const mdIn = path.resolve(opts.markdown || path.join(dir, 'summary.md'));
  if (fs.existsSync(mdIn)) {
    let md = fs.readFileSync(mdIn, 'utf8');
    for (const f of files) md = md.split(`](${f})`).join(`](${urlFor(f)})`).split(`src="${f}"`).join(`src="${urlFor(f)}"`);
    const mdOut = mdIn.replace(/\.md$/, '') + '.pr.md';
    fs.writeFileSync(mdOut, md);
    ok(`PR-ready markdown with absolute image URLs: ${mdOut}`);
  }
  console.log('Image URLs:');
  files.forEach((f) => console.log(`  ${urlFor(f)}`));
  console.log(`Remove later with: git push ${remote} --delete ${branch}`);
} finally {
  fs.rmSync(index, { force: true });
  git(['update-ref', '-d', `refs/knack/${branch}`], repo, { allowFail: true });
}

function spawnHash(text) {
  const tmp = path.join(os.tmpdir(), `knack-pvd-readme-${process.pid}.md`);
  fs.writeFileSync(tmp, text);
  try { return git(['hash-object', '-w', tmp], repo); } finally { fs.rmSync(tmp, { force: true }); }
}
