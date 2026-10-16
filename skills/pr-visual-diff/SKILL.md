---
name: pr-visual-diff
description: >-
  Captures before/after screenshots of the pages a frontend change touches, pixel-diffs
  them at several viewport widths, and writes a ready-to-paste "Visual changes" section
  for the pull request with side-by-side base | head | diff images. Brings up the base
  branch in a throwaway git worktree (never touches the working tree), maps changed files
  to routes (Next.js, Remix / React Router, SvelteKit, Nuxt, Astro, plain HTML), and flags
  unintended visual regressions. Use when the user says "add before/after screenshots to
  my PR", "visual diff this branch", "did my CSS refactor change anything visually?",
  "screenshot the UI changes for review", "check for visual regressions before I merge",
  or is opening or updating a PR that changes UI, styles or components.
license: MIT
argument-hint: "[base-ref] [pages]"
metadata:
  title: PR Visual Diff
  category: dev
  tags: visual-regression, screenshots, pull-request, playwright, pixelmatch, code-review
  version: 0.2.0
  author: Mayank Gupta
---

# PR Visual Diff

Reviewers can't see what a frontend PR looks like. This skill builds the evidence: the
same pages, same viewports, base vs head, pixel-diffed, with a plain-language description
of what changed and what looks unintended.

Scripts live in `${CLAUDE_SKILL_DIR}/scripts/`. Every script supports `--help`. Output goes
to `./.knack/pr-visual-diff/` in the user's project.

## Ground rules

- **Never modify the user's working tree.** The base build runs in a temp git worktree.
  Don't stash, checkout, or reset.
- **Ask before anything leaves the machine**: pushing a branch, editing a PR body,
  posting a comment. Show the markdown first and get a clear yes for each action.
- **Never type the user's passwords.** For logged-in pages, ask them to create a
  storage-state file themselves (step 4).
- Don't stop servers you didn't start. Clean up the ones you did (step 8).

## Workflow

### 1. Setup (once per machine)

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/setup.sh"
```

### 2. Decide the base and the pages

```bash
# If a PR already exists, its base branch is the right base:
gh pr view --json baseRefName -q .baseRefName 2>/dev/null
node "${CLAUDE_SKILL_DIR}/scripts/affected-pages.mjs" [--base origin/<base>] [--dir apps/web]
```

It prints candidate routes with confidence (high / medium / low) and the reason chain,
then a `PAGES=` line. Use it as a starting point, not gospel:

- Dynamic routes (`/blog/[slug]`, `/users/:id`) need a real value. Find one from seed
  data, fixtures, or links on the index page, or ask the user.
- "Global change" (Tailwind config, global CSS, theme tokens, root layout) means every page
  can move. Capture a representative set: home, one form-heavy page, one list/table page.
- If nothing maps (SPA with unusual routing), read the diff and pick pages yourself.
- Widths: default `375,1280`. Add `768` when breakpoint or grid code changed.
- Keep it to about 3-8 pages. More is slow and buries the signal.

### 3. Bring up head (the PR's version)

Head should include uncommitted work, so it runs from the user's tree.

1. **Reuse a running dev server** if there is one (ask, or check
   `lsof -nP -iTCP -sTCP:LISTEN | grep -E 'node|bun|deno'`).
2. Otherwise start one: `node "${CLAUDE_SKILL_DIR}/scripts/worktree-serve.mjs" serve` → prints `HEAD_URL=`.
3. Deployed preview URLs (Vercel/Netlify per-PR previews) work too, for both sides.

### 4. Bring up base (the "before" version)

```bash
node "${CLAUDE_SKILL_DIR}/scripts/worktree-serve.mjs" start [--ref origin/main] [--dir apps/web] [--copy-env]
```

It creates a worktree of the merge-base in the OS temp dir, installs deps (lockfile
decides pnpm / yarn / npm / bun), starts the dev server on a free port (4100+), waits until
it answers, and prints `BASE_URL=`. Notes:

- Run `--dry-run` first if unsure; it prints the plan without executing.
- The worktree lacks untracked `.env` files. If the app needs them, tell the user, then
  re-run with `--copy-env` (copies `.env*` into the temp worktree only).
- Lockfile unchanged since base? `--link-node-modules` skips the install by symlinking
  (ignored for Next.js: Turbopack rejects it).
- It warns if `/` answers HTTP 5xx (app erroring: read the log tail it prints) and copes
  with dev servers that detach themselves (Astro 7 does when it detects an agent).
- If it can't start, it prints exactly what to run instead. Follow that, or pass
  `--cmd "pnpm dev --port {port}"`. Port flags per framework: `references/frameworks.md`.
- Static sites without package.json are served by a built-in static server. Plain folders
  or `file://` URLs also work directly in step 5.
