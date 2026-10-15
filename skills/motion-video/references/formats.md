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
| Logo sting / bumper | 1920×1080 | 16:9 | 3–5s | Use 60fps for crisp motion. |
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
- **60fps.** Use for fast UI motion, stings, and anything with quick horizontal movement, which judders at 30. Rendering takes twice as long.

## File size guide (H.264, CRF 18, 1080p)

- Simple typography is about 0.2–0.4 MB/s. Gradients and grain run about 1–3 MB/s.
- Reduce size with `--crf 23` (visually lossless for most motion graphics) or `--scale 0.667` (720p).
- For GIFs, lower `--gif-fps 15` and `--gif-width 720`. Flat colors compress best; avoid grain in GIFs.
