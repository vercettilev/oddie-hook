# $ODDIE teaser

30 seconds, 1920x1080, 30 fps, with its own score. Built from code, so any line, colour or
beat can change and the film re-renders.

    pip install numpy scipy
    node video/teaser/render.mjs            # -> video/teaser/oddie-teaser.mp4 (a few minutes)
    node video/teaser/render.mjs --stills 16.1,20.3 --out /tmp/stills    # quick PNG checks

The MP4 and `score.wav` are build output and stay out of git, like the deck PDF.

- `timeline.json`: the beat grid (150 BPM, one beat = 0.4 s). Every cut and every hit is a
  beat number here; picture and score both read it, so they cannot drift apart.
- `teaser.html`: the picture, one canvas, `render(t)` per frame. Open it through any static
  server at the repo root (`npx serve`, then `/video/teaser/teaser.html`) to preview it in
  real time with the score. It needs http, not file://: the ghost is keyed off the logo tile.
- `build_audio.py`: the score, synthesized with numpy/scipy (no samples, nothing to license).
- `render.mjs`: serves the repo locally, renders frames on parallel Playwright pages, muxes.

| beats | bars | |
|---|---|---|
| 0-16 | intro | typed lines over a dim chat wall, subliminal platform flashes, UNTIL NOW. |
| 16-20 | build | Twitch, Kick, X, Telegram, one logo per kick, each with its real door (`!oddie`, `@oddiefun`, `@oddiefunbot`) |
| 20-24 | | the chat wall; one `!oddie` pulls out of it |
| 24-28 | | a market glimpsed: the question redacted, the odds running to 73% |
| 28-32 | | ANY STREAM. ANY CHAT. ANY TAKE. ONE CALL. |
| 32-40 | rise | the portal, LOADING, THE NEXT BIG CALL, a beat of silence |
| 40-48 | drop | the ghost and $ODDIE, platforms ribbon |
| 48-56 | | eight stickers, one per beat |
| 56-64 | | ONE CALL. on every platform, PREDICT. DON'T ARGUE., the $ODDIE strobe |
| 64-76 | outro | POWERED BY $ODDIE, COMING SOON, oddie.fun |
