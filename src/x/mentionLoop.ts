/**
 * The loop that closes the product: a mention on X becomes a market on Solana
 * and a reply under the argument that started it, with nobody in the middle.
 *
 * Everything the loop touches arrives as an injected dependency rather than an
 * import. That is not ceremony: the real versions of these call X, call
 * Anthropic, and spend SOL, so a version of this file that imported them could
 * only be tested by doing all three. With the seams here, the entire decision
 * tree runs offline against fakes, which is the only way the "don't post twice"
 * rules below are actually checked rather than merely written down.
 *
 * ORDER OF OPERATIONS, and why it is this order:
 *
 *   claim -> extract -> mint -> reply -> settle
 *
 * The claim comes first and is durable. A crash anywhere after it leaves a row
 * saying "someone was working on this" and the next sweep skips the tweet. That
 * loses a reply. The alternative order loses nothing on a crash and instead
 * risks replying twice to the same person, which is the one failure that
 * damages the account rather than the backlog. Under-posting is recoverable by
 * hand; double-posting is not.
 */

import type { Extraction } from "../matching/extractClaim.js";
import type { PriceClaim } from "../price/index.js";
import type { Mention } from "./client.js";
import { buildRefusalReply, buildTweetReply } from "../matching/tweetReply.js";
import { claimMention, settleMention, botStateGet, botStateSet, PERSISTENT } from "../store/markets.js";
import { SINCE_KEY } from "./client.js";

export interface MintedMarket {
  ok: true;
  slug: string;
}
export type MintResult = MintedMarket | { ok: false; status: number; error: string };

export interface SweepDeps {
  /** Read mentions newer than `sinceId`. */
  mentions(sinceId: string | null, max?: number): Promise<{ items: Mention[]; newestId: string | null }>;
  /** Read one tweet, for the parent claim a mention is replying to. It carries
   *  its own parent id so the loop can walk up a thread when two posts did not
   *  name the subject; absent means "stop climbing here". */
  tweet(id: string): Promise<{ id: string; text: string; authorHandle: string | null; repliedToId?: string | null } | null>;
  extract(text: string): Promise<Extraction>;
  /** An OPEN market already made from this source post, if there is one. */
  existingMarket?(sourceUrl: string): Promise<{ slug: string; question: string } | null>;
  openMarket(input: {
    question: string;
    closeInput: unknown;
    sourceUrl: string;
    /** Who tagged, i.e. who OPENED the market. The 2% goes to this person, and
     *  on a reply-tag it is not the author of sourceUrl. */
    taggerHandle: string | null;
    category?: string;
    resolutionCriteria?: string | null;
    /** Set when the tag was about a token's price. The opener pins the ticker to
     *  a specific mint; this loop only carries what the model read. */
    priceClaim?: PriceClaim | null;
    /** The words this was graded from, carried only so an address in the tweet
     *  can pin the token instead of a ticker being guessed at. */
    claimText?: string | null;
    resolvability?: string | null;
    /** The extraction's short headline, carried so the app can show the same
     *  punchy line this loop already puts in the reply. */
    hook?: string | null;
  }): Promise<MintResult>;
  /** The share card for a market, as PNG bytes. */
  cardPng(slug: string): Promise<Buffer | null>;
  /**
   * The card that goes under a tag we could not price: what a marketable claim
   * looks like, not a scolding. Optional, and its absence is what keeps the
   * gate silent — every existing caller and test that never heard of teaching
   * behaves exactly as it did before.
   */
  teachPng?(): Promise<Buffer | null>;
  /** How many teaching replies this handle has already had. Only consulted when
   *  there is no season wired at all; with tickets running, the ticket book IS
   *  the cap. */
  refusalsUsed?(handle: string | null): Promise<number>;
  /** Charge a tag that we answered but could not turn into a market. Called
   *  AFTER the reply is posted, never before. Optional, so a caller that never
   *  heard of the season behaves as before. */
  spendMiss?(tweetId: string, handle: string): Promise<{ spent: boolean; left: number }>;
  /** Have we already pointed this handle at this market? The only bound on the
   *  branch that answers the second, third and tenth person to tag one post. */
  alreadyTold?(handle: string, slug: string): Promise<boolean>;
  uploadMedia(png: Buffer): Promise<string>;
  postReply(opts: { text: string; inReplyTo: string; mediaIds?: string[] }): Promise<{ id: string }>;
  /** Our own handle, without the @. Used only to strip routing out of the
   *  claim text; defaults to oddiefun. */
  botHandle?: string;
  /** Tickets left for a handle, and the spend when a tag opens a market. Both
   *  optional so every existing caller and test constructs SweepDeps unchanged;
   *  absent, the sweep behaves exactly as it did before the season existed. */
  ticketsLeft?(handle: string): Promise<number>;
  spendTicket?(slug: string, tagger: string, source: string | null): Promise<boolean>;
  /** Public origin, for building the /m/{slug} permalink the reply carries. */
  baseUrl: string;
  /** The bot's own user id, so it can never answer itself. */
  botUserId: string;
  /** When true, everything runs except the two calls that touch the world. */
  dryRun: boolean;
  /**
   * Whether the once-only ledger actually survives a restart. Defaults to the
   * store's own answer; it is a seam only so the offline test can drive the
   * real posting path AND still assert that the guard fires when it is false.
   */
  durable?: boolean;
  log?(line: string, extra?: Record<string, unknown>): void;
}

