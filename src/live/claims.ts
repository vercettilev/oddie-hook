/**
 * `!oddie <claim>` in a stream's chat: the same door as tagging oddie on X or
 * Telegram, and the same machinery behind it. Anybody may knock; the claim is
 * read by the same extractor, passes the same gate, becomes a real market the
 * same way, and oddie's resolver settles it when it closes. Nobody in the
 * stream decides the result.
 *
 * THE CHANNEL IS THE OPENER. Whoever types the claim, the market is opened in
 * somebody's stream, and the streamer is the one who brought the room: every
 * market opened in their chat pays them its 2%, and the chat is told so
 * (Kick asks for that disclosure next to anything that pays the channel).
 *
 * One claim, one market (the message is the source); a person gets a few a
 * day, the channel's owner and moderators as many as they like.
 */
import type { Extraction } from "../matching/extractClaim.js";
import type { PriceClaim } from "../price/index.js";
import type { MintResult } from "../x/mentionLoop.js";
import type { ChatMessage } from "./calls.js";

export interface ChatMarketDeps {
  extract(text: string): Promise<Extraction>;
  existingMarket(sourceUrl: string): Promise<{ slug: string; question: string } | null>;
  openMarket(input: {
    question: string; closeInput: unknown; sourceUrl: string; category?: string;
    resolutionCriteria?: string | null; priceClaim?: PriceClaim | null; claimText?: string | null;
    resolvability?: string | null; hook?: string | null; openerId: string;
    /** The wallet the channel chose for its 2%, named from the mint on. */
    creatorWallet?: string | null;
  }): Promise<MintResult>;
  /** Where the opener's 2% goes, when they have chosen already. */
  payoutWallet?(openerId: string): Promise<string | null>;
  /** The idempotency ledger: true the first time a message is handled. */
  claim(key: string, author: string): Promise<boolean>;
  settle(key: string, outcome: "replied" | "skipped" | "failed", extra: { reason?: string; slug?: string; claimText?: string | null }): Promise<void>;
  openedToday(author: string): Promise<number>;
  dailyCap: number;
  /** The provenance marker for this message (see KICK_CHAT_SOURCE). */
  sourceFor(msg: ChatMessage): string;
  /** Answer in this chat, as a reply to the message when it can. */
  say(msg: ChatMessage, text: string): Promise<void>;
  baseUrl: string;
  log(line: string, extra?: Record<string, unknown>): void;
}

export const MARKET_COPY = {
  opened: (headline: string, url: string, channel: string) =>
    `Market open: "${headline}" Take YES or NO: ${url} (${channel} earns 2% of the pool)`,
  existing: (question: string, url: string) => `That one already has a market: "${question}" ${url}`,
  unmarketable: "I open markets on claims with a clear yes or no and a date. Try !oddie with one of those.",
  cap: (n: number) => `That's ${n} markets from you today. More tomorrow.`,
  later: "Try !oddie again in a minute and I'll open it.",
};

export async function openFromChat(msg: ChatMessage, claimText: string, deps: ChatMarketDeps): Promise<string> {
  const key = `${msg.platform}:${msg.channelId}:${msg.messageId}`;
  const author = `${msg.platform}:${msg.senderId}`;
  if (!(await deps.claim(key, author).catch(() => false))) return "already-handled";
  const base = deps.baseUrl.replace(/\/+$/, "");
  const channel = msg.channelSlug || "this channel";
  const sourceUrl = deps.sourceFor(msg);
  const text = claimText.slice(0, 4000);
  try {
    const already = await deps.existingMarket(sourceUrl).catch(() => null);
    if (already) {
      await deps.say(msg, MARKET_COPY.existing(already.question, `${base}/m/${already.slug}`));
      await deps.settle(key, "replied", { slug: already.slug, reason: "existing" });
      return "existing";
    }
    // The channel runs its own room; everybody else gets a few a day.
    if (!msg.canRun && deps.dailyCap > 0) {
      const n = await deps.openedToday(author).catch(() => 0);
      if (n >= deps.dailyCap) {
        await deps.say(msg, MARKET_COPY.cap(deps.dailyCap));
        await deps.settle(key, "skipped", { reason: "cap" });
        return "cap";
      }
    }
    const ex = await deps.extract(text);
    if (ex.resolvability === "unresolvable" || !ex.appropriate || !ex.question) {
      await deps.say(msg, MARKET_COPY.unmarketable);
      await deps.settle(key, "skipped", { reason: `gate:${ex.resolvability}`, claimText: text });
      return "unmarketable";
    }
    // The channel is the opener: its 2%, whoever typed the claim. A streamer
    // who linked a wallet already is named on the market from the start.
    const openerId = `${msg.platform}:${msg.channelId}`;
    const creatorWallet = deps.payoutWallet ? await deps.payoutWallet(openerId).catch(() => null) : null;
    const minted = await deps.openMarket({
      question: ex.question, closeInput: ex.close_time, sourceUrl, category: ex.category,
      resolutionCriteria: ex.resolution_criteria || null, priceClaim: ex.price_claim, claimText: text,
      resolvability: ex.resolvability, hook: ex.hook || null, openerId, creatorWallet,
    });
    if (!minted.ok) {
      const refused = minted.status >= 400 && minted.status < 500;
      await deps.say(msg, refused ? MARKET_COPY.unmarketable : MARKET_COPY.later);
      await deps.settle(key, refused ? "skipped" : "failed", { reason: `mint:${minted.status} ${minted.error}`, claimText: text });
      return refused ? "unmarketable" : "later";
    }
    /* THE CLAIM ALREADY HAD A MARKET, opened elsewhere. Nothing was opened
       here, so this chat is pointed at it and it is NOT recorded as opened:
       "opened" is what the daily cap counts and what this channel's list of
       its own markets reads, and the 2% stays with whoever really opened it. */
    if (minted.existed) {
      await deps.say(msg, MARKET_COPY.existing(minted.question || ex.question, `${base}/m/${minted.slug}`));
      await deps.settle(key, "replied", { slug: minted.slug, reason: "existing", claimText: text });
      return "existing";
    }
    const url = `${base}/m/${minted.slug}`;
    await deps.say(msg, MARKET_COPY.opened(ex.hook || ex.question, url, channel));
    // "opened" is what the daily cap counts.
    await deps.settle(key, "replied", { slug: minted.slug, reason: "opened", claimText: text });
    deps.log("market opened from chat", { platform: msg.platform, channel: msg.channelId, slug: minted.slug });
    return "market-opened";
  } catch (e) {
    await deps.say(msg, MARKET_COPY.later).catch(() => {});
    await deps.settle(key, "failed", { reason: (e as Error).message.slice(0, 300), claimText: text }).catch(() => {});
    deps.log("market from chat failed", { err: (e as Error).message });
    return "later";
  }
}
