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
/* Phantom augments every transaction it signs with Lighthouse guard
   instructions: assertions that what happens on chain matches the preview the
   user was shown. They can only make a transaction fail, never move the
   signer's funds, and refusing them means the majority wallet on Solana cannot
   place a bet at all. Same address on devnet and mainnet-beta. */
const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const SOMEBODY_ELSE = web3.SystemProgram.programId; // a real, very dangerous passenger

/** The guard's predicate, exactly as src/chain/oddieChain.ts applies it. */
function accepted(tx: web3.Transaction): boolean {
  const mine = OURS.toBase58();
  const ours = tx.instructions.filter((i) => i.programId.toBase58() === mine);
  const PASSENGERS = new Set([COMPUTE_BUDGET, LIGHTHOUSE]);
  const strangers = tx.instructions.filter((i) => {
    const pid = i.programId.toBase58();
    return pid !== mine && !PASSENGERS.has(pid);
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

/* THE SHAPE PHANTOM ACTUALLY SENDS BACK.
   This is not hypothetical: it is what arrived at the relay minutes after the
   mainnet deploy, and the guard refused it, so the first real bet on mainnet
   was stopped by us rather than by the wallet. */
const lighthouseIx = () => new web3.TransactionInstruction({
  programId: new web3.PublicKey(LIGHTHOUSE), keys: [], data: Buffer.from([2]),
});
check("a Phantom-signed transaction is accepted (fee + ours + lighthouse)",
  accepted(tx().add(feeIx()).add(ourIx()).add(lighthouseIx())));
check("lighthouse in front of ours is accepted too",
  accepted(tx().add(lighthouseIx()).add(ourIx())));
check("lighthouse alone is still refused, because none of it is ours",
  !accepted(tx().add(lighthouseIx())));
check("and a real passenger is STILL refused alongside lighthouse",
  !accepted(tx().add(ourIx()).add(lighthouseIx()).add(
    new web3.TransactionInstruction({ programId: SOMEBODY_ELSE, keys: [], data: Buffer.from([3]) }))));

console.log(failed === 0 ? "\nall relay guard checks passed.\n" : `\n${failed} FAILED\n`);
if (failed > 0) process.exit(1);
