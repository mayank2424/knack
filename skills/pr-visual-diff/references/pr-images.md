# Getting images into a PR description

`summary.md` links images by relative path (`pages/home/375/focus.png`,
`pages/home/375/compare.png`). Those paths mean nothing to GitHub, so before the markdown
goes into a PR the images need a URL. Here is what actually works.

## What doesn't work

- **The REST/GraphQL APIs.** They still have no endpoint for comment attachments. Use the
  gh CLI's `--attach` (Option B), which handles the upload for you.
- **`gh gist create image.png`.** The gh CLI refuses binary files ("binary file not
  supported"). Cloning the gist's git repo and pushing PNGs does work, but secret gists
  are unlisted, not private: anyone with the link can see them. Not recommended.
- **Committing screenshots to the PR branch.** It pollutes the diff reviewers are trying
  to read and lands binaries in main on merge. Don't.

## Which images to upload

Per changed pair `summary.md` embeds `focus.png` (close-ups of the changed regions, base vs
head, up to 2x) and `compare.png` (base | head | diff of the whole capture). GitHub shows
PR images at most ~880 px wide, so a 1280 px compare would shrink to a third; summary.md
then tucks compare.png into a `<details>` block and leaves the close-up visible. Upload
both; reviewers who want context open the details.

## Option A: drag and drop (default)

The user drags the `focus.png` / `compare.png` files into the PR description or a comment on
github.com. GitHub uploads them and inserts `<img>` / `![...]()` tags.

- Works for private repos; images inherit the repo's visibility.
- Needs a human for ~30 seconds. Make it easy: open the folder (`open .knack/pr-visual-diff/pages`
  on macOS, `xdg-open` on Linux, `explorer` on Windows) and give them the markdown with
  the image lines marked "drop pages/pricing/375/focus.png here".
- Upload `focus.png` and `compare.png` for changed/minor pairs unless reviewers want more.

## Option B: gh CLI attachments (scriptable, gh 2.99+)

Since gh 2.99 (September 2026), `gh pr comment`, `gh pr edit` and `gh pr create` take a
repeatable `--attach <file>` that uploads an image as a normal GitHub attachment. When the
body already references that same local path (`![alt](pages/home/375/focus.png)`), gh
replaces the reference with the uploaded URL in place.
([changelog](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments),
[docs](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli))

- Images inherit the repo's visibility, exactly like drag and drop. Best option for private repos.
- Needs push access to the repo, `gh auth login` (or a classic PAT), and github.com
  (GitHub Enterprise Server is not supported). 10 MB per image.
- `publish-assets.mjs --gh-attach <pr>` prints the exact command (it never runs it):
  ```bash
  node "${CLAUDE_SKILL_DIR}/scripts/publish-assets.mjs" --gh-attach 123            # comment from pr-section.md
  node "${CLAUDE_SKILL_DIR}/scripts/publish-assets.mjs" --gh-attach 123 --edit \
    --markdown .knack/pr-visual-diff/pr-body.md                                    # whole PR body
  ```
  It runs from the capture folder so the `--attach` paths match the references in the
  markdown, checks the gh version and the 10 MB limit, and lists what will be uploaded.
  Show the command to the user and run it only after a clear yes.
- `--edit` replaces the whole description: build `pr-body.md` first (current body with the
  `pr-visual-diff` block replaced, see "Updating the PR").
- Verified here: the command it prints. Not verified here: the upload itself (the test
  machine had gh 2.96). If gh reports an unmatched reference, fall back to Option A or C.

## Option C: assets branch

`publish-assets.mjs` commits the PNGs to an orphan branch (`pr-visual-diff-assets` by
default) using git plumbing. No checkout, no local branch, the working tree is untouched.
It pushes only with `--push`, appends to the existing branch so older PRs keep their
images, and writes `summary.pr.md` with URLs of the form:

```
https://github.com/<owner>/<repo>/raw/<commit-sha>/<prefix>/pages/home/375/compare.png
```

URLs are pinned to the commit, so later pushes never change an old PR.

Trade-offs to tell the user **before** pushing:

- It creates a branch in the shared repo that everyone with access sees. Some teams
  forbid extra branches or protect `*` patterns; the push will fail then.
- **Public repos:** images render for everyone.
- **Private repos:** the `github.com/.../raw/...` URL redirects to a short-lived signed
  `raw.githubusercontent.com` URL for signed-in users with access, so images usually
  render in the PR for teammates. They will not render in email notifications or for
  people without repo access. Preview the PR once to confirm.
- Repo size grows with every run. Clean up occasionally:
  `git push origin --delete pr-visual-diff-assets`.

## Option D: CI artifacts or external hosting

If the team already runs visual tests in CI (Chromatic, Percy, Playwright reports
uploaded as artifacts, an S3 bucket), link there instead. Only use external hosts the
user names. Never upload screenshots of private apps to a public image host on your own
initiative.

## Updating the PR

Only after the user says yes:

```bash
gh pr view 123 --json body -q .body > .knack/pr-visual-diff/pr-body.md
# replace the block between <!-- pr-visual-diff:start --> and <!-- pr-visual-diff:end -->,
# or append pr-section.md if the markers aren't there
gh pr edit 123 --body-file .knack/pr-visual-diff/pr-body.md     # images already hosted
# (with local image paths: use the publish-assets.mjs --gh-attach 123 --edit command instead)
# or, to leave the description alone:
gh pr comment 123 --body-file .knack/pr-visual-diff/pr-section.md
```

The markers make re-runs idempotent: replace the block instead of appending a second one.
