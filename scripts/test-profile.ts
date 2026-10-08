// A person's oddie name and picture, and the switch that puts the name on
// their bets. Against the in-memory store, plus the lines of SQL no memory
// test can reach (read, not guessed).
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  usernameState, saveProfile, profileFor, defaultAvatar, normUsername, AVATARS, _resetProfiles,
  _resetBetNotices,
} from "../src/store/markets.js";
import { tgWho, groupText, onBetLanded, type BetNotifyDeps } from "../src/social/bets.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

console.log("names");
{
  _resetProfiles();
  check("too short is not a name", (await usernameState("ab", "c1")) === "invalid");
  check("spaces are not a name", (await usernameState("lev v", "c1")) === "invalid");
  check("an @ and capitals are forgiven", normUsername("@LevVercetti") === "levvercetti" && (await usernameState("@Lev", "c1")) === "ok");
  check("oddie's own names are not for taking", (await usernameState("oddiefunbot", "c1")) === "reserved");
  const a = await saveProfile("c1", { username: "lev" });
  check("a free name can be taken", a.ok && a.ok && (await profileFor("c1"))?.username === "lev");
  check("...and then it is taken, for anybody else", (await usernameState("LEV", "c2")) === "taken");
  check("...but still yours", (await usernameState("lev", "c1")) === "ok");
  const b = await saveProfile("c2", { username: "lev" });
  check("saving a taken name is refused", !b.ok && b.error === "taken");
  check("a picture must be one of the twelve", !(await saveProfile("c1", { avatar: "../../etc/passwd" })).ok);
  check("...and one of them is kept", (await saveProfile("c1", { avatar: "a07" })).ok && (await profileFor("c1"))?.avatar === "a07");
  check("the name switch starts off", (await profileFor("c1"))?.showName === false);
  check("...and turns on", (await saveProfile("c1", { showName: true })).ok && (await profileFor("c1"))?.showName === true);
  const d1 = defaultAvatar("canon-xyz");
  check("everybody has a picture from the start, always the same one", d1 === defaultAvatar("canon-xyz") && (AVATARS as readonly string[]).includes(d1));
}

console.log("\nhow a staker is named in Telegram");
{
  check("their Telegram @handle when they have one", tgWho({ username: "lev", tgHandle: "levvercetti" }) === "@levvercetti");
  check("their oddie name WITHOUT an @, which in Telegram would mention a stranger", tgWho({ username: "lev", tgHandle: null }) === "lev");
  check("Someone, unless they chose otherwise", tgWho(null) === "Someone");
  check("the group message carries it",
    groupText({ slug: "s", wallet: "W", side: "yes", lamports: 5e8, before: { yes: 0, no: 0 } }, "@levvercetti")
      === "@levvercetti just took YES with 0.5 SOL. NO is wide open.");
}
{
  _resetBetNotices();
  const sent: string[] = []; const pushes: string[] = [];
  const deps: BetNotifyDeps = {
    now: () => 1_800_000_000_000,
    market: async () => ({ headline: "BTC to $100k?", url: "https://app.oddie.fun/m/x", feeBps: 200 }),
    opener: async () => ({ wallet: null, tgUserId: 99 }),
    walletsOnSide: async (_s, side) => (side === "yes" ? ["YES_WALLET"] : []),
    record: async (l) => l,
    tgUserForWallet: async () => 555,
    groupThreads: async () => [{ chatId: -100, messageId: 2 }],
    pacing: { get: async () => null, set: async () => {} },
    sendGroup: async (o) => { sent.push(o.text); },
    dm: async (_u, t) => { sent.push(t); },
    push: async (_w, p) => { pushes.push(p.body); },
    nameFor: async () => ({ username: "lev", tgHandle: "levvercetti" }),
    log: () => {},
  };
  await onBetLanded({ slug: "x", wallet: "NO_WALLET", side: "no", lamports: 2e8, before: { yes: 5e8, no: 0 } }, deps);
  check("a named staker is named to the group", sent.some((t) => t.startsWith("@levvercetti just took NO")));
  check("...and to the other side", sent.some((t) => t.startsWith("@levvercetti took the other side of your bet")));
  check("...and to the opener", sent.some((t) => /came in on NO from @levvercetti in your market/.test(t)));
  check("the lock screen never names anybody", pushes.length > 0 && pushes.every((b) => b.startsWith("Someone") || b.startsWith("A bet")));
}

