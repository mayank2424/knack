# Frameworks: dev-server ports and route mapping

## Starting a dev server on a chosen port

`worktree-serve.mjs` always exports `PORT=<port>` and `BROWSER=none`, then appends the
framework's port flag to the package.json script (`dev`, else `start`, `serve`, `preview`,
`develop`). If detection fails, start it yourself with the commands below, or pass
`--cmd "<command with {port}>"`.

| Framework (detected by) | Flag appended | Manual command |
|---|---|---|
| Next.js (`next`) | `--port P` | `next dev --port 4100` |
| Vite (`vite`), SvelteKit (`@sveltejs/kit`), Remix Vite, React Router v7 (`@react-router/dev`) | `--port P --strictPort` | `vite --port 4100 --strictPort` |
| Nuxt (`nuxi`/`nuxt`) | `--port P` | `nuxi dev --port 4100` |
| Astro (`astro`) | `--port P` | `astro dev --port 4100` |
| Angular (`ng serve`) | `--port P` | `ng serve --port 4100` |
| Gatsby (`gatsby develop`) | `--port P` | `gatsby develop --port 4100` |
| Docusaurus | `--port P --no-open` | `docusaurus start --port 4100 --no-open` |
| Eleventy | `--port=P` | `eleventy --serve --port=4100` |
| Parcel | `--port P` | `parcel index.html --port 4100` |
| webpack-dev-server | `--port P` | `webpack serve --port 4100` |
| Create React App (`react-scripts start`) | none, reads `PORT` | `PORT=4100 BROWSER=none react-scripts start` |
| Remix classic (`remix dev`) | none, reads `PORT` | `PORT=4100 remix dev` |
| Express/Fastify/custom Node | none, reads `PORT` if the app does | check `server.js` for `process.env.PORT` |
| Static folder (no package.json) | built-in static server | `python3 -m http.server 4100` also works |

### Forwarding flags through package managers

| PM | Form used |
|---|---|
| npm | `npm run dev -- --port 4100` (the `--` is required) |
| pnpm | `pnpm run dev --port 4100` |
| yarn | `yarn run dev --port 4100` |
| bun | `bun run dev --port 4100` |

### Scripts that won't take a flag

Compound scripts (`a && b`, `concurrently`, `npm-run-all`, `turbo dev`, `nx serve`) get
only `PORT`. In monorepos point at the app instead: `--dir apps/web`. With Turborepo you
can also run `--cmd "pnpm --filter web dev --port {port}"`.

### Gotchas

- **Two Next.js servers in one folder conflict** (`.next` lock). The base runs in its
  own worktree, so that's fine; just don't `serve` head while the user's `next dev` runs
  in the same folder. Reuse theirs.
- **Next.js dev vs production**: dev mode compiles each page on first request (slow
  first capture) and shows a dev indicator (hidden by capture.mjs). For exact parity
  run `next build && next start -p {port}` on both sides via `--cmd`.
- **Port ignored**: some setups hard-code ports. The script reads the real URL from the
  server log ("Local: http://localhost:5174") and warns.
- **Env vars**: worktrees don't have untracked `.env*` files. `--copy-env` copies them.
- **Install cost**: a fresh worktree needs its own `node_modules`. If the lockfile is
  unchanged since base, `--link-node-modules` symlinks the user's instead. Caveat: tools
  that cache inside `node_modules` (Vite's `.vite`) then share that cache.

## How affected-pages.mjs maps files to routes

Route files changed directly → **high**. Components/styles imported by a route within 2
hops → **high**, deeper → **medium**. Layout files → every route below them, **medium**.
Root layouts and global styles/config → "global change", representative routes as
**medium/low**.

| Framework | Route files | Layout / global files |
|---|---|---|
| Next.js app router | `app/**/page.(tsx\|jsx\|ts\|js\|mdx)` (also `src/app`). `(group)` and `@slot` segments dropped; `(.)` intercepting routes skipped. | `layout`, `template`, `loading`, `error`, `not-found` → routes in that folder; root `app/layout` → global |
| Next.js pages router | `pages/**/*.(tsx\|jsx\|ts\|js\|mdx)`, `index` → parent, `api/` skipped | `_app`, `_document` → global |
| Remix / React Router (file routes) | `app/routes/<name>.tsx` or `app/routes/<name>/route.tsx`. `.` → `/`, `_index` → index, leading `_` pathless, trailing `_` dropped, `$id` → `:id`, `$` → `*` | `app/root.tsx` → global; `dashboard.tsx` is also the layout for `dashboard.*` |
| SvelteKit | `src/routes/**/+page(.server).(svelte\|ts\|js)`, `(group)` dropped | `+layout*` → routes in that folder; root layout, `src/app.html` → global |
| Nuxt | `pages/**/*.vue` (or `app/pages` in Nuxt 4), `index` → parent | `app.vue`, `error.vue`, `layouts/*` → global |
| Astro | `src/pages/**/*.(astro\|md\|mdx\|html)` | layouts traced through imports |
| Plain HTML | any `*.html` → `/<path>.html`, `index.html` → `/` (or folder) | CSS/JS traced through `<link href>` / `<script src>` |
| React Router / Vue Router SPA | `<Route path="/x" element={<X/>}>` and `{ path: '/x', element/component: X }` in code | changed component → route whose element imports it (**medium**) |

Import tracing understands relative imports, `tsconfig`/`jsconfig` `paths`, and the
common aliases `@/`, `~/`, `$lib`. Bare package imports are ignored, so a change inside
a workspace package shows up as "outside app"; re-run with `--dir` for the consuming app
or pick pages by hand.

Known limits: config-based routers (React Router `routes.ts`, Angular route modules,
TanStack file routes) are only partly detected; CSS-in-JS theme files are found only
through imports; dynamic routes always need a concrete value from you.
