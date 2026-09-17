// A 3:1 cut of the site banner, for a deal card that asks for 1800x600.
//
// Not a route and not wired into the server: one asset for one form. It reuses
// renderBanner's own output rather than redrawing it, so the image cannot drift
// from what oddie.fun/og.png says.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { renderBanner } from "../src/card/renderBanner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(here, "../assets/fonts");
const FONTS = ["Fredoka_600SemiBold.ttf", "Fredoka_700Bold.ttf", "Nunito_700Bold.ttf", "Anton.ttf"]
  .map((f) => path.join(FONT_DIR, f));

// The banner is authored on a 1000x524 artboard: headline in the left column,
// chips at x 618 and 646. A 3:1 frame is 1572 wide at the same height, so the
// canvas grows to the right and the chips ride out with it. The type keeps its
// measure and the composition keeps its balance.
// The banner is authored on a 1000x524 artboard: headline in the left column,
// the yes/no chips at the right. A 3:1 frame is 1572 wide at the same height,
// so the canvas grows rightward and the CHIP CLUSTER IS TRANSLATED AS A WHOLE.
//
// Moving it by rewriting the rects' x attributes looked like it worked and did
// not: each chip's label and percentage carry their own computed x, and its
// rotation has its own origin, so the boxes slid right and left their contents
// behind. One translate on the group moves everything the group is made of.
const GROW = 588; // lands the chips on a right margin equal to the left one
const W = 1000 + GROW;
const base = renderBanner();
const chipStart = base.indexOf('<g transform="rotate(');
const chipEnd = base.lastIndexOf("</svg>");
const wide =
  base.slice(0, chipStart).replace(`width="1000" height="524" viewBox="0 0 1000 524"`,
      `width="${W}" height="524" viewBox="0 0 ${W} 524"`)
    .replace(`<rect width="1000" height="524"`, `<rect width="${W}" height="524"`)
  + `<g transform="translate(${GROW} 0)">` + base.slice(chipStart, chipEnd) + "</g>"
  + base.slice(chipEnd);

const png = new Resvg(wide, {
  fitTo: { mode: "width", value: 1800 },
  font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Fredoka" },
  background: "#ffffff",
}).render().asPng();
writeFileSync("deal-banner.png", png);
console.log(`wrote deal-banner.png  ${Math.round(png.length / 1024)}KB  1800x${Math.round(1800 * 524 / W)}`);
