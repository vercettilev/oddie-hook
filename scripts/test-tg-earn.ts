// Collecting the 2% on Telegram. The token is the only thing standing between
// "this person may link a wallet to their markets" and "anybody may", so it is
// pinned against every way a token goes wrong.
import { readFileSync } from "node:fs";
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

/* ON THE PUBLIC PAGE, ONLY THE PUBLIC DOOR. The market page is readable by
   anybody, so what it prints for "the opener" must be the t.me deep link that
   lands each tapper in their own chat -- never a URL carrying a token, which
   would let the whole web link a wallet to one person's markets. */
{
  const server = readFileSync("src/server.ts", "utf8");
  const i = server.indexOf("earnUrl: sourceUrlKind(src?.sourceUrl)");
  const earnExpr = i >= 0 ? server.slice(i, i + 220) : "";
  check("the page's earn door is the public deep link", /t\.me\/\$\{tgBotUsername\}\?start=earn/.test(earnExpr), earnExpr.slice(0, 120));
  check("...and never a token URL", !/tg\/earn\?t=|earnToken\(/.test(earnExpr));

  /* A TELEGRAM NAME NEVER BECOMES AN X HANDLE. taggedBy feeds X's own paths;
     a Telegram @name in it would have them treating a same-named X account as
     the person who opened the market. */
  const t = server.indexOf("taggedBy: src?.handle ?? null");
  check("taggedBy still comes only from the X surfacer", t >= 0);
  check("...and the Telegram opener has its own field", /openedBy: sourceUrlKind\(src\?\.sourceUrl\) === "telegram"/.test(server));
}

/* BOTH SIGN-IN MESSAGES NAME THE PAGE'S OWN HOST. The earn page and the app's
   wallet link both run on app.oddie.fun; a message naming oddie.fun is one the
   wallet flags as coming from another site. */
{
  const server = readFileSync("src/server.ts", "utf8");
  const calls = [...server.matchAll(/issueChallenge\(([^;]*?)\);/g)].map((m) => m[1]);
  check("there are two wallet challenges (app link, Telegram earn)", calls.length === 2, String(calls.length));
  check("...and every one takes its site from walletDomain(req)", calls.every((c) => /walletDomain\(req\)\s*$/.test(c)), calls.join(" || "));
  check("walletDomain defaults to the app host, where the signing pages live",
    /signInDomain\(req\.hostname, APP_HOST \|\| new URL\(BASE_URL\)\.host/.test(server));

  const page = readFileSync("public/tg-earn.html", "utf8");
  check("the earn page reports where a failure happened", /report\(stage, e\)/.test(page) && /\/api\/tg\/earn\/fail/.test(page));
  check("...and the report route needs a live token", /app\.post\("\/api\/tg\/earn\/fail"[\s\S]{0,200}verifyEarnToken/.test(server));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall earn-token checks passed.\n");
process.exit(failures ? 1 : 0);
