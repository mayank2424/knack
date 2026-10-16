# Formats, platforms and safe zones

| Platform / use | Size | Aspect | Length sweet spot | Notes |
|---|---|---|---|---|
| YouTube / website hero | 1920×1080 | 16:9 | 15–60s | Use `--fps 30`. Make a 4K variant with `--scale 2`. |
| X (Twitter) feed | 1920×1080 or 1080×1080 | 16:9 / 1:1 | 6–20s | Autoplays muted, so captions or on-screen text are mandatory. |
| LinkedIn feed | 1080×1350 or 1080×1080 | 4:5 / 1:1 | 10–30s | 4:5 takes up the most feed space. |
| Instagram Reels / TikTok / YouTube Shorts | 1080×1920 | 9:16 | 7–15s (≤ 60s) | Hook in under 1s. Respect the UI zones below. |
| Instagram feed | 1080×1350 | 4:5 | 6–15s | |
| Product Hunt / landing page loop | 1600×1000 or 1920×1080 | 16:10 / 16:9 | 8–20s, seamless loop | Make the last frame match the first. |
| README / PR / docs | 1280×720 GIF or MP4 | 16:9 | 3–10s | GIF ≤ 10 MB. GitHub also plays `.mp4` uploads. |
| Logo sting / bumper | 1920×1080 | 16:9 | 3–5s | Use 60fps and `--motion-blur 8` for crisp, filmic motion. |
| Overlay / lower third | 1920×1080 transparent | 16:9 | 3–6s | Render `.mov` (ProRes 4444) or `.webm --transparent`. |
| Presentation background | 1920×1080 | 16:9 | 10–30s loop | Subtle motion only. |

## Safe zones

- **Universal.** Keep all text inside a 4% margin (77px at 1080p). Keep critical text inside about 10% (title-safe).
- **9:16 platform UI.** At 1080×1920, avoid:
  - the top 220px (status bar, account name)
  - the bottom 420px (captions, buttons, music ticker)
  - the right 140px (like, comment and share column)

  The `social-vertical` template's `.safe` box encodes this.
- **1:1 and 4:5 feeds.** The platform may crop to the center in previews, so keep the hero within the center 80%.

## Frame rates

- **24fps.** Cinematic. Suits slow, elegant pieces.
- **30fps.** The default for social and web.
- **60fps.** Use for fast UI motion, camera pans, stings, and anything with quick horizontal movement, which judders at 30. Rendering takes twice as long.
- **Motion blur instead.** At 30fps, `--motion-blur 8` smooths fast motion the way film does. It costs 8× the capture time, so use it on short pieces or final renders only.

## Color, banding and encoding (measured)

Chromium captures frames in sRGB. The renderer converts them with the BT.709 matrix into limited range and tags primaries, transfer and matrix. Measured on 16 brand-color patches (mean / max ΔE2000 against the PNG still):

| Pipeline | Chrome | QuickTime / Safari (AVFoundation) |
|---|---|---|
| Old: untagged, ffmpeg default BT.601 matrix | 2.34 / 8.63 (cyan, green and orange visibly shifted) | 3.31 / 7.68 |
| Default: BT.709 matrix + tags | 0.21 / 0.83 | 1.52 / 4.01 (Apple's BT.709 gamma lifts midtones) |
| `--trc srgb` | 0.21 / 0.83 | 0.32 / 0.94 |

- ΔE < 1 is imperceptible. `--trc srgb` is the most accurate for files watched directly (web pages, README, Mac/iOS). The default BT.709 tag is the conservative choice for uploads that platforms re-encode.
- **Banding.** Chromium paints CSS gradients in 8 bits, so wide dark glows step slightly even before encoding. `--dither` adds a static ±1-level dither (bands disappear; file grows ~2× on gradient-heavy shots). `--10bit` (HEVC Main10) was smoothest and smallest in testing, but Firefox on macOS/Linux and old players can't play it. Composition grain (3–6% opacity) also hides bands.
- **Motion blur.** `--motion-blur N` renders N sub-frames spread over a 180° shutter (`--shutter`) and averages them. Render time scales by N. 8 is a good default, 12–16 for whip pans.
- **4K.** `--scale 2` renders at device-pixel-ratio 2, so text and SVG are re-rasterized sharp rather than upscaled.

## GIF

GIFs are captured directly at `--gif-fps` (20) and `--gif-width` (≤ 960), which is faster than downscaling a full render. One palette is built from the whole clip and frames are dithered with sierra2_4a. Measured on 12s 960px clips:

| Clip | Old renderer | Now | `--gifski` |
|---|---|---|---|
| product-launch (dark UI) | 6.58 MB, 22s | 6.22 MB, 10s, higher SSIM | 2.90 MB (faint ghosting on moving glows) |
| kinetic-type (with grain) | 29.7 MB | 0.41 MB (grain hidden via `.knack-out-gif`) | – |

Per-frame noise (grain, particles) is the main GIF size killer. Hide it with `.knack-out-gif`.

## File size guide (H.264, CRF 18, 1080p)

- Simple typography is about 0.2–0.4 MB/s. Gradients and grain run about 1–3 MB/s.
- Reduce size with `--crf 23` (visually lossless for most motion graphics) or `--scale 0.667` (720p).
- For GIFs, lower `--gif-fps 15` and `--gif-width 720`. Flat colors compress best; avoid grain in GIFs.
