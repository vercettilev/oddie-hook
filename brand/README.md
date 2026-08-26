# Brand source files

Originals as delivered. Everything in public/ is generated FROM these, so
regenerate rather than editing an icon by hand.

- `oddiepink.png`   1254x1254. THE LOGO IN USE. Ghost with the pink offset
                    shadow on #FDF604. The pink matches the landing headline's
                    echo, which is where it came from.
- `oddielogo.png`   1254x1254. Same ghost, no pink shadow, on the older lime.
                    Kept as the flat alternative.
- `oddiebanner.png` 2196x716. Cinematic banner, "Turn arguments into markets."
- `oddieimage.png`  1122x1402. THE PORTAL IN USE, shipped as public/portal.png.
                    Same render as oddiegraphic with pink embers and pink rim
                    light added, which is what ties it to the rest of the brand.
- `oddiegraphic.png` 1122x1402. The same scene BEFORE the pink was added. This
                    is what the landing shipped until 2026-08-26.
- `oddie-ansemhack.png` 1200x630 with alpha. AnsemHack graphic.

Regenerate every icon from the logo:

    SRC=brand/oddiepink.png
    names=(favicon-16.png favicon-32.png favicon-48.png apple-touch-icon.png icon-192.png icon-512.png logo-mark-96.png logo-mark-128.png logo-mark-256.png logo-icon.png)
    sizes=(16 32 48 180 192 512 96 128 256 512)
    for i in {1..${#names[@]}}; do sips -z ${sizes[$i]} ${sizes[$i]} "$SRC" --out "public/${names[$i]}"; done

favicon.ico is PNG-in-ICO built from the 16/32/48 PNGs; sips cannot write .ico.
feed.html's `--mark` is the only HAND-EMBEDDED copy: base64 of logo-mark-128.png,
inlined so the app header never depends on a path resolving. logoMark.ts reads
public/logo-mark-256.png at runtime, so the share card follows automatically.
