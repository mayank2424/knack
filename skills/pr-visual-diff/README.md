# PR Visual Diff

> Before/after screenshots and pixel diffs for every frontend PR, so reviewers see what changed and catch what broke.

![PR Visual Diff: base, head and diff of a pricing page](assets/preview.png)

Code review is blind to how a frontend change *looks*. A one-line CSS edit can restyle
the button you meant to change and quietly break three pages you didn't. This skill lets
your agent show reviewers the difference: it screenshots the affected pages on the base
branch and on your branch, pixel-diffs them at mobile and desktop widths, looks at the
results, and writes a "Visual changes" section for the PR that separates what you meant
to change from what might be a regression.

## What it does

1. **Finds the pages to check.** Maps changed files to routes for Next.js (app and pages
   router), Remix / React Router, SvelteKit, Nuxt, Astro, plain HTML and React Router
   SPAs, following imports from changed components and stylesheets up to the pages that
   use them.
2. **Brings up the "before" build** in a temporary git worktree on its own port, with
   dependencies installed by your lockfile's package manager. Your working tree is never
   touched.
3. **Captures and diffs** each page × width with Playwright and pixelmatch, after
   stabilizing (animations off, fonts loaded, network idle, optional frozen clock and
   masks). Detects content shifts, size changes, new console errors and pages that start
   returning 404.
4. **Reviews the evidence.** The agent reads every compare image, describes the changes
   in plain words, and flags anything that looks unintended.
5. **Writes the PR section** with a table and side-by-side images. Pushing an assets
   branch or editing the PR only happens if you say yes.

## Try it

```text
add before/after screenshots to my PR
did my CSS refactor change anything visually?
visual diff this branch against main at 375, 768 and 1280
check /settings and /billing for visual regressions before I merge
```

## Requirements

- Node.js 18+ and git
- Chromium via Playwright (installed by `scripts/setup.sh`, ~150 MB once), or a local
  Chrome/Edge as fallback
- Your app's own toolchain (pnpm / yarn / npm / bun) to run the base build
- Optional: `gh` CLI if you want the agent to update the PR for you

```bash
bash scripts/setup.sh
```

## Run the example

`examples/` holds two versions of a tiny static site. The "after" version is a PR called
*Restyle hero CTA*: the hero button becomes a gradient pill (intended), but the same
stylesheet change drops the rule that made pricing-card buttons full width (unintended),
and the longer CTA pushes the secondary button onto a new line on mobile.

```bash
node scripts/capture.mjs --base examples/before --head examples/after \
  --pages /,/pricing,/about --full-page --freeze-time \
  --label-base main --label-head feat/hero-cta
```

Output in `./.knack/pr-visual-diff/`:

```
summary.md   summary.json
pages/home/375/{base,head,diff,compare}.png
pages/home/1280/...   pages/pricing/375/...   pages/pricing/1280/...   pages/about/...
```

`summary.md` starts like this:

| Page | Width | Result | Pixels changed | Notes |
|---|---:|---|---:|---|
| `/` | 375px | **changed** | 9.04% | size 375×969 → 375×1039; 3 regions; content below y≈360px shifted down 70px |
| `/` | 1280px | **changed** | 1.84% | 6 regions; content below y≈328px shifted down 7px |
| `/pricing` | 375px | **changed** | 6.29% | size 375×1249 → 375×1271; 4 regions; content below y≈520px shifted down 7px |
| `/pricing` | 1280px | **changed** | 1.43% | 5 regions |
| `/about` | 375px | unchanged | 0% |  |
| `/about` | 1280px | unchanged | 0% |  |

…followed by one `compare.png` per changed pair (base | head | diff, changed regions
boxed). Numbers vary slightly by OS font rendering.

## Scripts

| Script | Purpose |
|---|---|
| `affected-pages.mjs` | Changed files → candidate routes with confidence and reasons |
| `worktree-serve.mjs` | `start` base in a temp worktree, `serve` head, `list`, `stop --all` |
| `capture.mjs` | Screenshots, diffs, compare images, `summary.md` / `summary.json` |
| `publish-assets.mjs` | Optional: host images on an orphan branch (dry run unless `--push`) |

All support `--help`.

## Limitations

- Base and head must render the same data. If they talk to different databases, diffs
  show data, not UI. Mask data regions or point both at the same backend.
- Logged-in pages need a Playwright storage-state file that you create by logging in
  yourself (`npx playwright codegen --save-storage=auth.json <url>`).
- Route detection is heuristic. Config-based routers and workspace packages need you
  (or the agent) to pick pages by hand; dynamic routes need real parameter values.
- GitHub has no API to upload images into PR descriptions. Options are drag and drop
  (works everywhere), an assets branch (scriptable, visible to everyone with repo access),
  or your existing CI artifact hosting. See `references/pr-images.md`.
- Chromium only. Safari/Firefox rendering differences are out of scope.
