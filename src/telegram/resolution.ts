/**
 * When a Telegram market settles, the group hears it.
 *
 * THE GAP THIS CLOSES. The X announcement answers the bot's own reply, found
 * through x_mention.reply_id. Telegram rows never carried one, so every
 * Telegram market settled in silence: the group that argued never learned who
 * was right, and the opener was never told a cut was waiting. Of every moment
 * in this product, that is the one that says "opening a market pays", in front
 * of the people most likely to open the next one.
 *
 * WHERE IT GOES. One message per group the market was announced in, as a reply
 * to the message that tagged the bot there. In the group where it was opened,
 * that is the opener's own message, and being replied to is what notifies
 * them, @name or not: a Telegram username is optional.
 *
 * WHAT IT SAYS. The rules of the X announcement: the result, the money state
 * in the same sentences, and never a bettor's name, side or size. The one
 * person named is the opener, only in the group where they opened it, only
 * when a cut is owed, and with the amount, because money is moving and the
 * words are literal.
 *
 * UNLIKE X, A MARKET NOBODY STAKED IS STILL ANNOUNCED. On X that post would sit
 * under a stranger's tweet saying our market was empty. In a group, the people
 * who asked are the audience, and "who was right" is the answer they asked for.
 * It carries the result and the link, and no money sentence at all.
 */
import { moneyLine } from "../x/resolutionReply.js";

export interface TgThread {
  chatId: number;
  messageId: number;
  /** The message that opened the market, as opposed to a later tag in another
   *  group that was answered with a pointer to it. */
  opened: boolean;
}

/** Ledger keys are `tg:<chat id>:<message id>`. Group ids are negative. */
export function parseTgKey(key: string): { chatId: number; messageId: number } | null {
  const m = /^tg:(-?\d+):(\d+)$/.exec(key);
  if (!m) return null;
  const chatId = Number(m[1]);
  const messageId = Number(m[2]);
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId) || messageId <= 0) return null;
  return { chatId, messageId };
}

/**
 * One thread per chat, from ledger rows oldest first. The chat where the
 * market was opened answers the opener's message; a chat that only received a
 * pointer answers the latest tag there.
 */
export function threadsFrom(rows: ReadonlyArray<{ key: string; reason: string | null }>): TgThread[] {
  const byChat = new Map<number, TgThread>();
  for (const r of rows) {
    const k = parseTgKey(r.key);
    if (!k) continue;
    if (byChat.get(k.chatId)?.opened) continue;
    byChat.set(k.chatId, { chatId: k.chatId, messageId: k.messageId, opened: r.reason === "opened" });
  }
  return [...byChat.values()];
}

/** SOL for a sentence: enough places that a small cut is not rounded away,
 *  and no trailing zeros. */
