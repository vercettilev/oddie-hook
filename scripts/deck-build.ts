// Render every slide and leave the PNGs where the assembler can find them.
import { writeFileSync, mkdirSync } from "node:fs";
import { SLIDES, slidePng } from "./deck.js";
const out = process.argv[2] || "/tmp/oddie-deck";
mkdirSync(out, { recursive: true });
SLIDES.forEach((s, i) => {
  const png = slidePng(s, i + 1, SLIDES.length);
  writeFileSync(`${out}/${String(i + 1).padStart(2, "0")}.png`, png);
  console.log(`${String(i + 1).padStart(2, "0")}  ${s.label || "—"}  ${Math.round(png.length / 1024)}KB`);
});