export interface SweepResult {
  looked: number;
  replied: number;
  skipped: number;
  failed: number;
  /** Left for the next sweep because the WORLD failed, not the claim. */
  retried: number;
  /** What each mention became, in order. The dry-run output, and the test's assertion surface. */
  decisions: Array<{
    tweetId: string;
    outcome: "replied" | "skipped" | "failed" | "retry";
    reason?: string;
    slug?: string;
    text?: string;
  }>;
  newestId: string | null;
}

/**
 * How many mentions one sweep will act on.
 *
 * Low on purpose, and the reason is money rather than rate limits: every
 * mention that clears the gate mints a Solana account out of oddie's own
 * wallet. A thread that tags us two hundred times should drain over an hour of
 * polls, not spend two hundred rent deposits in one tick, and a runaway is
 * bounded by this number times the poll rate rather than by whatever X returns.
 */
export const SWEEP_CAP = 5;

/* How far up a reply chain we will walk when two posts did not name the
   subject. Three, by Lev's call: deep enough for an argument that started a few
   replies back, shallow enough that a long unrelated thread cannot bury the
   claim the tagger actually pointed at. Only ever spent on an unresolvable
   grade, so the normal path reads one parent and stops. */
export const MAX_CLIMB = 3;

/**
 * The teaching cap FOR A CALLER WITH NO SEASON WIRED, and nothing else.
 *
 * It used to be the live rule, running alongside a second counter that charged
 * a tag whether or not we answered. Two counters that disagree is one counter
 * too many: replies stopped at two, charges ran to five, and the gap was three
 * tags taken in silence. There is one counter now and it is the ticket book —
 * a reply spends a tag, a tag buys a reply, five of them, and the sixth tag
 * meets the gate at the top of the sweep before anything reads it.
 *
 * This survives for the case where `ticketsLeft` is absent or its ledger threw:
 * no balance to count down, and something still has to stop us posting under a
 * stranger's tweet forever. Deliberately far below five, because an unbounded
 * version of this branch is how an account gets muted, and a muted account ends
 * the product.
 */
export const TEACH_CAP = 2;

/** Strip the @handles X puts at the front of a reply, so the claim text we
 *  grade is the sentence and not the routing. */
export function stripLeadingMentions(text: string): string {
  return text.replace(/^(?:\s*@[A-Za-z0-9_]{1,15})+/, "").trim();
}

/**
 * Take OUR OWN handle out of the claim, wherever it sits.
 *
 * Tagging does not have to be a reply, and in a standalone post the tag
 * usually lands at the END ("GTA drops before 2027, what do you say
 * @oddiefun"). stripLeadingMentions only looks at the front, so that handle
 * went into the grader as if it were part of the argument.
 *
 * ONLY our handle, never a blanket trailing strip: a mention at the end can be
 * the subject of the claim itself ("the next CEO will be @jack"), and removing
 * it would grade a sentence with its subject cut out.
 */
