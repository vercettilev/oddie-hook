# $ODDIE launch teaser

30 seconds, 1920x1080, 30 fps, with its own score: a cyberpunk vibe cut, not a feature
list. Built from code, so any line, colour or beat can change and the film re-renders.

    pip install numpy scipy
    node video/teaser/render.mjs            # -> video/teaser/oddie-teaser.mp4 (a few minutes)
    node video/teaser/render.mjs --stills 16.1,20.3 --out /tmp/stills    # quick PNG checks

The MP4 and `score.wav` are build output and stay out of git, like the deck PDF.

- `timeline.json`: the beat grid (150 BPM, one beat = 0.4 s). Every cut and every hit is a
  beat number here; picture and score both read it, so they cannot drift apart. The neon
  flicker intervals are here too: the same pattern lights each sign and gates its buzz.
- `teaser.html`: the picture, one canvas, `render(t)` per frame. Open it through any static
  server at the repo root (`npx serve`, then `/video/teaser/teaser.html`) to preview it in
  real time with the score. It needs http, not file://: the ghost is keyed off the logo tile.
  The skyline is procedural (seeded, so every render is the same city).
- `build_audio.py`: the score, synthesized with numpy/scipy (no samples, nothing to license):
  rain and a heartbeat, darksynth in the streets, a phonk drop (808s, the cowbell hook).
- `render.mjs`: serves the repo locally, renders frames on parallel Playwright pages, muxes.

| beats | bars | |
|---|---|---|
| 0-8 | city | rain on a neon skyline, the ghost as a hologram. "watched everything. said nothing." |
| 8-16 | oracle | the oracle wakes in digital rain, the four platforms streaming in. UNTIL NOW. |
| 16-32 | streets | four archetypes on holo cards, each with its own brag line from the Genesis cards |
| 32-40 | boss | lights out, the cigar boss, smoke. "relax." "the next big call is..." a beat of nothing |
| 40-48 | drop | the $ODDIE sign ignites over the city, then the ghost |
| 48-56 | pump | eight stickers, one per beat |
| 56-64 | roster | WHAT'S YOURS? nine cards spin and lock on the boss, the $ODDIE strobe |
| 64-76 | outro | POWERED BY $ODDIE, COMING SOON in neon, oddie.fun |

Art: `public/brand/mascot-curtain.webp` (the boss; the ember sits at pixel 683,823),
`brand/v3-stickers/oracle.png`, the archetype sources in `brand/v3/kaynak-*.png`, and the
stickers in `public/brand` and `brand/v3`.
