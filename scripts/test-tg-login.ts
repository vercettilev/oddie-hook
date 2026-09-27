// "Continue with Telegram". The rule this whole flow exists for: opening the
// link signs nobody in. Only the Yes tap does, only by the person who opened
// it, only once, and only for the browser that asked.
import { readFileSync } from "node:fs";
import {
  startTgLogin, askTgLogin, confirmTgLogin, tgLoginStatus, describeBrowser, _resetTgLogins, TG_LOGIN_TTL_MS,
} from "../src/telegram/login.js";
import { runTelegramSweep, TG_COPY, type TgSweepDeps } from "../src/telegram/loop.js";
import type { TgUpdate } from "../src/telegram/client.js";
import { _resetBotState } from "../src/store/markets.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const LEV = { id: 1775258225, first_name: "Lev", username: "levvercetti" };
const OTHER = { id: 42, first_name: "Mallory", username: "mallory" };
const DEV = "device-aaaaaaaaaaaaaaaa";

console.log("the sign-in itself");
{
  _resetTgLogins();
  const t0 = 1_800_000_000_000;
  const { nonce, code } = startTgLogin(DEV, "Chrome on macOS", t0);
  check("a link is 32 hex, a code four digits", /^[a-f0-9]{32}$/.test(nonce) && /^\d{4}$/.test(code));
  check("before anybody opens it, the page waits", tgLoginStatus(nonce, DEV, t0).status === "waiting");
  const ask = askTgLogin(nonce, LEV, t0 + 1000);
  check("opening it shows the browser and the code", ask?.code === code && ask?.asking === "Chrome on macOS");
  check("...and signs nobody in", tgLoginStatus(nonce, DEV, t0 + 1000).status === "asked");
  check("somebody else opening the same link gets nothing", askTgLogin(nonce, OTHER, t0 + 2000) === null);
  check("...and cannot confirm it", confirmTgLogin(nonce, OTHER, t0 + 2000) === null);
  check("the person who opened it confirms it, for the browser that asked",
    confirmTgLogin(nonce, LEV, t0 + 3000)?.deviceId === DEV);
  check("...once", confirmTgLogin(nonce, LEV, t0 + 4000) === null);
  const done = tgLoginStatus(nonce, DEV, t0 + 4000);
  check("the page then sees it done, with the name", done.status === "done" && done.handle === "levvercetti");
  check("another browser cannot read this sign-in", tgLoginStatus(nonce, "device-bbbbbbbbbbbbbbbb", t0 + 4000).status === "expired");
}
{
  _resetTgLogins();
  const t0 = 1_800_000_000_000;
  const { nonce } = startTgLogin(DEV, "Safari on iPhone", t0);
  check("an old link cannot be opened", askTgLogin(nonce, LEV, t0 + TG_LOGIN_TTL_MS + 1) === null);
  check("...nor confirmed", confirmTgLogin(nonce, LEV, t0 + TG_LOGIN_TTL_MS + 1) === null);
  check("...and the page is told", tgLoginStatus(nonce, DEV, t0 + TG_LOGIN_TTL_MS + 1).status === "expired");
  check("an unknown link is nothing", askTgLogin("0".repeat(32), LEV) === null);
}
{
  check("Chrome on macOS", describeBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36") === "Chrome on macOS");
  check("Safari on iPhone", describeBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1") === "Safari on iPhone");
  check("Firefox on Windows", describeBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0") === "Firefox on Windows");
}

console.log("\nthrough the bot, against a faithful Telegram");
function harness(updates: TgUpdate[]) {
  const calls = { prompts: [] as Array<{ chatId: number; text: string; cb: string }>, answers: [] as string[],
    edits: [] as string[], replies: [] as string[], confirmed: 0, extracted: 0 };
  const deps: TgSweepDeps = {
    botUsername: "oddiefunbot",
    updates: async (offset) => updates.filter((u) => offset === null || u.update_id >= offset),
    extract: async () => { calls.extracted++; throw new Error("no extraction expected"); },
    openMarket: async () => { throw new Error("no market expected"); },
    reply: async (o) => { calls.replies.push(o.text); },
    baseUrl: "https://app.oddie.fun",
    cardUrl: (s) => s,
    loginAsk: async (nonce, user) => askTgLogin(nonce, user),
    loginConfirm: async (nonce, user) => { const ok = confirmTgLogin(nonce, user); if (ok) calls.confirmed++; return Boolean(ok); },
    sendPrompt: async (chatId, text, button) => { calls.prompts.push({ chatId, text, cb: button.callback }); },
    // Faithful: every callback must be answered, and only once.
    answerCallback: async (id, text) => { if (calls.answers.some((a) => a.startsWith(id + ":"))) throw new Error("400 query is too old"); calls.answers.push(`${id}:${text ?? ""}`); },
    editMessage: async (_c, _m, text) => { calls.edits.push(text); },
  };
  return { deps, calls };
}
{
  _resetTgLogins(); _resetBotState();
  const { nonce, code } = startTgLogin(DEV, "Chrome on macOS");
  const dm = { id: LEV.id, type: "private" as const };
  const { deps, calls } = harness([
    { update_id: 1, message: { message_id: 7, chat: dm, from: { ...LEV, is_bot: false }, date: 0, text: `/start login_${nonce}` } },
  ]);
  await runTelegramSweep(deps);
  check("opening the link in the bot asks, with the code", calls.prompts.length === 1 && calls.prompts[0].text.includes(`Code ${code}`)
    && calls.prompts[0].text.includes("Chrome on macOS"));
  check("...behind a button carrying the link's id", calls.prompts[0]?.cb === `login:${nonce}`);
  check("...and that alone signs nobody in", calls.confirmed === 0 && tgLoginStatus(nonce, DEV).status === "asked");
  check("...and costs no model call", calls.extracted === 0);

  const tap = harness([
    { update_id: 2, callback_query: { id: "cb1", from: { ...LEV, is_bot: false }, data: `login:${nonce}`,
      message: { message_id: 8, chat: dm, date: 0, text: "Sign in to oddie?" } } },
  ]);
  await runTelegramSweep(tap.deps);
  check("the Yes signs the browser in", tap.calls.confirmed === 1 && tgLoginStatus(nonce, DEV).status === "done");
  check("...answers the tap", tap.calls.answers.length === 1 && tap.calls.answers[0] === "cb1:Signed in");
  check("...and turns the prompt into a message with no button to press again", tap.calls.edits[0] === TG_COPY.loginDone);

  const again = harness([
    { update_id: 3, callback_query: { id: "cb2", from: { ...LEV, is_bot: false }, data: `login:${nonce}`,
      message: { message_id: 8, chat: dm, date: 0, text: "x" } } },
  ]);
  await runTelegramSweep(again.deps);
  check("a second tap signs nothing in", again.calls.confirmed === 0 && again.calls.edits[0] === TG_COPY.loginExpired);
}
{
  _resetTgLogins(); _resetBotState();
  const { deps, calls } = harness([
    { update_id: 1, message: { message_id: 9, chat: { id: LEV.id, type: "private" }, from: { ...LEV, is_bot: false }, date: 0,
      text: `/start login_${"f".repeat(32)}` } },
  ]);
  await runTelegramSweep(deps);
  check("an unknown or expired link says so, with no button", calls.prompts.length === 0 && calls.replies[0] === TG_COPY.loginExpired);
}

console.log("\nwired");
{
  const server = readFileSync("src/server.ts", "utf8");
  check("the page's two routes exist", /app\.post\("\/api\/auth\/telegram\/start"/.test(server) && /app\.get\("\/api\/auth\/telegram\/status"/.test(server));
  const confirm = server.slice(server.indexOf("loginConfirm: async (nonce, user) => {"), server.indexOf("sendPrompt: async (chatId, text, button)"));
  check("the Yes links a Telegram identity to the browser that asked",
    /linkAccount\(ok\.deviceId, \{\s*provider: "telegram"/.test(confirm));
  const store = readFileSync("src/store/markets.ts", "utf8");
  check("the account table accepts telegram, in production too (ALTER, not only CREATE)",
    /ADD CONSTRAINT account_provider_check CHECK \(provider IN \('google','twitter','phantom','telegram'\)\)/.test(store));
  const you = readFileSync("public/app/you.html", "utf8");
  check("the profile offers Telegram beside X", /Continue with Telegram/.test(you) && /OddieTgLogin\.prepare/.test(you));
  check("...and a Telegram name satisfies the gate",
    /a\.provider === "twitter" \|\| a\.provider === "telegram"/.test(you));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall telegram sign-in checks passed.\n");
process.exit(failures ? 1 : 0);
