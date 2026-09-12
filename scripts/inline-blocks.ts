/**
 * WHERE THE INLINE JAVASCRIPT IN A PAGE ACTUALLY LIVES.
 *
 * These shells carry their whole behaviour in one inline block, so two checks
 * have to find that code before they can say anything about it:
 * test-inline-scripts asks whether it parses, test-undeclared-names asks
 * whether it reads a name that was never declared. A block the extraction
 * skipped would be invisible to BOTH, and invisible is the state every bug
 * these files have cost us was already in. So the extraction is written once,
 * here, instead of once per caller where the two copies can drift apart.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every file under `dir`, recursively, whose name ends in `ext`. */
export function filesUnder(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, ext));
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

export type InlineBlock = {
  /** The JavaScript between the tags, verbatim and unindented-as-written. */
  code: string;
  /** 1-based line in the HTML file where `code` starts. A caller that moves
   *  this code somewhere else to check it needs this to say where a finding
   *  really came from -- a line number in a copy points at nothing. */
  line: number;
};

/** Inline blocks only: <script src=...> is fetched, not embedded, and is
 *  parsed by its own file. A block with a non-JS type (JSON-LD, a template)
 *  is not JavaScript and must not be handed to the parser. */
export function inlineBlocks(html: string): InlineBlock[] {
  const out: InlineBlock[] = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !/^(module|text\/javascript|application\/javascript)$/.test(type)) continue;
    if (m[2].trim()) {
      // The attrs are [^>]*, so the first ">" in the match closes the open tag
      // and the code starts on the character after it.
      const codeStart = m.index + m[0].indexOf(">") + 1;
      out.push({ code: m[2], line: html.slice(0, codeStart).split("\n").length });
    }
  }
  return out;
}
