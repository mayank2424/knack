# Skill examples: spec

Every skill ships **2–4 worked examples**. Each one is a realistic scenario with a real input and the skill's **real output**: produced by running the skill's own scripts, never mocked up or hand-drawn. The website renders them on each skill's page.

## Files

```
skills/<name>/examples/
├── examples.json          # manifest (schema below)
├── <fixture files>        # inputs: pages, flows, mini projects (existing ones can be reused)
└── output/<example-id>/   # committed outputs shown on the site
```

## examples.json

```json
{
  "examples": [
    {
      "id": "landing-page",
      "title": "A landing page that scrolls sideways on phones",
      "prompt": "Check the landing page on mobile and fix what breaks.",
      "summary": "One or two sentences: the situation, what the skill found or made, and the outcome.",
      "input": ["broken-page.html"],
      "command": "node scripts/sweep.mjs examples/broken-page.html --full-page",
      "result": "12 errors at 375px → 0 after fixes",
      "media": [
        { "type": "image", "src": "output/landing-page/contact-sheet.png", "alt": "…", "caption": "…" }
      ],
      "excerpt": "Optional: up to 12 lines of real terminal output, copied verbatim (ANSI colors stripped, local paths replaced)."
    }
  ]
}
```

Field notes:
- `id` is kebab-case and unique within the skill. It's also the output folder name.
- `prompt` is what a user would type to their agent.
- `input` paths and `media[].src` are relative to `examples/`.
- `command` paths are relative to the skill folder.
- `media[].type` is `image`, `video` (MP4) or `gif`. Give 1–3 items per example, most important first.

## Rules

- **Real output only.** Generate everything with the skill's scripts. Re-run them if a fixture changes.
- **No local paths or personal data** in images, text or excerpts. Crop out headers that print `file:///Users/...`, and write paths as `examples/...`.
- **Size budget per file:**
  - images: ≤ 1600px wide and ≤ 500 KB (crop to the interesting region)
  - MP4: ≤ 4 MB
  - GIF: ≤ 3 MB
  - media referenced by `examples.json`: ≤ 8 MB per skill (≤ 16 MB for skills whose examples are videos, such as motion-video)
- **Variety.** The examples should show different situations and different features of the skill, not the same thing three times.
- **Fixtures** are small, realistic and self-contained (no network calls except Google Fonts). Use fictional brands; never imitate a real company's site. The exception is a product the skill's author owns and asked to feature (the motion-video launch films), using its real assets.
- Keep `node tools/validate.mjs` passing (run it from the repo root).
- Update the skill's README with a short "Examples" section that links the folder.
