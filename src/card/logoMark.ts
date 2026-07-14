// The oddie mark, embedded as a base64 PNG so the card renders it with zero
// network reach — the same self-contained contract the bundled fonts follow.
// resvg rasterises the <image> into the og:image PNG, and browsers show it in
// the /card/*.svg directly; a referenced URL would do neither reliably (an SVG
// og:image can't fetch a cross-origin asset, and half the unfurlers block it).
//
// 256px source into a ~68px artboard slot: at the card's 2× raster (~136px) resvg
// downsamples with headroom, so the mark stays crisp. A 128px source lands ~1:1
// and reads soft; a 512px one just bloats every card. 256 is the sweet spot.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const PNG = readFileSync(path.join(here, "../../public/logo-mark-256.png"));
export const LOGO_MARK_DATA_URI = `data:image/png;base64,${PNG.toString("base64")}`;

/** The brand lockup for the card header: the mark, then the wordmark text.
 *  `x`/`y` anchor the mark's top-left; the wordmark is drawn by the caller so
 *  each card keeps its own fill. Returns just the <image>. */
export function logoMark(x: number, y: number, size: number): string {
  return `<image href="${LOGO_MARK_DATA_URI}" x="${x}" y="${y}" width="${size}" height="${size}"/>`;
}
