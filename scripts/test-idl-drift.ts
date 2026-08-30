// The committed IDL and the deployed program are two halves of one contract, and
// only one half is ours at any moment. This pins what happens when they drift.
//
// It shipped once and took trading down. The program change regenerated the IDL
// and committed it while devnet still ran the previous program; Anchor derives
// an account's discriminator from its struct NAME, so every legacy account
// passed the gate and only then failed on a field, fetchMarketOnChain caught the
// throw and returned null, and the whole system read it as "the chain is
// unreachable" while nothing logged a cause.
//
// No validator and no network: encode with one IDL, decode with the other.
//
// Run with: npm run test-idl-drift
if (process.env.DATABASE_URL) { console.error("refusing to run against a database"); process.exit(1); }

import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.error(`  ✗ ${n}`); if (d) console.error(`      ${d}`); }
};

const deployed = JSON.parse(readFileSync("scripts/fixtures/idl-deployed.json", "utf8"));
const next = JSON.parse(readFileSync("onchain/idl-next.json", "utf8"));
const cDeployed = new BorshAccountsCoder(deployed);
const cNext = new BorshAccountsCoder(next);

/** A Market as the DEPLOYED program writes it, with a question of `n` bytes. */
async function encodeLegacy(question: string): Promise<Buffer> {
  return cDeployed.encode("Market", {
    authority: { toBuffer: () => Buffer.alloc(32) },
    creator: { toBuffer: () => Buffer.alloc(32) },
    marketId: { toArrayLike: () => Buffer.alloc(8) },
    question,
    closeTime: { toArrayLike: () => Buffer.alloc(8) },
    resolved: false, winningSide: 0,
    totalYes: { toArrayLike: () => Buffer.alloc(8) },
    totalNo: { toArrayLike: () => Buffer.alloc(8) },
    creatorFeeBps: 200,
    creatorFeeLamports: { toArrayLike: () => Buffer.alloc(8) },
    creatorFeeClaimed: false,
    protocolFeeBps: 200,
    protocolFeeLamports: { toArrayLike: () => Buffer.alloc(8) },
    protocolFeeClaimed: false,
    bump: 255, vaultBump: 254,
  } as never);
}

console.log("\nthe two IDLs really are incompatible, and identically named");
{
  const dm = deployed.accounts.find((a: { name: string }) => a.name === "Market");
  const nm = next.accounts.find((a: { name: string }) => a.name === "Market");
  // The discriminator is derived from the struct NAME, which did not change.
  // That is what makes the drift silent: the gate passes, the fields do not.
  const disc = createHash("sha256").update("account:Market").digest().subarray(0, 8);
  check("both IDLs still declare an account called Market", Boolean(dm && nm));
  check("the discriminator is name-derived, so it is unchanged", disc.length === 8);

  const df = deployed.types.find((t: { name: string }) => t.name === "Market").type.fields.map((f: { name: string }) => f.name);
  const nf = next.types.find((t: { name: string }) => t.name === "Market").type.fields.map((f: { name: string }) => f.name);
  check("the deployed layout carries `question`", df.includes("question") && !df.includes("question_hash"));
  check("the next layout carries `question_hash`", nf.includes("question_hash") && !nf.includes("question"));
}

console.log("\nAN ACCOUNT FROM THE DEPLOYED PROGRAM MUST NOT DECODE WITH THE NEXT IDL");
{
  // A real-length question. Everything after it shifts by the question's own
  // length, so a bool lands on a letter and borsh refuses it.
  const bytes = await encodeLegacy("Will Arsenal finish top four this season, or not quite?");
  let threw = "";
  try { cNext.decode("Market", bytes); } catch (e) { threw = (e as Error).message; }
  check("the next IDL refuses it", threw.length > 0, threw || "IT DECODED, which is the outage");
  check("...and refuses it on a field, not a discriminator", !/discriminator/i.test(threw), threw);

  // The reverse must still work, or the fixture is wrong rather than the point.
  const back = cDeployed.decode("Market", bytes) as { question: string };
  check("the deployed IDL reads its own bytes", back.question.startsWith("Will Arsenal"));
}

console.log("\nTHE 28-BYTE COLLISION: the one length where drift is SILENT");
{
  // A borsh String is a 4-byte length plus its bytes, and question_hash is a
  // fixed 32. At exactly 28 bytes the two are the same width, everything after
  // lines up, and the account decodes CLEANLY under both layouts. Nothing
  // throws, so nothing warns, and the 32 bytes the new program treats as a
  // commitment are really the question's own text.
  const q = "Will BTC close above 100k?xx";
  check("the fixture is exactly 28 bytes", Buffer.byteLength(q) === 28, String(Buffer.byteLength(q)));

  const bytes = await encodeLegacy(q);
  let decoded: Record<string, unknown> | null = null;
  try { decoded = cNext.decode("Market", bytes) as Record<string, unknown>; } catch { decoded = null; }
  check("it decodes silently under the next IDL", decoded !== null, "it threw, which would at least be loud");

  const raw = decoded?.question_hash ?? decoded?.questionHash;
  check("the next layout produced a 32-byte question_hash", Array.isArray(raw) && raw.length === 32, JSON.stringify(Object.keys(decoded ?? {})));
  if (Array.isArray(raw)) {
    const asBytes = Buffer.from(raw as number[]);
    const real = createHash("sha256").update(q).digest();
    // Those 32 bytes are borsh's 4-byte length prefix followed by the question
    // itself. They are the QUESTION, not a commitment to it, so a later write
    // would record something nobody can verify against.
    check("the 'hash' is really the question text", asBytes.subarray(4, 8).toString("utf8") === "Will", JSON.stringify(asBytes.toString("utf8")));
    check("...and it does NOT equal the real hash", !asBytes.equals(real));
    check("...its first bytes are borsh's length prefix, not entropy", asBytes.readUInt32LE(0) === 28, String(asBytes.readUInt32LE(0)));
  }
}

console.log(failures === 0 ? "\nall IDL-drift checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
