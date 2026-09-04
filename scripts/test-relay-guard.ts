/**
 * The relay guard, asserted.
 *
 * submitSignedTx forwards bytes somebody else signed, so its instruction filter
 * is the only thing standing between "broadcast this bet" and "broadcast
 * anything". Adding the priority fee widened that filter for the first time, so
 * the widening gets a test rather than a comment: ComputeBudget may ride along,
 * NOTHING else may, and exactly one instruction must be ours.
 *
 * This tests the RULE against real transaction bytes, with no cluster and no
 * keys, by rebuilding the same predicate the guard uses.
 */
import { web3 } from "@coral-xyz/anchor";

let failed = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.error(`  ✗ ${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
};

const OURS = new web3.PublicKey("3SYG7hzQBYGc853BGTxcBtTLefESaP9DqP5aHbvgnYsu");
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SOMEBODY_ELSE = web3.SystemProgram.programId; // a real, very dangerous passenger

/** The guard's predicate, exactly as src/chain/oddieChain.ts applies it. */
function accepted(tx: web3.Transaction): boolean {
  const mine = OURS.toBase58();
  const ours = tx.instructions.filter((i) => i.programId.toBase58() === mine);
  const strangers = tx.instructions.filter((i) => {
    const pid = i.programId.toBase58();
    return pid !== mine && pid !== COMPUTE_BUDGET;
  });
  return ours.length === 1 && strangers.length === 0;
}

const payer = web3.Keypair.generate().publicKey;
const blockhash = "11111111111111111111111111111111";
const tx = () => new web3.Transaction({ feePayer: payer, recentBlockhash: blockhash });
const ourIx = () => new web3.TransactionInstruction({ programId: OURS, keys: [], data: Buffer.from([1]) });
const feeIx = () => web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 });
const theftIx = () => web3.SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 });

console.log("\nrelay guard\n");

check("a bare transaction of ours is accepted (the old shape still works)",
  accepted(tx().add(ourIx())));

check("ours plus a priority fee is accepted (the new shape)",
  accepted(tx().add(feeIx()).add(ourIx())));

check("the fee may also come after ours (order is not a rule)",
  accepted(tx().add(ourIx()).add(feeIx())));

check("two ComputeBudget instructions are still fine (price and limit)",
  accepted(tx().add(feeIx()).add(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })).add(ourIx())));

check("A TRANSFER RIDING ALONG IS REFUSED (this is the whole point)",
  !accepted(tx().add(ourIx()).add(theftIx())));

check("a transfer hidden in front of ours is refused too",
  !accepted(tx().add(theftIx()).add(ourIx())));

check("a transfer dressed between a fee and ours is refused",
  !accepted(tx().add(feeIx()).add(theftIx()).add(ourIx())));

check("two of our own instructions are refused (no batching money twice)",
  !accepted(tx().add(ourIx()).add(ourIx())));

check("a transaction with none of ours is refused",
  !accepted(tx().add(feeIx())));

check("an empty transaction is refused",
  !accepted(tx()));

// The decoder has to survive the same widening: it must FIND our instruction
// rather than assume it is first, or every stake silently loses its entry
// stamp and its Genesis bettor credit.
const withFee = tx().add(feeIx()).add(ourIx());
const found = withFee.instructions.find((i) => i.programId.toBase58() === OURS.toBase58());
check("the decoder finds our instruction behind a priority fee",
  Boolean(found) && found!.programId.toBase58() === OURS.toBase58());
check("and it is NOT the first instruction, which is why index 0 was wrong",
  withFee.instructions[0].programId.toBase58() === COMPUTE_BUDGET);

console.log(failed === 0 ? "\nall relay guard checks passed.\n" : `\n${failed} FAILED\n`);
if (failed > 0) process.exit(1);
