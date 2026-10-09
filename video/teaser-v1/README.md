# $ODDIE teaser, first cut

20 seconds, 1920x1080, 30 fps, with sound: `!oddie` typed, the four platforms, a
redacted market, ANY CHAT. ANY CLAIM. ONE CALL., the portal (THE CROWD DECIDES),
POWERED BY $ODDIE, COMING SOON. The later cuts live in `video/teaser`.

    node video/teaser-v1/render.mjs      # -> video/teaser-v1/oddie-teaser-v1.mp4 (about 2 minutes)

- `teaser.html`: the film as DOM; every frame is `render(t)`. Opens straight from disk.
  The beat table is `T`; `build_audio.py` hard-codes the same times, so change both.
- `build_audio.py`: the score, synthesized with numpy.
- `upscale.py`: made `brand/oddieupscale-2x.webp`, the portal this cut pushes into.
  Real-ESRGAN's compact general model run in plain numpy (no torch):

      curl -LO https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth
      python3 video/teaser-v1/upscale.py brand/oddieupscale.png brand/oddieupscale-2x.webp --weights realesr-general-x4v3.pth --scale 2

The MP4 is build output and stays out of git.