export function stripBotHandle(text: string, handle: string): string {
  const h = handle.replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) return text;
  return text.replace(new RegExp(`@${h}\\b`, "gi"), " ").replace(/\s{2,}/g, " ").trim();
}

/** Tweets are addressed by handle in the URL, but any handle resolves; the id
 *  is what makes it canonical. `i/web` is X's own handle-free form. */
export function tweetUrl(handle: string | null, id: string): string {
  return handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/web/status/${id}`;
}

export async function runMentionSweep(deps: SweepDeps): Promise<SweepResult> {
  const log = deps.log ?? (() => {});
  const result: SweepResult = { looked: 0, replied: 0, skipped: 0, failed: 0, retried: 0, decisions: [], newestId: null };
  /** The position of the earliest tweet this sweep means to pick back up. The
   *  watermark must not move past it or X will never serve that mention again
   *  and the retry would be a retry in name only. */
  let retryFrom: number | null = null;
  /** What the cap actually counts: mentions that reached real work. A row we
   *  already decided costs one indexed lookup and mints nothing, and counting
   *  those was how a held watermark could starve the tweet it was held for. */
  let acted = 0;

  // Posting for real without a database would mean the "exactly once" ledger
  // and the rotated refresh token both live in a map that dies with the
  // process. That is not a degraded mode, it is the double-post mode.
  if (!deps.dryRun && !(deps.durable ?? PERSISTENT)) {
    throw new Error("refusing to post: DATABASE_URL is unset, so the once-only ledger would not survive a restart");
  }

  const sinceId = await botStateGet(SINCE_KEY);
  const { items, newestId } = await deps.mentions(sinceId, 20);
  result.newestId = newestId;
  // Oldest first. X returns newest first, and answering a thread backwards
  // reads as a bot even when every individual reply is right.
  const ordered = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (let idx = 0; idx < ordered.length; idx++) {
    const m = ordered[idx];
    if (acted >= SWEEP_CAP) break;
    result.looked++;

    const decide = (outcome: "replied" | "skipped" | "failed" | "retry", extra: Record<string, unknown> = {}) => {
      if (outcome === "replied") result.replied++;
      else if (outcome === "skipped") result.skipped++;
      else if (outcome === "retry") {
        result.retried++;
        if (retryFrom === null) retryFrom = idx;
      } else result.failed++;
      result.decisions.push({ tweetId: m.id, outcome, ...extra } as SweepResult["decisions"][number]);
    };

    if (m.authorId === deps.botUserId) {
      // Our own replies mention the people we answer, which means they come
      // back to us as mentions. Without this the bot answers itself forever.
      await claimMention(m.id, m.authorHandle);
      await settleMention(m.id, "skipped", { reason: "self" });
      decide("skipped", { reason: "self" });
      continue;
    }

    const fresh = await claimMention(m.id, m.authorHandle);
    if (!fresh) { decide("skipped", { reason: "already-decided" }); continue; }
    acted++;

    /* DID WE ALREADY HAND X A POST FOR THIS TWEET?
       The one failure this file calls unrecoverable is double-posting, and a
       retry is exactly how that happens: postReply throwing does NOT mean the
       post did not land, because a timeout on a successful write throws too.
       So the moment we hand X a reply this tweet stops being retryable, and
       everything that fails before that point stays retryable. */
    let postAttempted = false;

    try {
      /* THE TICKET GATE, AND IT RUNS BEFORE ANYTHING ELSE.
         A reply costs a tag and silence costs nothing, so at zero tags there is
         nothing left to buy and no work worth paying for. It sits above the
         parent read, above the duplicate lookup, above the model call and above
         the mint: an exhausted handle now costs us nothing at all rather than
         an X read and a card render.
         The balance is read ONCE here and carried down, because all three
         branches below have to print what this tag leaves behind, and reading
         it again after the charge would print a number one lower than the one
         the person actually has. */
      let balance: number | null = null;
      if (deps.ticketsLeft && m.authorHandle) {
        // A ledger that throws must never stop the bot answering. Null means
        // "unknown", which downstream reads as "say no number" rather than as
        // "say zero" — and the spend itself is what enforces the real floor.
        balance = await deps.ticketsLeft(m.authorHandle).catch(() => null);
        if (balance !== null && balance <= 0) {
          await settleMention(m.id, "skipped", { reason: "no-tickets" });
          decide("skipped", { reason: "no-tickets" });
          continue;
        }
      }
      /** What this tag leaves them once it is paid for. Null when no season is
       *  wired or the ledger could not be read: a sentence about somebody's
       *  remaining chances has to be true or it must not be said. */
      const tagsLeft = balance === null ? null : Math.max(0, balance - 1);

      /* WHAT WE GRADED, CARRIED TO THE LEDGER.
         A refusal row said "gate:unresolvable" and nothing about the sentence,
         so the only way to ask whether a refusal was right was to re-read the
         post: an X call each, the bot's rotating credentials, and nothing at
         all once somebody deletes it. Twelve refusals in a row is exactly when
         that question gets asked, and exactly when it could not be answered.
         Carried on every outcome that followed a grading, a market included:
         the question the engine wrote is only checkable against the sentence it
         was given. Null before that, because a tag we refused for being our own
         or for having no tickets was never graded. */
      let graded: string | null = null;

      /* THE TEACHING REPLY, REACHED FROM TWO PLACES NOW.
         It used to live inside the extraction gate and could therefore only
         answer a claim the model had read. The other caller is the one this
         file used to drop on the floor without a word: a tag under a post with
         no text in it at all. That person gets the identical lesson, and it is
         the cheapest reply in the product because no model was ever called.
         `why` is recorded on the row and is load-bearing: refusalsUsed counts
         rows whose reason starts with "taught". */
      const teach = async (why: string): Promise<void> => {
        const teachPng = deps.teachPng;
        if (!teachPng) {
          await settleMention(m.id, "skipped", { reason: `gate:${why}`, claimText: graded });
          decide("skipped", { reason: `gate:${why}` });
          return;
        }

        /* TEACH, THEN GO QUIET, AND THE TICKET BOOK IS WHAT DECIDES WHEN.
           The tagger went to the trouble; silence teaches them nothing and they
           tag us the same wrong way next time. But an account that answers
           every unmarketable tag forever is an account that gets muted, and a
           muted account ends the product, so the answering has to stop
           somewhere. It used to stop at two while the charging ran to five,
           which is how three tags got taken after we had gone quiet.
           One counter now, and it is the balance read at the top of this item:
           five tags, five answers, the fifth one saying it was the last, and
           the sixth tag meeting the gate before the model ever reads it.
           TEACH_CAP is the floor for a caller with no season at all — no
           balance to count down, and something still has to stop us. */
        if (balance === null) {
          const used = deps.refusalsUsed ? await deps.refusalsUsed(m.authorHandle).catch(() => TEACH_CAP) : 0;
          if (used >= TEACH_CAP) {
            await settleMention(m.id, "skipped", { reason: `gate:${why}/taught-out`, claimText: graded });
            decide("skipped", { reason: "taught-out" });
            return;
          }
        }

        const teachText = buildRefusalReply(m.id, tagsLeft);
        if (deps.dryRun) {
          await settleMention(m.id, "skipped", { reason: "dry-run" });
          decide("skipped", { reason: "dry-run:teach", text: teachText });
          log("dry-run teach reply", { tweetId: m.id, text: teachText });
          return;
        }

        /* THE CARD IS THE REPLY. The text is one sentence and it says only that
           we could not open a market; every word of the teaching - the specimen
           claim, the two spans underlined on it, the way back in - is drawn on
           the image. So a failed upload does not downgrade this reply, it
           empties it, and what would go out is the bare public refusal this
           whole branch exists to avoid posting.
           SILENCE IS THE RIGHT POST AND THE WRONG ENDING. It used to be both:
           the row was settled and that tag was never looked at again, so a
           media upload that 403'd once cost somebody an answer permanently.
           A renderer and an upload endpoint are the world, not a verdict on the
           claim, so this leaves the tweet for the next sweep instead. */
        let mediaIds: string[];
        try {
          const png = await teachPng();
          if (!png) throw new Error("no card");
          mediaIds = [await deps.uploadMedia(png)];
        } catch (e) {
          await settleMention(m.id, "retry", { reason: `no-card:${why}` });
          decide("retry", { reason: "no-card" });
          log("teach card unavailable, leaving the tag for the next sweep",
            { tweetId: m.id, err: (e as Error).message });
          return;
        }
        // No permalink, ever. There is no market to link to, and a reply
        // carrying a URL is priced at a different tier by X than a plain one.
        postAttempted = true;
        const posted = await deps.postReply({ text: teachText, inReplyTo: m.id, mediaIds });
        /* CHARGED HERE, AFTER THE POST, AND NOWHERE ELSE.
           Lev's rule, in one line: nothing is spent that we did not answer.
           Every exit above this point now ends free — the content refusal, the
           card that would not render, the upload that failed, the dry run, the
           handle we could not read — which is the only reading of "a tag buys a
           reply" that survives its own failure cases. The charge is idempotent
           on the tweet id, so a sweep that dies between the post and this line
           cannot bill twice on the retry; and if the charge itself fails they
           simply keep the tag, which is the direction to fail in. */
        if (deps.spendMiss && m.authorHandle) {
          await deps.spendMiss(m.id, m.authorHandle).catch((e) =>
            log("miss charge failed, they keep the tag", { tweetId: m.id, err: (e as Error).message }));
        }
        // "taught" is the marker refusalsUsed counts, so the reason string is
        // load-bearing rather than a log line.
        await settleMention(m.id, "skipped", { reason: `taught:${why}`, replyId: posted.id, claimText: graded });
        decide("skipped", { reason: "taught", text: teachText });
        log("taught instead of staying silent", { tweetId: m.id, handle: m.authorHandle, tagsLeft });
      };

      // The claim is the tweet being replied to, not the mention. "@oddiefun"
      // under someone's take means "price THAT", and grading the mention text
      // would grade the word "@oddiefun".
      const bot = deps.botHandle ?? "oddiefun";
      const parent = m.repliedToId ? await deps.tweet(m.repliedToId) : null;
      const parentText = parent ? stripBotHandle(parent.text, bot).trim() : "";
      // Tagging is not required to be a reply. With no parent the mention IS
      // the claim, so the person's own post becomes the market.
      const ownText = stripBotHandle(stripLeadingMentions(m.text), bot).trim();

      /* THE ARGUMENT IS BOTH POSTS, NOT WHICHEVER ONE WE PICKED.
         This was an either/or: the parent won whenever it had twelve
         characters, and the tagger's own sentence was thrown away. Measured on
         the live case that reported this, "Just buy Bitcoin." under a video,
         tagged with "I don't think it will hit 100k this year": the parent
         alone grades unresolvable ("general investment advice, no threshold or
         timeframe"), the mention alone grades unresolvable ("never says what
         'it' is"), and the two together grade CLEAN, because the parent names
         the subject and the tagger names the threshold and the date. That is
         the ordinary shape of a disagreement, and we were dropping half of it.
         The engine was always built for this: its own first line says it
         converts "a tweet, or a few tweets of a disagreement".
         Either alone still works: a bare "@oddiefun price this" is too short to
         reach the model, and a photo parent leaves the mention standing. */
      const usable = (t: string) => t.length >= 12;
      const onParent = usable(parentText);
      const withOwn = usable(ownText);
      const claimText = onParent && withOwn && parent
        ? `@${parent.authorHandle}: ${parentText}\n\n@${m.authorHandle}: ${ownText}`
        : onParent ? parentText : ownText;
      graded = claimText.slice(0, 2000);
      if (!usable(claimText)) {
        /* NOTHING TO PRICE ANYWHERE, and that used to be the end of it: settled,
           silent, never explained, and free. Free was right and silent was not.
           This is the likeliest first tag a newcomer ever sends — a bare
           @oddiefun under a picture — and it is the one we answered least. */
        await teach("no-claim");
        continue;
      }

      // Provenance points at the CLAIM: sourceUrl is the post being priced and
      // it is what the card quotes and what the one-post-one-market rule reads.
      // It is NOT the payee. The 2% goes to whoever OPENED the market, which on
      // a reply-tag is the tagger, and that handle is carried separately.
      // It also has to follow the text we ACTUALLY graded: when the fallback
      // above priced the mention, the parent is not the source of anything.
      const sourceHandle = onParent && parent ? parent.authorHandle : m.authorHandle;
      const sourceId = onParent && parent ? parent.id : m.id;
      const sourceUrl = tweetUrl(sourceHandle, sourceId);

      // ONE POST, ONE MARKET. Checked before a token is spent, because several
      // people tagging the same hot take is the expected case: the model is not
      // needed to know we already answered this post, and minting again would
      // split one question's pool across two pari-mutuel markets while costing
      // a second rent deposit out of our own wallet.
      const already = deps.existingMarket ? await deps.existingMarket(sourceUrl).catch(() => null) : null;
      if (already) {
        /* ONE ANSWER PER PERSON PER MARKET.
           This branch stays FREE, and that is a deliberate exception to "a
           reply costs a tag". Forty people tagging the same hot take is the
           distribution model rather than an abuse of it: they opened nothing,
           they earn nothing, and charging each of them a fifth of their season
           for a pointer would tax the one behaviour we most want. What had to
           go is the other half of free — unbounded. The same handle tagging the
           same post ten times got ten near-identical replies out of us, on the
           only branch in this sweep with no per-handle limit of any kind, in
           exactly the shape X's automation policy calls duplicative. */
        if (deps.alreadyTold && m.authorHandle) {
          const told = await deps.alreadyTold(m.authorHandle, already.slug).catch(() => false);
          if (told) {
            await settleMention(m.id, "skipped", { reason: "already-told", slug: already.slug });
            decide("skipped", { reason: "already-told", slug: already.slug });
            continue;
          }
        }
        const permalink = `${deps.baseUrl.replace(/\/+$/, "")}/m/${already.slug}`;
        const reply = buildTweetReply({ question: already.question, permalink, hook: "" });
        if (deps.dryRun) {
          await settleMention(m.id, "skipped", { reason: "dry-run", slug: already.slug });
          decide("skipped", { reason: "dry-run:existing", slug: already.slug, text: reply.primary });
          log("dry-run reply to an existing market", { tweetId: m.id, slug: already.slug });
          continue;
        }
        // Each person who tagged still gets an answer; they just all land in the
        // same pool.
        let mediaIds: string[] | undefined;
        try {
          const png = await deps.cardPng(already.slug);
          if (png) mediaIds = [await deps.uploadMedia(png)];
        } catch (e) {
          log("card failed, replying without it", { tweetId: m.id, err: (e as Error).message });
        }
        postAttempted = true;
        const posted = await deps.postReply({ text: reply.primary, inReplyTo: m.id, mediaIds });
        await settleMention(m.id, "replied", { slug: already.slug, replyId: posted.id, claimText: graded });
        decide("replied", { reason: "existing", slug: already.slug, text: reply.primary });
        log("replied with the market this post already has", { tweetId: m.id, slug: already.slug });
        continue;
      }

      // Capped for the same reason the admin route caps at 4000: the parent's
      // full text goes into an opus prompt with adaptive thinking, and X's post
      // limit is not our budget. A long-form post was a ~6k-token user message
      // on a call that already carries a 1.5k-token system prompt.
      let ex = await deps.extract(claimText.slice(0, 4000));

      /* WHEN TWO POSTS DID NOT NAME THE THING, WALK UP THE THREAD.
         The parent usually carries the subject and the tagger carries the
         threshold, but in a longer argument the subject can sit further up, and
         a claim about "it" is unresolvable for exactly that reason. So on an
         unresolvable grade, and only then, climb the reply chain and ask ONCE
         more with the fuller thread.
         Once, not once per level: fetching three ancestors and asking again is
         one extra model call, where asking after each fetch would be three, and
         the model call is the expensive half. Reads are cheap by comparison and
         X charges a resource once per day however often it is asked for.
         The climb is gated on unresolvable, so a claim that already graded
         clean is never handed extra context it could be distracted by — this
         module's whole bias is precision over recall. An inappropriate grade
         does not climb either: more context cannot make a subject allowed. */
      if (ex.resolvability === "unresolvable" && ex.appropriate && onParent && parent) {
        const above: string[] = [];
        let cursor: string | null = parent.repliedToId ?? null;
        for (let up = 0; up < MAX_CLIMB && cursor; up++) {
          const a = await deps.tweet(cursor).catch(() => null);
          if (!a) break;
          const t = stripBotHandle(a.text, bot).trim();
          if (usable(t)) above.unshift(`@${a.authorHandle ?? "someone"}: ${t}`);
          cursor = a.repliedToId ?? null;
        }
        if (above.length > 0) {
          const deeper = `${above.join("\n\n")}\n\n${claimText}`;
          graded = deeper.slice(0, 2000);
          const retry = await deps.extract(deeper.slice(0, 4000));
          log("climbed the thread for context", {
            tweetId: m.id, levels: above.length, was: ex.resolvability, now: retry.resolvability,
          });
          ex = retry;
        }
      }

      if (ex.resolvability === "unresolvable" || !ex.appropriate || !ex.question) {
        // INAPPROPRIATE IS ALWAYS SILENT. There is no version of a public reply
        // under a post we refused on content grounds that reads as anything but
        // oddie commenting on it, and the reason is recorded where we can read
        // it instead. Never charged either: a silent bill for a judgement we
        // will not defend is the one version of this rule that is unfair.
        if (!ex.appropriate) {
          await settleMention(m.id, "skipped", { reason: `gate:${ex.resolvability}/inappropriate`, claimText: graded });
          decide("skipped", { reason: `gate:${ex.resolvability}` });
          continue;
        }
        await teach(ex.resolvability);
        continue;
      }

      /* A DRY RUN THAT MINTS IS NOT A DRY RUN.
         This check used to sit four steps lower, under the mint and under the
         ticket spend, on the reading that the only thing worth suppressing was
         the post. It was not. Reaching this line spends a rent deposit out of
         oddie's own wallet, creates a market that is real and stakeable and
         appears in the public list, and burns one of the tagger's five season
         tickets - and then says nothing, so the person who paid the ticket is
         never told the market exists and cannot find it. That is the worst
         possible combination: every cost of a live bot with none of its effect.
         So the dry run now stops BEFORE the world changes. What it reports is
         the extraction and the reply it would have sent; the slug is the one
         thing it cannot know, because openMarket is what mints it. */
      if (deps.dryRun) {
        const wouldSay = buildTweetReply({
          question: ex.question,
          permalink: `${deps.baseUrl.replace(/\/+$/, "")}/m/<slug>`,
          hook: ex.hook,
          // The count too, or the dry run stops being a preview of the reply
          // exactly where the reply started saying something new.
          tagsLeft,
        });
        await settleMention(m.id, "skipped", { reason: "dry-run" });
        decide("skipped", { reason: "dry-run", text: wouldSay.primary });
        log("dry run: would open a market and reply", { tweetId: m.id, question: ex.question, text: wouldSay.primary });
        continue;
      }

      const minted = await deps.openMarket({
        taggerHandle: m.authorHandle,
        question: ex.question,
        closeInput: ex.close_time,
        sourceUrl,
        category: ex.category,
        resolutionCriteria: ex.resolution_criteria || null,
        priceClaim: ex.price_claim,
        claimText: graded,
        resolvability: ex.resolvability,
        hook: ex.hook || null,
      });
      if (!minted.ok) {
        /* THE EXPENSIVE SILENCE, AND IT WAS TERMINAL.
           The claim was good. We read the tweet, paid for the extraction, and
           then Solana was unreachable or the wallet was dry — and the row was
           settled `failed`, which meant that tweet was never looked at again.
           A real market, lost, with nobody told anything. Nothing was posted
           here, provably, so picking it back up cannot double-post; what a
           retry costs is one more extraction, which is why it is bounded at
           three goes rather than left to run. */
        await settleMention(m.id, "retry", { reason: `mint:${minted.status} ${minted.error}`, claimText: graded });
        decide("retry", { reason: `mint:${minted.status}` });
        log("mint failed, leaving the tag for the next sweep",
          { tweetId: m.id, status: minted.status, error: minted.error });
        continue;
      }

      const permalink = `${deps.baseUrl.replace(/\/+$/, "")}/m/${minted.slug}`;
      // No yesPct: a market minted a second ago has an empty vault and
      // therefore no price. The reply says nothing about odds rather than
      // quoting a 50 nobody set.
      /* THE COUNT GOES ON THE GOOD NEWS TOO.
         The tag was charged either way, and a reply that spends somebody's
         ticket without mentioning it is silent charging with a market attached
         — the same fault as the silence this whole rule was written to remove,
         just wearing a nicer outfit. It also happens to be the only surface in
         the product where the refund rule can be stated as an instruction
         rather than as documentation: under a market they just opened, "one new
         bettor here brings it back" is something they can go and do. */
      const reply = buildTweetReply({ question: ex.question, permalink, hook: ex.hook, tagsLeft });


      // The card is the thing that stops a scroll, but a reply with no card is
      // still a working reply. An image failure must not cost the market a
      // reply it already paid rent for.
      let mediaIds: string[] | undefined;
      try {
        const png = await deps.cardPng(minted.slug);
        if (png) mediaIds = [await deps.uploadMedia(png)];
      } catch (e) {
        log("card failed, replying without it", { tweetId: m.id, err: (e as Error).message });
      }

      postAttempted = true;
      const posted = await deps.postReply({ text: reply.primary, inReplyTo: m.id, mediaIds });
      /* AFTER THE POST, like the miss branch and for the same reason. It used
         to sit directly under the mint, on the reading that the market existing
         is what the ticket bought. But a market nobody was told about is a
         market its own opener cannot find, and charging for one is charging for
         our failure to post. The mint stands either way; the market is theirs,
         it is on their profile, and it stays uncharged until the reply that
         announces it actually goes out. */
      if (deps.spendTicket && m.authorHandle) {
        await deps.spendTicket(minted.slug, m.authorHandle, sourceHandle).catch((e) =>
          log("ticket spend failed (market still stands)", { tweetId: m.id, err: (e as Error).message }));
      }
      await settleMention(m.id, "replied", { slug: minted.slug, replyId: posted.id, claimText: graded });
      decide("replied", { slug: minted.slug, text: reply.primary });
      log("replied", { tweetId: m.id, slug: minted.slug, replyId: posted.id });
    } catch (e) {
      /* WHERE IT THREW IS THE WHOLE QUESTION.
         Before we handed X anything, a throw is the world failing — the tweet
         read, the model, the store — and the tweet deserves another go, because
         the alternative is what this branch used to do: swallow a good claim on
         one bad minute and never look at it again.
         After we handed X a reply, it is terminal and stays terminal. A
         postReply that throws has NOT proved the post did not land (a timeout
         on a successful write throws exactly the same way), and re-posting is
         the one failure this file treats as unrecoverable. */
      const outcome = postAttempted ? "failed" : "retry";
      await settleMention(m.id, outcome, { reason: (e as Error).message.slice(0, 300) });
      decide(outcome, { reason: (e as Error).message.slice(0, 120) });
      /* THE BODY, NOT JUST THE STATUS. "x POST /tweets -> 403" says a request
         was refused and nothing about why, and X always explains itself in the
         response body: duplicate content, a permission the app lacks, a reply
         the policy forbids. XError carries that body and we were dropping it at
         the log, which is how a 403 becomes unfixable rather than merely
         annoying. Truncated because an X error body can carry a long errors[]. */
      const detail = (() => {
        const body = (e as { body?: unknown }).body;
        if (body == null) return undefined;
        try { return JSON.stringify(body).slice(0, 400); } catch { return String(body).slice(0, 400); }
      })();
      log(postAttempted ? "sweep item failed after posting, not retrying" : "sweep item failed before posting, will retry",
        { tweetId: m.id, err: (e as Error).message, detail });
    }
  }

  /* Advance only over what was actually looked at. Taking X's `newest_id`
     wholesale would skip every mention past the cap, permanently: they are
     older than the new watermark and no later poll would ever return them.
     AND NEVER PAST A TWEET WE MEAN TO PICK BACK UP. `retry` is only a retry if
     X will serve that mention again, and X serves by since_id, so a watermark
     that stepped over it would have left a row promising a second attempt that
     could never physically happen. The cost is re-reading the handful of
     mentions after it, which are skipped by their own claim rows for a single
     indexed lookup each. */
  const upto = retryFrom === null ? result.looked : retryFrom;
  const lastLooked = ordered.slice(0, upto).at(-1)?.id ?? null;
  if (lastLooked) await botStateSet(SINCE_KEY, lastLooked);

  return result;
}
