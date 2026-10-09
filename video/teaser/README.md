# $ODDIE teaser

20 seconds, 1920x1080, 30 fps, with sound. `oddie-teaser.mp4` is the render.

    node video/teaser/render.mjs        # -> video/teaser/oddie-teaser.mp4

- `teaser.html`: the whole film. Every frame is `render(t)`, so a render is
  deterministic. Opened in a browser it plays on a loop (preview).
- `build_audio.py`: the score, synthesized with numpy (no samples, no licences).
  Its beat grid is the `T` table in teaser.html; change one, change the other.

Beats: `!call` typed · Twitch / Kick / X / Telegram · a market glimpsed with
the question redacted · ANY CHAT. ANY CLAIM. ONE CALL. · the portal ·
POWERED BY $ODDIE · COMING SOON.
