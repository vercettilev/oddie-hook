/**
 * EVERY INLINE <script> IN public/ MUST PARSE.
 *
 * These shells carry their whole behaviour in one inline block, and a browser
 * treats a parse error there as silence: the HTML renders, the CSS applies, the
 * page sits on its "Loading…" placeholder forever and NOTHING says why. There
 * is no request to inspect, no server log, no failing route -- the only trace
 * is one line in a console nobody has open.
 *
 * It cost a market page a full round of "why is this blank" before the answer
 * turned out to be a single quote closed with the wrong character, inside a
 * string that builds a form field. Every other check in this suite passed:
 * tsc does not read HTML, and no test had ever asked whether the code inside
 * these files was code.
 *
 * new Function() is the whole test. It parses without executing, so nothing
 * here touches the DOM, the network, or the store.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}

/** Inline blocks only: <script src=...> is fetched, not embedded, and is
 *  parsed by its own file. A block with a non-JS type (JSON-LD, a template)
 *  is not JavaScript and must not be handed to the parser. */
function inlineBlocks(html: string): string[] {
  const out: string[] = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !/^(module|text\/javascript|application\/javascript)$/.test(type)) continue;
    if (m[2].trim()) out.push(m[2]);
  }
  return out;
}

const files = htmlFiles("public");
let blocks = 0;
const bad: string[] = [];

for (const f of files) {
  const html = readFileSync(f, "utf8");
  for (const [i, code] of inlineBlocks(html).entries()) {
    blocks++;
    try {
      // eslint-disable-next-line no-new-func
      new Function(code);
    } catch (e) {
      // The line number is worth more than the message: these blocks run to
      // thousands of lines and "unexpected token" alone locates nothing.
      const line = firstBadLine(code);
      bad.push(`${f} · inline block #${i + 1}${line ? ` · near line ${line.n}: ${line.text.trim().slice(0, 80)}` : ""}\n    ${(e as Error).message}`);
    }
  }
}

/** Walks forward one line at a time and reports where a growing prefix stops
 *  being repairable. A prefix cut mid-expression always fails, so only a
 *  failure that PERSISTS to the end of the file is treated as the real one. */
function firstBadLine(code: string): { n: number; text: string } | null {
  const lines = code.split("\n");
  for (let i = 1; i <= lines.length; i++) {
    const head = lines.slice(0, i).join("\n");
    try {
      new Function(head);
      continue;                     // parses: everything up to here is fine
    } catch {
      try {
        // Does the REST of the file rescue it? If the whole remainder still
        // cannot close this prefix, the break is at or before line i.
        new Function(head + "\n" + lines.slice(i).join("\n"));
        continue;
      } catch {
        if (i === lines.length) return { n: i, text: lines[i - 1] ?? "" };
      }
    }
  }
  return null;
}

if (bad.length) {
  console.error(`FAIL — ${bad.length} inline script(s) do not parse:\n`);
  for (const b of bad) console.error("  " + b + "\n");
  process.exit(1);
}
console.log(`inline scripts parse: ${blocks} block(s) across ${files.length} html file(s)`);
