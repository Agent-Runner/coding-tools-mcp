# Promo video (Remotion)

Promotional videos for Coding Tools MCP, defined entirely in code.

```bash
npm install
npm run studio        # live preview + timeline editor
npm run render        # product overview → out/coding-tools-mcp-promo.mp4
npm run render:030    # 0.3.0 English → out/coding-tools-mcp-0.3.0.mp4
npm run render:030zh  # 0.3.0 中文   → out/coding-tools-mcp-0.3.0-zh.mp4
```

All compositions are 1920×1080 at 30 fps. Rendered files are not committed;
published copies are attached to GitHub Release assets.

## Compositions

| id | File | Length | Notes |
| --- | --- | --- | --- |
| `Promo` | `src/Promo.tsx` | 45s (1350 frames) | Product overview |
| `Release030` | `src/Release030.tsx` | 48s (1440 frames) | 0.3.0 highlights, English |
| `Release030Zh` | `src/Release030.tsx` | 48s (1440 frames) | Same cut, 简体中文 |

0.3.0 scene map (frames @ 30 fps): title 0–120 · protocol 120–360 ·
stateless HTTP 360–570 · commands survive 570–810 · concurrent patches
810–1020 · errors + output head 1020–1230 · CTA 1230–1440.

Launch copy (GitHub Release, Twitter, 即刻, 小红书, HN) lives in
[`docs/release-0.3-promo.md`](../docs/release-0.3-promo.md).
