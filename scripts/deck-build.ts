/**
 * Render every slide and write the PDF.
 *
 * THE PDF IS WRITTEN HERE, BY HAND, and that is the point: assembling it needed
 * a Python library in a virtualenv nobody else has, so `npm run deck` produced
 * eleven PNGs and stopped one step short of the thing anybody actually wants.
 * A PDF whose pages are each one full-bleed JPEG is a small, well-specified
 * file, and macOS already ships the only other tool required.
 *
 *   npm run deck    ->  brand/oddie-deck-v2.pdf
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SLIDES, slidePng } from "./deck.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "../brand/oddie-deck-v2.pdf");
const work = mkdtempSync(path.join(tmpdir(), "oddie-deckpdf-"));

// 1440x810 points: a slide, not a print page.
const PW = 1440, PH = 810;

/** A minimal PDF: one page per image, each image filling its page.
 *  JPEG goes in untouched (DCTDecode is the one filter a PDF reader must
 *  already have), which is why the PNGs are transcoded on the way in. */
function pdfOf(jpegs: Buffer[]): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (s: string | Buffer) => {
    const b = typeof s === "string" ? Buffer.from(s, "latin1") : s;
    chunks.push(b); len += b.length;
  };
  const obj = (n: number, body: string | Buffer[]) => {
    offsets[n] = len;
    push(`${n} 0 obj\n`);
    if (typeof body === "string") push(body);
    else body.forEach(push);
    push("\nendobj\n");
  };

  const n = jpegs.length;
  // 1 catalog, 2 pages, then per slide: page, content, image.
  const pageId = (i: number) => 3 + i * 3;
  const kids = jpegs.map((_, i) => `${pageId(i)} 0 R`).join(" ");

  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);

  jpegs.forEach((jpg, i) => {
    const p = pageId(i), c = p + 1, im = p + 2;
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] `
      + `/Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${c} 0 R >>`);
    const stream = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
    obj(c, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    obj(im, [
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1920 /Height 1080 `
        + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, "latin1"),
      jpg,
      Buffer.from("\nendstream", "latin1"),
    ]);
  });

  const xref = len;
  const count = 3 + n * 3;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let i = 1; i < count; i++) push(`${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

const pngDir = process.argv[2] || "/tmp/oddie-deck";
mkdirSync(pngDir, { recursive: true });

const jpegs: Buffer[] = [];
SLIDES.forEach((s, i) => {
  const nn = String(i + 1).padStart(2, "0");
  const png = slidePng(s, i + 1, SLIDES.length);
  writeFileSync(`${pngDir}/${nn}.png`, png);
  // sips, because resvg writes PNG and a PDF wants the one image format it can
  // carry without re-encoding.
  const jpgPath = path.join(work, `${nn}.jpg`);
  execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "88",
    `${pngDir}/${nn}.png`, "--out", jpgPath], { stdio: "ignore" });
  const jpg = readFileSync(jpgPath);
  jpegs.push(jpg);
  console.log(`${nn}  ${(s.label || "—").padEnd(16)} ${Math.round(jpg.length / 1024)}KB`);
});

const pdf = pdfOf(jpegs);
writeFileSync(OUT, pdf);
console.log(`\n${OUT}  ${Math.round(pdf.length / 1024)}KB  ${jpegs.length} pages`);