- Logged-in pages: ask the user to run `npx playwright codegen --save-storage=auth.json <HEAD_URL>/login`,
  log in themselves, close the window. Pass `--storage-state auth.json` to capture.
  Cookies on `localhost` are shared across ports; localStorage is per port.

### 5. Capture and diff

```bash
node "${CLAUDE_SKILL_DIR}/scripts/capture.mjs" \
  --base "$BASE_URL" --head "$HEAD_URL" \
  --pages /,/pricing,/settings --widths 375,1280 \
  --label-base "main @ a1b2c3d" --label-head "feat/new-nav"
```

Determinism is on by default: a virtual clock (timers, `requestAnimationFrame` and `Date`
advance by identical fixed steps on both sides), seeded `Math.random`, media that never
plays, CSS/JS animations, GIFs and SMIL frozen or stepped, fonts, images and `aria-busy`
waited for. Unchanged pages diffed at exactly 0 pixels on 116 of 120 test pairs; what's
left (canvas, embeds, exotic widgets) needs `--mask`. Details: `references/stabilization.md`.

Useful flags: `--full-page` (whole scroll height; use when the change is below the fold),
`--mask ".timestamp,.avatar"` (paint over dynamic regions), `--hide` (visibility:hidden),
`--wait-for <selector|networkidle|ms>`, `--settle <ms>` (JS time after load, default 2000),
`--color-scheme dark`, `--fail-on-change` (exit 2, for CI).

Output per page × width: `base.png`, `head.png`, `diff.png`, `compare.png` (base | head |
diff, labelled), `focus.png` (close-ups of the changed regions, base vs head at up to 2x),
plus `summary.md` and `summary.json` (change %, moved %, regions with `kind`, shifts, size
changes, HTTP status, new console errors, stability, what was still loading).

Reading the diff: **red** = changed pixels (boxed), **blue wash** = rows that only moved
(row alignment recognises "everything below y moved down 70px", so a taller header is one
red region plus a blue band, not a page of red), **amber** = faint change below the
visible threshold (a colour-token tweak, or the edge of a pale element). Removed blocks are
marked with a dashed red bar where they used to be; added blocks are solid red.

Result per pair: `changed` (≥ 0.1% of pixels changed or moved, a size change, or one solid
cluster: ≥ 40 px², or ≥ 16 px² without a sub-pixel halo, e.g. one changed digit), `minor`
(scattered or faint differences only), `unchanged`, `error`. A 1-2px padding change usually
reads as "moved" (blue band from that element down, ±1px is tolerated as sub-pixel
jitter); `focus.png` puts an orange box where the move starts.

### 6. Look at the evidence (do not skip)

Read **every** `focus.png` and `compare.png` the script lists (changed and minor). The
close-up shows what changed; the compare shows where and what it pushed around. For each:

1. **Is it noise?** Third-party embeds, avatars, ads, data that differs between base and
   head, "kept changing" / "still loading" notes. Fix with `--mask`, `--hide`, `--settle`
   or `--wait-for` and re-run. See `references/stabilization.md`. Don't report noise as a change.
2. **Describe it in plain words**: "Primary button is now a pink gradient pill",
   "Hero CTA wraps to two lines at 375px". Explain cascades with `shifts` in summary.json
   ("content from y≈360 moved down 70px") instead of listing every moved element; the red
   region just above the blue band is usually the cause. Name faint (amber) changes too;
   the note gives the dominant colour pair: "date text colour #6b7280 → #64748b".
