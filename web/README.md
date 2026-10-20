# VANTA Motion Studio

VANTA's AI path in this branch is **VANTA Motion Core**.

It uses the existing local XZAKUT Wan training stack and trained motion LoRA. It does not use paid xAI/Grok generation and it does not contain an LTX fallback.

See [LOCAL-NO-CREDITS.md](LOCAL-NO-CREDITS.md) for exact local paths and current limitations.

## Modes

**VANTA Motion Core**
- prompt-driven AI video
- Wan 2.1 T2V 1.3B base
- XZAKUT trained motion LoRA
- local GPU inference
- optional local Auto Sound post-pass
- 1080p upscale after generation

**Camera sequence**
- 1–6 still images
- pan / zoom animation
- FFmpeg export
- no generated subject motion

## Reference roadmap

The installed trained core is T2V, so reference images are intentionally disabled rather than routed through another model.

VANTA Reference Core will be trained as our own reference-conditioning adapter on top of the same motion backbone.

## Local API

- `GET /api/health`
- `GET /api/capabilities`
- `POST /api/videos engine=ai aiBackend=vanta-motion`
- `POST /api/videos engine=camera`
- `GET /api/videos/:id`
- `GET /api/videos/:id/file`
- `DELETE /api/videos/:id`

Run `START-VANTA.cmd` from this folder.
