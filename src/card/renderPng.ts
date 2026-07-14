// The card, rasterised to PNG. X (and most chat apps) will not unfurl an SVG as
// an og:image, so the share preview has to be a raster. Same pixels as the SVG —
// this only changes the container, never the design — so the shareable image
// stays a faithful copy of /card/*.svg.
//
// resvg needs the actual font files; it does not reach the network or the system
// theme. We bundle the exact weights the card uses (Fredoka 600 for the wordmark,
// question and kicker, Fredoka 700 for the hero number, Nunito 700 for the pill
// and bar) so the raster is byte-stable and on-brand wherever it runs.

import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(here, "../../assets/fonts");
const FONT_FILES = ["Fredoka_600SemiBold.ttf", "Fredoka_700Bold.ttf", "Nunito_700Bold.ttf"]
  .map((f) => path.join(FONT_DIR, f));

// 2× the 1000×524 artboard: crisp on the retina crops X and iMessage show, still
// a small PNG. Height follows from the SVG's aspect ratio automatically.
const RENDER_WIDTH = 2000;

export function renderCardPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: RENDER_WIDTH },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Fredoka" },
    // The card draws its own white card on a white page; no transparency to keep.
    background: "#ffffff",
  });
  return Buffer.from(resvg.render().asPng());
}
