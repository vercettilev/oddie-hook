/**
 * NO BROWSER FILE MAY READ A `var` ABOVE THE LINE THAT ASSIGNS IT.
 *
 * `var` hoists the DECLARATION and not the assignment, so a name read above its
 * own `var` line is not a ReferenceError that anybody would notice. It is
 * `undefined`, quietly, and then the first property access on it throws.
 *
 * This cost the profile page outright. `pushAsk(cl.length > 0 || op.length > 0)`
 * sat one line above `var op = (open && open.open) || []`. When the claimable
 * list was empty the `||` fell through to `op.length`, which threw, which killed
 * the whole .then() mid-render, which left "Finding your bets…" on screen
 * forever. It was the common state -- open bets, nothing settled yet -- and it
 * was invisible to whoever HAD a win to collect, because a non-empty `cl` short
 * circuits the `||` and never reaches the second half. Three separate fixes
 * chased that sentence on a real phone (a timeout, a stale-read heal, a screen
 * watchdog) and every one of them treated a symptom.
 *
 * NOTHING IN THIS SUITE COULD SEE IT, and that is the reason this file exists:
 *   - test-inline-scripts only asks whether the code parses. It parses.
 *   - test-undeclared-names reads TS2304, "Cannot find name". The name is
 *     declared. `var` hoisted it.
 *   - tsc itself says nothing. Measured, on the exact pattern, with --strict on:
 *     zero diagnostics. It reports TS2448 for a `let` or a `const` read above
 *     its declaration and it is SILENT for a `var`, which is the one keyword
 *     every line of these pages is written in.
 *
 * THE RULE: an identifier that READS a `var`, in the same function scope as the
 * declaration that assigns it, textually above that declaration.
 *
 * Two exclusions, and both are the difference between a check and a nuisance:
 *   - Nested functions are their own scope. `function f(){ return x } var x = 1`
 *     is normal and correct: f runs later, by which time x is assigned. Only a
 *     read on the straight-line path of the SAME scope is a read of undefined.
 *   - Writes do not count. Assigning above the `var` line is legal, occasionally
 *     deliberate, and never the crash this is looking for.
 *
 * Measured when written: zero findings across public/, and against
 * public/app/you.html as it stood at 5a22ab6 it reports exactly one, at the line
 * that took the page down.
 *
 * Run with: npm run test-hoisted-reads
 */
import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { filesUnder, inlineBlocks } from "./inline-blocks.js";

type Finding = { line: number; name: string; declLine: number };

function isFunctionLike(n: ts.Node): boolean {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
    || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)
    || ts.isGetAccessor(n) || ts.isSetAccessor(n);
}

/** An identifier that READS a binding, rather than declaring one or naming a
 *  property. `o.op` is not a read of `op`, and neither is `{ op: 1 }`. */
function isRead(n: ts.Identifier): boolean {
  const p = n.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if (ts.isQualifiedName(p) && p.right === n) return false;
  if (ts.isPropertyAssignment(p) && p.name === n) return false;
  if (ts.isVariableDeclaration(p) && p.name === n) return false;
  if (ts.isParameter(p) && p.name === n) return false;
  if (ts.isBindingElement(p) && (p.name === n || p.propertyName === n)) return false;
  if ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p)) && p.name === n) return false;
  if (ts.isLabeledStatement(p) && p.label === n) return false;
  if (ts.isBreakOrContinueStatement(p) && p.label === n) return false;
  if (ts.isBinaryExpression(p) && p.left === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return false;
  return true;
}

/** `lineOf` maps a line of the source handed to the parser back to a line of the
 *  file a person can actually open. Absent for a real .js file, where they are
 *  the same thing. */
function scan(src: ts.SourceFile, lineOf?: number[]): Finding[] {
  const found: Finding[] = [];
  const lineAt = (pos: number) => {
    const l = src.getLineAndCharacterOfPosition(pos).line;          // 0-based
    return lineOf ? (lineOf[l] ?? 0) : l + 1;
  };

  function scope(root: ts.Node) {
    const assignedAt = new Map<string, number>();
    const reads: { name: string; pos: number }[] = [];
    const nested: ts.Node[] = [];

    (function visit(n: ts.Node) {
      // A function boundary ends this scope and opens another. `var` is
      // function-scoped, so everything else -- blocks, ifs, loops, try -- is
      // still the scope we are in and must be walked through.
      if (n !== root && isFunctionLike(n)) { nested.push(n); return; }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
          && !((n.parent as ts.VariableDeclarationList).flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
        const at = n.name.getStart(src);
        const prev = assignedAt.get(n.name.text);
        // The FIRST assignment is the one that matters: a second `var x = ...`
        // further down cannot un-break a read above the first.
        if (prev === undefined || at < prev) assignedAt.set(n.name.text, at);
      }
      if (ts.isIdentifier(n) && isRead(n)) reads.push({ name: n.text, pos: n.getStart(src) });
      ts.forEachChild(n, visit);
    })(root);

    for (const r of reads) {
      const at = assignedAt.get(r.name);
      if (at !== undefined && r.pos < at) {
        found.push({ line: lineAt(r.pos), name: r.name, declLine: lineAt(at) });
      }
    }
    for (const n of nested) scope(n);
  }

  scope(src);
  return found;
}

const jsFiles = filesUnder("public", ".js").sort();
const htmlFiles = filesUnder("public", ".html").sort();

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

const say = (f: Finding) =>
  `line ${f.line}: '${f.name}' is read here, and assigned at line ${f.declLine}. ` +
  `var hoists the declaration, not the assignment, so it is undefined at this point.`;

console.log("\nreads above the line that assigns them\n");

for (const f of jsFiles) {
  const hits = scan(ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.ES2022, true));
  check(`${f} assigns every var before it reads it`, hits.length === 0, hits.map(say).join("\n      "));
}

let pages = 0;
for (const f of htmlFiles) {
  // The browser runs every classic inline block of a page in ONE shared scope,
  // so the blocks are joined exactly as test-undeclared-names joins them.
  const lines: string[] = [];
  const lineOf: number[] = [];
  for (const b of inlineBlocks(readFileSync(f, "utf8"))) {
    b.code.split("\n").forEach((l, i) => { lines.push(l); lineOf.push(b.line + i); });
    lines.push(";");
    lineOf.push(0);
  }
  const code = lines.join("\n");
  if (!code.trim()) continue;
  pages++;
  const hits = scan(ts.createSourceFile(f + ".js", code, ts.ScriptTarget.ES2022, true), lineOf);
  check(`${f} assigns every var before it reads it`, hits.length === 0, hits.map(say).join("\n      "));
}

console.log(`\n${jsFiles.length} script file(s), ${pages} page(s) with inline script`);
console.log(failures === 0 ? "\nall hoisted-read checks passed.\n" : `\n${failures} hoisted-read check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