console.log("\nthe lines no memory test reaches");
{
  const store = readFileSync("src/store/markets.ts", "utf8");
  const pub = store.slice(store.indexOf("export async function publicNameForWallet"), store.indexOf("export function _resetProfiles"));
  check("a stake is named only when its owner turned the switch on", /AND p\.show_name/.test(pub));
  check("...found through a signed wallet or the one chosen on Telegram",
    /provider = 'phantom' AND provider_uid = \$1/.test(pub) && /pe\.wallet = \$1/.test(pub));
  const st = store.slice(store.indexOf("export async function usernameState"), store.indexOf("export async function saveProfile"));
  check("somebody else's X or Telegram handle is reserved for them",
    /'reserved' FROM account WHERE provider IN \('twitter','telegram'\)/.test(st));
  check("the unique name is enforced by the database, not by a read",
    /CREATE UNIQUE INDEX IF NOT EXISTS oddie_profile_username_idx ON oddie_profile \(lower\(username\)\)/.test(store));
  const server = readFileSync("src/server.ts", "utf8");
  check("the profile routes exist", /app\.get\("\/api\/profile\/me"/.test(server) && /app\.post\("\/api\/profile"/.test(server)
    && /app\.get\("\/api\/profile\/check"/.test(server));
  check("...and saving needs a signed-in browser", /if \(!canonical\) return res\.status\(401\)\.json\(\{ error: "signed-out" \}\)/.test(server));
  const api = server.slice(server.indexOf('app.get("/api/notices"'), server.indexOf('app.post("/api/notices/seen"'));
  check("Activity names the other person only through their switch", /publicNameForWallet\(a\)/.test(api) && !/actor:/.test(api));
}

console.log("\nthe masthead chip (public/app/me.js), run against a pretend page");
{
  // Live on 8 Oct the first streamer to bet sent a screenshot: his wallet
  // connected, his bets on the profile, and the masthead still said "Sign in".
  const src = readFileSync("public/app/me.js", "utf8");
  class El {
    className = ""; href = ""; src = ""; alt = ""; children: Array<El | { textContent: string }> = []; private own = "";
    get textContent(): string { return this.own + this.children.map((c) => c.textContent).join(""); }
    set textContent(v: string) { this.own = String(v); this.children = []; }
    appendChild<T>(c: T): T { this.children.push(c as unknown as El); return c; }
    insertBefore<T>(c: T, ref: unknown): T { const i = this.children.indexOf(ref as El); this.children.splice(i < 0 ? this.children.length : i, 0, c as unknown as El); return c; }
  }
  const KEY = "22eK3nDoECWrvVx4skKofCg8ExE8rZD5WbmDyrvqNPEe";
  const pk = { toString: () => KEY };
  type Phantom = { isPhantom: boolean; isConnected: boolean; publicKey: unknown; on(ev: string, f: (k?: unknown) => void): void; connect(o: unknown): Promise<{ publicKey: unknown }> };
  async function page(me: unknown, solana?: Partial<Phantom> & { trusted?: boolean }): Promise<{ chip: El; fire: (ev: string, k?: unknown) => void }> {
    const bar = new El();
    const on: Record<string, (k?: unknown) => void> = {};
    const sol = solana && {
      isPhantom: true, isConnected: false, publicKey: null,
      on: (ev: string, f: (k?: unknown) => void) => { on[ev] = f; },
      connect: () => (solana.trusted ? Promise.resolve({ publicKey: pk }) : Promise.reject(new Error("User rejected the request."))),
      ...solana,
    };
    const answer = (url: string) => (url.startsWith("/api/auth/me") ? me : url.startsWith("/api/notices") ? { unseen: 0 } : { count: 0 });
    const ctx: Record<string, unknown> = {
      document: {
        querySelector: (q: string) => (q === ".top .wrap" ? bar : null),
        createElement: () => new El(),
        createTextNode: (t: string) => ({ textContent: t }),
        head: { appendChild: () => {} },
      },
      fetch: (url: string) => Promise.resolve({ json: () => Promise.resolve(answer(url)) }),
      OddieId: { get: () => "dev-test-1" },
      solana: sol,
    };
    ctx.window = ctx;
    runInNewContext(src, ctx);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    return { chip: bar.children[bar.children.length - 1] as El, fire: (ev, k) => on[ev]?.(k) };
  }
  const name = (c: El) => c.textContent;
  {
    const { chip } = await page({ accounts: [], profile: null });
    check("nobody: the chip asks to sign in", name(chip) === "Sign in" && chip.href === "/profile#accounts");
  }
  {
    const { chip } = await page({ accounts: [{ provider: "phantom", handle: "22eK…NPEe" }], profile: { username: null, avatar: "a3" } });
    check("signed in with a wallet only: its address and picture, not \"Sign in\"", name(chip) === "22eK…NPEe" && chip.href === "/profile"
      && chip.children.some((c) => c instanceof El && c.src === "/avatars/a3.webp"), name(chip));
  }
  {
    const { chip } = await page({ accounts: [{ provider: "phantom", handle: "22eK…NPEe" }, { provider: "twitter", handle: "bee_empir3" }], profile: { username: null, avatar: "a3" } });
    check("...an X name still wins over the wallet", name(chip) === "@bee_empir3", name(chip));
  }
  {
    const { chip } = await page({ accounts: [{ provider: "phantom", handle: "22eK…NPEe" }], profile: { username: "bee", avatar: "a3" } });
    check("...and so does an oddie name", name(chip) === "@bee", name(chip));
  }
  {
    const { chip } = await page({ accounts: [], profile: null }, { isConnected: true, publicKey: pk });
    check("not signed in, wallet connected on this page: the wallet, not \"Sign in\"", name(chip) === "22eK…NPEe" && chip.href === "/profile", name(chip));
  }
  {
    const { chip } = await page({ accounts: [], profile: null }, { trusted: true });
    check("a wallet this site is trusted by shows on any page, with no popup", name(chip) === "22eK…NPEe", name(chip));
  }
  {
    const { chip, fire } = await page({ accounts: [], profile: null }, { trusted: false });
    check("an untrusted wallet stays an ask", name(chip) === "Sign in", name(chip));
    fire("connect", pk);
    check("...until it connects on the page", name(chip) === "22eK…NPEe", name(chip));
    fire("disconnect");
    check("...and disconnecting asks again", name(chip) === "Sign in" && chip.href === "/profile#accounts", name(chip));
  }
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall profile checks passed.\n");
process.exit(failures ? 1 : 0);
