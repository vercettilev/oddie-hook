# Brand source files

Originals as delivered. Everything in public/ is generated FROM these, so
regenerate rather than editing an icon by hand.

- `oddiepink.png`   1254x1254, on #FCF604. **THE LOGO IN USE** since
                    2026-10-01, everywhere: favicons, PWA icons, the nav mark
                    (public/brand/mark.webp), the card/og mark, and the X
                    avatar. Lev chose the X yellow over the lime because it
                    reads livelier; the X header art is the same yellow family.
- `oddiepink-lime.png` 1254x1254. The 2026-08 recolour to the site lime
                    (#D7DC1F), in use until 2026-10-01. Kept for history; see
                    the recolour note below for how it was made.
- `oddielogo.png`   1254x1254. Same ghost, no pink shadow, on the older lime.
                    Kept as the flat alternative.
- `oddiebanner.png` 2196x716. Cinematic banner, "Turn arguments into markets."
- `oddieupscale.png` 1122x1402. THE PORTAL IN USE, shipped as public/portal.png.
                    Same dimensions as oddieimage but detail-enhanced: across
                    the band's visible slice, crushed-black pixels fall from 49%
                    to 38% and horizontal gradient energy rises 43%, which is
                    why the band no longer reads as a flat dark strip.
- `oddieupscale-2x.webp` 2244x2804. oddieupscale.png run through Real-ESRGAN
                    (realesr-general-x4v3) at 4x, resampled to 2x, WebP q92. Made by
                    video/teaser-v1/upscale.py for the teaser's push into the portal,
                    which went soft past 1:1. Edges and sparks come out sharper; the
                    darkest rock texture comes out a little flatter.
- `oddieimage.png`  1122x1402. The first pink pass, superseded by oddieupscale.
                    Same render as oddiegraphic with pink embers and pink rim
                    light added, which is what ties it to the rest of the brand.
- `oddiegraphic.png` 1122x1402. The same scene BEFORE the pink was added. This
                    is what the landing shipped until 2026-08-26.
- `oddie-ansemhack.png` 1200x630 with alpha. AnsemHack graphic.
- `v3/oddiepng3.png` 2172x724 with alpha. The crowd strip as delivered. Its
                    two bucket hats and the raised phone carried made-up marks.
- `v3/oddiepng3-realmark.png` 2172x724 with alpha. **THE CROWD IN USE** since
                    2026-10-02, shipped as public/brand/crowd-strip.webp
                    (1800x600, WebP q88). The same art with the real ghost: on
                    both hats as a print (the ghost keyed off oddiepink.png's
                    yellow, so its black outline sinks into the black cloth),
                    and on the phone as the app's yellow splash. Regenerate
                    the WebP from this file; bump `?v=` on the landing's img.

## Brand colour

Since 2026-10-01 the brand yellow is the logo's own yellow, everywhere:
`--yellow #FCF604`, `--yellow-hi #FFFB3B`, `--yellow-deep #676A00` (was the
lime `#D7DC1F` / `#E7EC4E` / `#5A6109`). The lime was only ever there so the
nav mark and the CTAs agreed; making the whole site the X yellow does the same
job and matches the avatar, the X header and the sticker art, whose yellow
(#F8F602) is within a few degrees of it. og-genesis.png and the raw
public/oddielogo.png were recoloured in place: hue 50-75 with HSV saturation
above 0.35 scaled per channel lime->yellow. Key on HSV saturation, not HLS:
in HLS the cream ticket paper reads as saturated and turns yellow too.

Regenerate every icon from the logo:

    SRC=brand/oddiepink.png
    names=(favicon-16.png favicon-32.png favicon-48.png apple-touch-icon.png icon-192.png icon-512.png logo-mark-96.png logo-mark-128.png logo-mark-256.png logo-icon.png)
    sizes=(16 32 48 180 192 512 96 128 256 512)
    for i in {1..${#names[@]}}; do sips -z ${sizes[$i]} ${sizes[$i]} "$SRC" --out "public/${names[$i]}"; done

favicon.ico is PNG-in-ICO built from the 16/32/48 PNGs; sips cannot write .ico.
public/brand/mark.webp (the nav mark on every page) is the same source at
320x320. Pillow writes both in one pass:

    from PIL import Image
    src = Image.open("brand/oddiepink.png").convert("RGBA")
    src.resize((48, 48), Image.LANCZOS).save("public/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    src.resize((320, 320), Image.LANCZOS).save("public/brand/mark.webp", quality=90, method=6)

After regenerating, bump the `?v=` on every favicon / mark.webp reference
(`grep -rn '?v=' public src`): static files are served with a 7-day max-age,
so without it returning visitors keep the old mark for a week.

No hand-embedded copy is left (feed.html, which inlined one as base64, is
gone). logoMark.ts reads public/logo-mark-256.png at runtime, so the share
card and og.png follow automatically after a restart.

## Recolouring the tile

The background is a flat cluster around #FCF604, so it is remapped by distance
rather than by hue, which leaves the pink shadow, the white body and the black
outline untouched:

    for every pixel: if |rgb - (252,246,4)| <= 60 then rgb = (0xD7,0xDC,0x1F)

That moved 62% of the image and produced no halo, because the tile is a full
bleed square (the rounded corner is CSS, not pixels) so there is no edge to
feather.