export function solText(lamports: number): string {
  const sol = lamports / 1e9;
  const s = sol >= 1 ? sol.toFixed(2) : sol >= 0.0001 ? sol.toFixed(4) : sol.toPrecision(2);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export interface TgOpenerCredit {
  handle: string | null;
  feeLamports: number;
  /** Whether the opener already chose a wallet. Decides where "collect" goes. */
  linked: boolean;
  collectUrl: string;
}

export function tgResolutionText(o: {
  outcome: "yes" | "no";
  /** Lamports in the vault. 0 means nobody staked; null means unreadable. */
  pool: number | null;
  /** Lamports on the side that won; null when unreadable. */
  won: number | null;
  marketUrl: string;
  opener?: TgOpenerCredit | null;
}): string {
  const parts = [`Settled: ${o.outcome.toUpperCase()}.`];
  // No stakes, no money sentence: "every stake goes back in full" about a
  // market nobody staked would be a sentence about money that does not exist.
  const money = o.pool === 0 ? null : moneyLine(o.won);
  if (money) parts.push(money);
  const c = o.opener;
  if (c && c.feeLamports > 0) {
    const who = c.handle ? `@${c.handle.replace(/^@+/, "")}, you` : "You";
    const how = c.linked ? "Collect it on your profile" : "Choose the wallet it goes to";
    parts.push(`${who} opened this market and earned ${solText(c.feeLamports)} SOL. ${how}: ${c.collectUrl}`);
  }
  parts.push(o.marketUrl);
  return parts.join("\n\n");
}

export interface TgResolutionDeps {
  dryRun: boolean;
  /** Public origin of the app, for the market link and the profile. */
  appBaseUrl: string;
  /** For the deep link that starts the collect flow in a private chat. */
  botUsername: string | null;
  /** Every Telegram ledger row that answered a tag with this market. */
  threads(slug: string): Promise<Array<{ key: string; reason: string | null }>>;
  opener(slug: string): Promise<{ handle: string | null; linked: boolean } | null>;
  /** The vault after the verdict is on chain, or null when it cannot be read.
   *  A market never minted, or already closed, is all zeros. */
  vault(slug: string, outcome: "yes" | "no"): Promise<{ pool: number; won: number; creatorFee: number } | null>;
  /** A card image URL that shows the verdict. */
  cardUrl(slug: string, outcome: "yes" | "no"): string;
  send(o: { chatId: number; replyTo: number; text: string; photoUrl: string | null }): Promise<void>;
  log(line: string, extra?: Record<string, unknown>): void;
}

export interface TgResolutionOutcome {
  posted: number;
  failed: number;
  /** Set when nothing was attempted. */
  skipped?: "no-thread" | "dry-run";
  texts: string[];
}

/**
 * Announce the result in every group this market was announced in.
 *
 * Best-effort throughout, like the X announcement: the money has already moved
 * by the time this runs, so Telegram being unreachable must never hold up or
 * undo a resolution. A group that refuses the message does not stop the next.
 */
export async function postTelegramResolution(
  slug: string, outcome: "yes" | "no", deps: TgResolutionDeps,
): Promise<TgResolutionOutcome> {
  const threads = threadsFrom(await deps.threads(slug).catch(() => []));
  if (!threads.length) return { posted: 0, failed: 0, skipped: "no-thread", texts: [] };

  const base = deps.appBaseUrl.replace(/\/+$/, "");
  const marketUrl = `${base}/m/${slug}`;
  const [vault, opener] = await Promise.all([
    deps.vault(slug, outcome).catch(() => null),
    deps.opener(slug).catch(() => null),
  ]);
  // A linked opener collects on the profile. One who never chose a wallet
  // starts in a private chat, where the link that binds a wallet is issued to
  // them alone: never a token URL in a group.
  const collectUrl = opener?.linked || !deps.botUsername
    ? `${base}/profile`
    : `https://t.me/${deps.botUsername}?start=earn`;

  const out: TgResolutionOutcome = { posted: 0, failed: 0, texts: [] };
  for (const t of threads) {
    const credit = t.opened && opener && vault && vault.creatorFee > 0
      ? { handle: opener.handle, feeLamports: vault.creatorFee, linked: opener.linked, collectUrl }
      : null;
    const text = tgResolutionText({
      outcome, pool: vault ? vault.pool : null, won: vault ? vault.won : null, marketUrl, opener: credit,
    });
    out.texts.push(text);
    if (deps.dryRun) {
      deps.log("resolution dry-run", { slug, outcome, chatId: t.chatId, replyTo: t.messageId, text });
      continue;
    }
    try {
      await deps.send({ chatId: t.chatId, replyTo: t.messageId, text, photoUrl: deps.cardUrl(slug, outcome) });
      out.posted++;
      deps.log("resolution posted", { slug, outcome, chatId: t.chatId, credited: Boolean(credit) });
    } catch (e) {
      out.failed++;
      deps.log("resolution: send failed", { slug, chatId: t.chatId, err: (e as Error).message });
    }
  }
  if (deps.dryRun) out.skipped = "dry-run";
  return out;
}
