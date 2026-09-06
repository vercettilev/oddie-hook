/**
 * Every instruction the server builds hands the program every account the
 * program declares.
 *
 * accountsStrict() resolves nothing: what is not listed is not there, and the
 * failure is a throw at BUILD time inside a try/catch that turns it into null,
 * which the route turns into a 502 that blames the chain. That is how the
 * refund route shipped never having worked once: `system_program` was in the
 * IDL and not in the builder, and nothing between the two ever compared them.
 *
 * Static on purpose, no cluster: the IDL is the program's own declaration of
 * what each instruction needs, and oddieChain.ts is grepped as source for the
 * `.methods.<name>(...)...accountsStrict({...})` block that builds it.
 *
 * Run with: npm run test-accounts-strict
 */
import { readFileSync } from "node:fs";

let failed = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
};
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const idl = JSON.parse(readFileSync(new URL("../src/chain/oddie_chain_idl.json", import.meta.url), "utf8")) as {
  instructions: Array<{ name: string; accounts: Array<{ name: string; optional?: boolean }> }>;
};
const src = readFileSync(new URL("../src/chain/oddieChain.ts", import.meta.url), "utf8");

console.log("\nevery built instruction provides every declared account\n");
let built = 0;
for (const ix of idl.instructions) {
  const method = camel(ix.name);
  const at = src.indexOf(`.methods\n      .${method}(`) >= 0 ? src.indexOf(`.methods\n      .${method}(`) : src.indexOf(`.methods.${method}(`);
  if (at < 0) { console.log(`  - ${ix.name}: not built by the server (skipped)`); continue; }
  built++;
  const strictAt = src.indexOf(".accountsStrict({", at);
  const looseAt = src.indexOf(".accounts({", at);
  const usesStrict = strictAt >= 0 && (looseAt < 0 || strictAt < looseAt);
  if (!usesStrict) { console.log(`  - ${ix.name}: built with .accounts() (anchor resolves the rest; not checked)`); continue; }
  const close = src.indexOf("})", strictAt);
  const block = src.slice(strictAt, close);
  // keys written as `name:` or shorthand `name,` inside the object literal
  const given = new Set([...block.matchAll(/(?:^|[{,\s])([A-Za-z_][A-Za-z0-9_]*)\s*(?::|,|\n|$)/g)].map((m) => m[1]));
  const required = ix.accounts.filter((a) => !a.optional).map((a) => camel(a.name));
  const missing = required.filter((a) => !given.has(a));
  check(`${ix.name} lists ${required.length} required account(s)`, missing.length === 0, { missing, given: [...given] });
}
check("at least one instruction was actually checked (the test is not vacuous)", built > 0, built);
check("refund_after_deadline is among them (the bug that motivated this)",
  idl.instructions.some((i) => i.name === "refund_after_deadline") && src.includes(".refundAfterDeadline()"));

console.log(failed === 0 ? "\nall accounts-strict checks passed.\n" : `\n${failed} FAILED\n`);
if (failed > 0) process.exit(1);