3. **Intended or not?** Compare against the PR's purpose and `git diff`. Anything the
   PR didn't set out to change (other pages affected by shared CSS, overflow at mobile
   widths, missing styles, a page that now 404s or throws new console errors) is a
   **possible regression**. Open `base.png`/`head.png` at full size if the compare is too
   small to judge.

If you find regressions, tell the user first, before writing PR text, and offer to fix
them. After a fix, re-run step 5 for the affected pages and look again.

### 7. Write the PR section

Write `.knack/pr-visual-diff/pr-section.md` from `summary.md`:

```markdown
<!-- pr-visual-diff:start -->
## Visual changes
<one-sentence summary>

**Intended**
- `/` (all widths): primary CTA restyled as a gradient pill; copy now "Start your free trial".

**Please check** (possibly unintended)
- `/pricing` (375 & 1280): plan buttons no longer stretch full width. Cause: `.card .btn` rule removed in `styles.css`.

<the summary.md table and images>
<!-- pr-visual-diff:end -->
```

Show it to the user. Images are relative paths until hosted; pick a hosting option with
the user (details and trade-offs: `references/pr-images.md`):

- **Drag and drop (default, works for private repos):** the user drags the focus/compare
  PNGs into the PR description on github.com, which uploads them. Open the folder for them
  (`open .knack/pr-visual-diff/pages` on macOS).
- **gh attachments (gh 2.99+, push access):** `gh pr comment|edit --attach` uploads local
  images and rewrites matching references. Print the command, show it, run after a yes:
  ```bash
  node "${CLAUDE_SKILL_DIR}/scripts/publish-assets.mjs" --gh-attach <pr-number>
  ```
- **Assets branch (any gh version):** pushes images to an orphan branch and rewrites links.
  Dry run first, push only after a clear yes:
  ```bash
  node "${CLAUDE_SKILL_DIR}/scripts/publish-assets.mjs" --prefix pr-123          # plan only
  node "${CLAUDE_SKILL_DIR}/scripts/publish-assets.mjs" --prefix pr-123 --push   # → summary.pr.md
  ```
  Then rebuild `pr-section.md` with the absolute URLs from `summary.pr.md`.
- The REST/GraphQL APIs have no image upload, and `gh gist create` rejects binary files.
  Don't promise either.

Updating the PR (only when asked): fetch the body with `gh pr view <n> --json body -q .body`,
replace the block between the `pr-visual-diff` markers (or append it), write it to a file,
and run `gh pr edit <n> --body-file <file>`. Or post it with `gh pr comment <n> --body-file <file>`.
Never commit screenshots to the PR branch.

### 8. Clean up

```bash
node "${CLAUDE_SKILL_DIR}/scripts/worktree-serve.mjs" stop --all   # kills servers it started, removes worktrees
```

Suggest adding `.knack/` to `.gitignore` if it isn't there yet.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Every pixel differs | Different data on each side (dev DB vs seed), or a font failed to load. Compare `base.png`/`head.png`; mask data regions or point both at the same backend. |
| "page kept changing" | Canvas/WebGL, live data, third-party widget. `--mask` / `--hide` it. |
| "still loading after 8s" | Slow or broken images/fonts/video; check `base.png`/`head.png` for gaps. |
| Content missing on both sides | It waits on a timer longer than the 2 s JS budget: `--settle 5000` or `--wait-for <selector>`. |
| HTTP 404 on both sides | Wrong path. Check routes with `affected-pages.mjs --all`. |
| Base won't start | Read the log tail it prints. Usually env vars (`--copy-env`), a monorepo (`--dir`), or a compound dev script (`--cmd`). |
| Login wall in screenshots | `--storage-state` (step 4). |
| Change at one width only | Breakpoint issue. Often a real regression; add 768 to confirm. |

## References

- `references/stabilization.md`: flake sources and fixes, when to mask vs freeze.
- `references/frameworks.md`: dev-server port flags and file-to-route rules per framework.
- `references/pr-images.md`: image hosting options for PR descriptions, honestly compared.
