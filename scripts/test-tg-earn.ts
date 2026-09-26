// Collecting the 2% on Telegram. The token is the only thing standing between
// "this person may link a wallet to their markets" and "anybody may", so it is
// pinned against every way a token goes wrong.
import { earnKey, earnToken, verifyEarnToken, EARN_TOKEN_TTL_MS } from "../src/telegram/earnToken.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const key = earnKey("8966893528:TEST-bot-token");
const other = earnKey("1111111111:a-different-bot");
const now = 1_800_000_000_000;

{
  const t = earnToken(1775258225, key, now);
  check("a token names the Telegram user it was issued to", verifyEarnToken(t, key, now) === 1775258225);
  check("...until it expires", verifyEarnToken(t, key, now + EARN_TOKEN_TTL_MS - 1) === 1775258225);
  check("...and not after", verifyEarnToken(t, key, now + EARN_TOKEN_TTL_MS) === null);
  check("a token from another bot's key is refused", verifyEarnToken(t, other, now) === null);
}
{
  /* THE ATTACK THIS EXISTS TO STOP: change the user id in the payload so the
     link binds a wallet to somebody else's markets. */
  const t = earnToken(1775258225, key, now);
  const [, mac] = t.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ t: 999, e: now + 1e9 })).toString("base64url");
  check("an edited user id is refused", verifyEarnToken(`${forgedPayload}.${mac}`, key, now) === null);
  const longer = Buffer.from(JSON.stringify({ t: 1775258225, e: now + 1e12 })).toString("base64url");
  check("an extended expiry is refused", verifyEarnToken(`${longer}.${mac}`, key, now) === null);
}
{
  for (const junk of ["", ".", "abc", "a.b.c", "x".repeat(500), `${"e30"}.`, "null.null"]) {
    check(`malformed input is refused without throwing: ${JSON.stringify(junk.slice(0, 12))}`,
      verifyEarnToken(junk, key, now) === null);
  }
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall earn-token checks passed.\n");
process.exit(failures ? 1 : 0);
