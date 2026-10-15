# Getting images into a PR description

`summary.md` links images by relative path (`pages/home/375/compare.png`). Those paths
mean nothing to GitHub, so before the markdown goes into a PR the images need a URL.
There is no perfect option; here is what actually works.

## What doesn't work

- **GitHub API image upload.** The REST and GraphQL APIs have no endpoint for the
  attachments you get when you paste an image into a comment. That upload flow is
  browser-only.
- **`gh gist create image.png`.** The gh CLI refuses binary files ("binary file not
  supported"). Cloning the gist's git repo and pushing PNGs does work, but secret gists
  are unlisted, not private: anyone with the link can see them. Not recommended.
- **Committing screenshots to the PR branch.** It pollutes the diff reviewers are trying
  to read and lands binaries in main on merge. Don't.

## Option A: drag and drop (default)

The user drags the `compare.png` files into the PR description or a comment on
github.com. GitHub uploads them and inserts `<img>` / `![...]()` tags.

- Works for private repos; images inherit the repo's visibility.
- Needs a human for ~30 seconds. Make it easy: open the folder (`open .knack/pr-visual-diff/pages`
  on macOS, `xdg-open` on Linux, `explorer` on Windows) and give them the markdown with
  the image lines marked "drop compare.png for /pricing @ 375 here".
- Only upload `compare.png` for changed/minor pairs unless reviewers want more.

## Option B: assets branch (scriptable)

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

## Option C: CI artifacts or external hosting

If the team already runs visual tests in CI (Chromatic, Percy, Playwright reports
uploaded as artifacts, an S3 bucket), link there instead. Only use external hosts the
user names. Never upload screenshots of private apps to a public image host on your own
initiative.

## Updating the PR

Only after the user says yes:

```bash
gh pr view 123 --json body -q .body > /tmp/body.md
# replace the block between <!-- pr-visual-diff:start --> and <!-- pr-visual-diff:end -->,
# or append pr-section.md if the markers aren't there
gh pr edit 123 --body-file /tmp/body.md
# or, to leave the description alone:
gh pr comment 123 --body-file .knack/pr-visual-diff/pr-section.md
```

The markers make re-runs idempotent: replace the block instead of appending a second one.
