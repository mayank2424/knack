# Motion Video

> Storyboard → code → rendered MP4. Your agent becomes a motion designer that checks its own frames.

![Templates rendered by this skill](assets/preview.png)

**Motion Video** turns a one-line brief into a polished launch video, logo sting, kinetic-type piece, data story, app showcase or vertical social clip.

You get a real MP4, GIF, WebM or transparent MOV. The renderer is frame-accurate: Playwright captures every frame and ffmpeg encodes them. The animation is plain HTML and CSS on a tiny deterministic timeline, so anyone can edit it.

The skill pins **Claude Opus** with `model: opus` and `effort: high`. Opus currently means Opus 5.5, the strongest model for taste-heavy, multi-step creative work.

## Why it's different

| | Motion Video | Prompting an agent to "make a video" |
|---|---|---|
| Plans first | Writes a beat-sheet storyboard (timing, motion, purpose) and asks for a 👍 | Jumps straight to code |
| Sees its output | Renders **filmstrips** and stills, reads them, fixes problems | Can't watch video, so ships blind |
| Lints itself | `--check` flags off-frame text, overlapping text, tiny type, unloaded fonts, cut-off animations, empty poster frames | Not available |
| Craft built in | Timing tables, easing vocabulary, choreography rules, platform safe zones | Generic tweens |
| Zero lock-in | One HTML file plus a ~20 KB MIT runtime, no framework or license fees | Not applicable |

## Example prompts

- "Make a 12-second launch video for our v2 release. Use the colors from our Tailwind config."
- "Create a 4-second logo sting from `public/logo.svg` at 60fps."
- "Turn these three stats into an animated data story for LinkedIn (4:5)."
- "Make a vertical Reel with 3 CSS tips, safe zones respected."
- "Animate this screenshot with a camera push onto the analytics panel, and export a GIF for the README."
- "Render a transparent lower-third with my name for a YouTube video."

## What happens

1. **Brief.** It infers platform, length and brand from your repo, and asks at most 3 questions.
2. **Storyboard.** It writes `storyboard.md` with beats, timings and the reason each beat exists.
3. **Build.** It scaffolds from one of 6 templates into `videos/<slug>/index.html`. Open the file to scrub through it live.
4. **Self-review.** It runs `--check` and reads the `--filmstrip` contact sheet, fixing collisions, legibility and pacing.
5. **Render.** It produces an MP4 (H.264), GIF, WebM, ProRes 4444 with alpha, or a PNG sequence, with optional music muxing and film-style motion blur. Colors are converted and tagged as BT.709, so brand colors match the browser (measured mean ΔE2000 ≈ 0.2 in Chrome).

## Templates

| Template | Size | Length |
|---|---|---|
| `kinetic-type` | 16:9 | 10s |
| `product-launch` | 16:9 | 13s |
| `logo-sting` | 16:9, 60fps | 4s |
| `data-story` | 16:9 | 10s |
| `app-showcase` | 16:9, 60fps | 10s |
| `social-vertical` | 9:16 | 12s |

`examples/knack-promo/` holds the composition behind the Knack website's hero video, so you can see a complete real-world piece.

## Requirements

- Node 18+
- ffmpeg (`brew install ffmpeg` on macOS, `apt install ffmpeg` on Ubuntu)
- Playwright and Chromium, which `scripts/setup.sh` installs on first use

## Use the renderer directly

```bash
bash scripts/setup.sh
node scripts/new.mjs kinetic-type my-video
open my-video/index.html                              # live preview with scrubber
node scripts/render.mjs my-video/index.html --filmstrip
node scripts/render.mjs my-video/index.html           # → my-video/index.mp4
```

See [`references/runtime-api.md`](references/runtime-api.md) for the full API.

## License

MIT
