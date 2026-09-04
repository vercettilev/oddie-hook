import { createHash } from "node:crypto";
import pg from "pg";
import {
  STARTING_PREDICTIONS, CALL_COST,
  edgePts, proceedsFor, reputationOf, winBonus,
  CREATOR_FEE_BPS_PLAY, CREATOR_FEE_BPS_REAL, PROTOCOL_FEE_BPS_REAL, creatorFeePlay,
  callerTier, oddieScoreFrom, SCORE_WEIGHTS, loudMultiplierOf,
  type Reputation, type CallerTier,
} from "./economy.js";
import { categorizeText } from "../matching/categorize.js";
import { Market } from "../venues/types.js";
import { randomHandle, validateHandle } from "./handles.js";
import { fetchSourcePost } from "../venues/xOembed.js";

// Slugs are the product. One gets tweeted on day 1 and a stranger opens it on
// day 6, after however many redeploys happened in between. So they have to
// outlive the process. Two mechanisms, together:
//
//   1. The slug is DERIVED from (venue, venueId), not random. The same market
//      always yields the same slug, so a slug can be re-resolved against the
//      live market set even if nothing was ever written down.
//   2. It is PERSISTED, with a snapshot of the market. Derivation alone is not
//      enough: by day 6 the market may have rolled out of the live set, and the
//      card still has to render. The snapshot is what renders.
//
// Writes happen only where a link is actually minted (/hook) or acted on
// (a call). The feed does not write: it derives slugs for display, which is why
// `slugFor` is pure. Before this, /api/feed called createSlug for every one of
// its 40 items, i.e. 40 upserts per feed load.
//
// With no DATABASE_URL we fall back to the old in-memory Map so that tests and
// local dev need no database — and say so loudly, because a process in that
// mode must never be the one seeding public links.

export interface Call {
  side: "yes" | "no";
  tokens: number; // virtual tokens only
  at: string;
}

export interface SlugRecord {
  slug: string;
  market: Market;
  createdAt: string;
  calls: Call[];
}

const DATABASE_URL = process.env.DATABASE_URL;

/** True when slugs survive a restart. The bot layer should refuse to post if false. */
export const PERSISTENT = Boolean(DATABASE_URL);

if (!PERSISTENT) {
  console.warn(
    "[store] DATABASE_URL is unset — slugs are in memory and will NOT survive a restart. " +
      "Fine for tests and local dev; never seed public links from this process.",
  );
}

/**
 * Deterministic and pure. The word prefix is for humans; the hash suffix is what
 * makes it a key. Derived from venueId rather than the question, so re-deriving
 * does not depend on a venue leaving its wording alone.
 */
export function slugFor(market: Market): string {
  const words = market.question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
  const hash = createHash("sha1").update(`${market.venue}:${market.venueId}`).digest("hex").slice(0, 6);
  return `${words || "market"}-${hash}`;
}

// --- Postgres backend -------------------------------------------------------

const DDL = `
CREATE TABLE IF NOT EXISTS market_slug (
  slug        text PRIMARY KEY,
  venue       text NOT NULL,
  venue_id    text NOT NULL,
  question    text NOT NULL,
  yes_pct     integer NOT NULL,
  closes_at   timestamptz,
  volume_usd  double precision NOT NULL DEFAULT 0,
  venue_url   text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue, venue_id)
);
-- The previous odds reading, so a card can say which way a market has moved.
-- Rolled forward at most once per ~20h by createSlug's upsert (see there), NOT
-- on every refresh: the feed re-reads venues every few minutes, and a delta
-- against the last refresh is always zero. Null until a market has been seen
-- across two windows, which is the honest state for one we just met.
ALTER TABLE market_slug ADD COLUMN IF NOT EXISTS prev_pct    integer;
ALTER TABLE market_slug ADD COLUMN IF NOT EXISTS prev_pct_at timestamptz;

CREATE TABLE IF NOT EXISTS market_call (
  id      bigserial PRIMARY KEY,
  slug    text NOT NULL REFERENCES market_slug(slug) ON DELETE CASCADE,
  side    text NOT NULL CHECK (side IN ('yes','no')),
  tokens  integer NOT NULL CHECK (tokens > 0),
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_call_slug_idx ON market_call(slug);

-- Anonymous device id. Nullable on purpose: every row written before this
-- column existed is still a real call, and a browser that blocks storage still
-- gets to place one. NOT a user id — there are no users, no accounts, no PII.
ALTER TABLE market_call ADD COLUMN IF NOT EXISTS device_id text;
CREATE INDEX IF NOT EXISTS market_call_device_idx ON market_call(device_id);

-- The side's percentage at the moment the call locked. Without it, Positions
-- would recompute "win 92" from TODAY's odds and a position would appear to
-- change value after the fact. Nullable: old rows never knew it.
ALTER TABLE market_call ADD COLUMN IF NOT EXISTS pct_at integer;

-- Paper-trading balance, keyed by device. Virtual tokens only — the number is
-- entertainment, not money, and nothing here converts in either direction.
-- The CHECK is what makes "spend more than you have" impossible at the data
-- layer no matter what the API does.
CREATE TABLE IF NOT EXISTS device_balance (
  device_id  text PRIMARY KEY,
  tokens     integer NOT NULL DEFAULT 100 CHECK (tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A new device starts with STARTING_PREDICTIONS. Only the DEFAULT changes,
-- never existing rows: ALTER COLUMN … SET DEFAULT changes future inserts
-- only, so a device that spent down keeps its real balance — the daily claim
-- carries it up. Interpolated (not a literal) so this can never silently
-- drift from the constant again the way it did when the predictions economy
-- shipped: application code changed STARTING_TOKENS(200) to
-- STARTING_PREDICTIONS(5), but getWallet's INSERT never specifies tokens
-- for a brand-new row — it relies entirely on this column DEFAULT — and nothing
-- here updated it. Every dev/test run is in-memory (mem mode reads the JS
-- constant directly, so it never touches this DEFAULT and could never have
-- shown the divergence) — only real Postgres exposed it, and did: a
-- genuinely fresh production device read "200 LEFT", not "5 LEFT".
ALTER TABLE device_balance ALTER COLUMN tokens SET DEFAULT ${STARTING_PREDICTIONS};
ALTER TABLE device_balance ADD COLUMN IF NOT EXISTS topped_up_at timestamptz NOT NULL DEFAULT now();

-- Early exit. A call is OPEN until it is sold (or, one day, settled); closing it
-- stamps the price it left at. pct_at is the entry, exit_pct the exit, and
-- the difference is the edge — the only thing reputation is made of. Settlement
-- will write the same three columns with exit_pct 100 or 0, which is why there
-- is no separate notion of "won".
ALTER TABLE market_call ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE market_call ADD COLUMN IF NOT EXISTS exit_pct integer;
ALTER TABLE market_call ADD COLUMN IF NOT EXISTS proceeds integer;
CREATE INDEX IF NOT EXISTS market_call_open_idx ON market_call(device_id) WHERE closed_at IS NULL;

-- Week-1 funnel. Four event names, an append-only table, no IP and no user
-- agent. It exists to answer three questions and nothing else: how many came,
-- how deep did they scroll, how many tapped. See scripts/events.ts.
CREATE TABLE IF NOT EXISTS event (
  id        bigserial PRIMARY KEY,
  name      text NOT NULL,
  device_id text NOT NULL,
  slug      text,
  idx       integer,
  side      text,
  cat       text,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_device_idx ON event(device_id);
CREATE INDEX IF NOT EXISTS event_name_at_idx ON event(name, at);

-- An optional, persistent identity. Sign-in is an upgrade, never a wall: the
-- anonymous device stays the default and everything works without a row here.
--
-- What we keep is the minimum that makes an account an account: which provider
-- vouched for it, that provider's opaque id for the person, and whatever public
-- handle they already show the world. No email, no tokens from the provider, no
-- refresh grants. We are not going to post as them; that is the Week-6 bot, and
-- it will ask for its own permission.
--
-- canonical_device is the account's single stream of balance, calls and history.
-- Linking a second browser points that browser at this device rather than
-- copying anything, so there is exactly one row per position no matter how many
-- devices a person signs in from.
CREATE TABLE IF NOT EXISTS account (
  id               bigserial PRIMARY KEY,
  provider         text NOT NULL CHECK (provider IN ('google','twitter','phantom')),
  provider_uid     text NOT NULL,
  handle           text,
  display_name     text,
  canonical_device text NOT NULL,
  -- Non-null means the +100 has been paid. Once per account, forever, even if
  -- every device that ever linked to it is deleted.
  bonus_granted_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_uid)
);
-- Wallet sign-in added a third provider. The CHECK above is only applied when
-- the table is created, so a database that predates phantom would reject every
-- wallet link with a constraint violation. Dropped and re-added rather than
-- guarded: the statement is then correct whatever state the constraint is in,
-- and the account table is small enough that revalidating it on boot is free.
ALTER TABLE account DROP CONSTRAINT IF EXISTS account_provider_check;
ALTER TABLE account ADD CONSTRAINT account_provider_check CHECK (provider IN ('google','twitter','phantom'));

CREATE TABLE IF NOT EXISTS device_account (
  device_id  text PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  linked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_account_acct_idx ON device_account(account_id);

-- A name to be seen by. Lives on the balance row because that row IS the
-- identity's stream (canonical device); a second browser signing in reads the
-- same row and therefore the same name. Uniqueness is case-insensitive so
-- "Popper_1" cannot impersonate "popper_1".
ALTER TABLE device_balance ADD COLUMN IF NOT EXISTS handle text;
CREATE UNIQUE INDEX IF NOT EXISTS device_balance_handle_key ON device_balance (lower(handle));

-- The daily claim: when the device last collected, and its consecutive-day
-- streak. The grant itself lands in the tokens column; these two drive the
-- active claim hook and its streak counter. (topped_up_at stays for backfill
-- but no longer grants — the claim replaced the passive top-up.)
ALTER TABLE device_balance ADD COLUMN IF NOT EXISTS last_claim_at timestamptz;
ALTER TABLE device_balance ADD COLUMN IF NOT EXISTS claim_streak integer NOT NULL DEFAULT 0;

-- The season leaderboard rank this device last saw (on a Profile or Leaderboard
-- view) — see rankMovementFor. NULL means "never viewed while ranked", which is
-- also how a rank move is suppressed the first time a device becomes ranked:
-- there is nothing to compare against yet, only a baseline to record.
ALTER TABLE device_balance ADD COLUMN IF NOT EXISTS last_seen_rank integer;

-- Whether this device has ever been shown the post-first-call tag-teaching
-- moment ("now the real move: tag @oddiefun...") — see claimTagTeachingMoment.
-- A single ever-flag, not a notice-queue row: this is a one-time onboarding
-- beat tied to the device, not a replayable event.
ALTER TABLE device_balance ADD COLUMN IF NOT EXISTS tag_teaching_seen_at timestamptz;

-- Whether this device has ever been shown the first-visit guided tour (the
-- 3-step in-page spotlight) — see claimGuidedTour. Same one-shot-ever shape
-- as tag_teaching_seen_at above; both go through claimOnceFlag.
ALTER TABLE device_balance ADD COLUMN IF NOT EXISTS tour_seen_at timestamptz;

-- Real notifications: one row per thing that actually happened to this device's
-- stream (a settlement, for now). Append-only; the UI reads, never writes.
CREATE TABLE IF NOT EXISTS notice (
  id         bigserial PRIMARY KEY,
  device_id  text NOT NULL,
  kind       text NOT NULL,
  body       text NOT NULL,
  delta      integer,
  slug       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notice_device_idx ON notice(device_id, created_at DESC);

-- Which call a settlement notice is about, so the notification itself can mint
-- the owner's personal share card (win OR loss) — the brag is one tap from the
-- alert, not only from the Positions screen.
ALTER TABLE notice ADD COLUMN IF NOT EXISTS call_id bigint;

-- Whether the device has actually been SHOWN this resolution's celebration
-- takeover — a separate, richer moment from the flat notice line, so this is
-- set only once the client finishes displaying it (see markCelebrationsSeen),
-- never at fetch time. NULL means "not yet celebrated"; settlement notices only,
-- irrelevant to every other kind.
ALTER TABLE notice ADD COLUMN IF NOT EXISTS seen_at timestamptz;

-- A running count for notice kinds that BATCH same-day repeats into one row
-- instead of one row per event (opposite_side: "3 people took the other side
-- today" rather than three separate pings) — see notifyOppositeSide. NULL for
-- every kind that doesn't batch.
ALTER TABLE notice ADD COLUMN IF NOT EXISTS count integer;

-- A call becomes shareable only when its owner mints a token for it. Random,
-- not the sequential id: calls must not be enumerable from outside, because a
-- share card names a handle and a side.
ALTER TABLE market_call ADD COLUMN IF NOT EXISTS share_token text;
CREATE UNIQUE INDEX IF NOT EXISTS market_call_share_token_key ON market_call(share_token);

-- Manual X mentions: the operator marks a settled position "mentioned" after
-- posting it by hand from the Oddie X account. State, not workflow — set once, and the
-- 24h-return measurement reads events against this timestamp.
ALTER TABLE market_call ADD COLUMN IF NOT EXISTS mentioned_at timestamptz;

-- A verdict the operator decided NOT to post, distinct from mentioned_at on
-- purpose: mentioned_at means "this actually went out on X" and the 24h-return
-- read trusts it for that. mentionCandidates() had no cutoff on age, so an
-- unposted row sat in the worklist forever. A burst of the operator's own
-- test calls (repeated identical markets, obviously not real player activity)
-- occupied the "N to post" count indefinitely with nothing to actually post.
-- The only way to clear a row like that was "mark sent" on something never
-- sent, which would have made the 24h-return signal measure a post that never
-- happened. dismissed_at removes a row from the worklist without lying about
-- what happened to it.
ALTER TABLE market_call ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

-- Email arrived with a purpose (settlement notifications), so the Google scope
-- now asks for it and it lands here. Nullable: X accounts and pre-email Google
-- links simply have none.
ALTER TABLE account ADD COLUMN IF NOT EXISTS email text;

-- The curated-launch gate: feed access = Google sign-in AND this table.
-- invited_at/accepted_at drive the /tool invite panel and its funnel events.
CREATE TABLE IF NOT EXISTS allowlist (
  email       text PRIMARY KEY,
  source      text NOT NULL DEFAULT 'manual',
  invited_at  timestamptz,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- The engaged extension users signed in with X, not Google, so the gate must
-- open for an allowlisted X identity too. Match primarily on x_uid (the numeric
-- X user id, stable across handle changes and identical to what X OAuth
-- returns); handle is kept for display and as a soft fallback.
ALTER TABLE allowlist ADD COLUMN IF NOT EXISTS x_uid text;
ALTER TABLE allowlist ADD COLUMN IF NOT EXISTS x_handle text;
CREATE UNIQUE INDEX IF NOT EXISTS allowlist_x_uid_key ON allowlist (x_uid) WHERE x_uid IS NOT NULL;
-- A label for the group a person was invited in, so the funnel can be read per
-- cohort (a legacy-farm-suspect wave never pollutes the read on later invites).
ALTER TABLE allowlist ADD COLUMN IF NOT EXISTS cohort text NOT NULL DEFAULT 'default';

-- Backfill call_id on settlement notices minted before the column existed, so a
-- user's PAST wins and losses are shareable too, not just future ones. Idempotent
-- (only NULL call_ids); picks any of the device's matching closed calls on that
-- market — the personal card tells the same story whichever it is.
UPDATE notice n SET call_id = c.id
  FROM market_call c
 WHERE n.call_id IS NULL
   AND n.kind IN ('settle_win','settle_loss')
   AND c.device_id = n.device_id
   AND c.slug = n.slug
   AND c.closed_at IS NOT NULL
   AND c.exit_pct = CASE WHEN n.kind = 'settle_win' THEN 100 ELSE 0 END;

-- Community markets: the admin-created (Layer 1) markets that also get minted
-- on-chain (Layer 2). The base market lives in market_slug (venue='community');
-- this table carries what's specific to them — the forced category, manual
-- resolution state, and the devnet proof (market_id + PDA + tx signature). A
-- null onchain_pubkey means the on-chain mint was skipped or failed: the market
-- is still fully playable, it just shows no "on-chain" badge.
CREATE TABLE IF NOT EXISTS community_market (
  slug             text PRIMARY KEY REFERENCES market_slug(slug) ON DELETE CASCADE,
  market_id        bigint NOT NULL,
  category         text NOT NULL DEFAULT 'Community',
  resolved_outcome text,
  onchain_pubkey   text,
  onchain_sig      text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- The claim-extraction engine writes these: the rules a bettor sees before
-- playing ("Resolves by: …"), and the gate grade (clean|fuzzy|unresolvable).
-- Added via ALTER so existing deployments pick them up without a migration tool.
ALTER TABLE community_market ADD COLUMN IF NOT EXISTS resolution_criteria text;
ALTER TABLE community_market ADD COLUMN IF NOT EXISTS resolvability       text;

-- The creator fee rate this market will be minted with, decided ONCE and
-- carried by the same row that makes the market visible.
--
-- It used to be re-derived at mint time from market_surfacer. That row is
-- written AFTER this one and behind an oEmbed fetch, so for up to six seconds a
-- market was live on the feed with no surfacer -- and surfacerFor returns null
-- for a missing row rather than throwing, so an unauthenticated
-- /api/chain/ensure landing in that window minted an X market at 0 bps. The
-- rate is permanent once on chain, making that an unrecoverable loss of the
-- creator's whole share. A rate carried by the publishing row cannot be read
-- before it exists.
--
-- NULL means "written before this column existed". Those markets all predate
-- any 0-bps market, so the full rate is the correct reading for them.
ALTER TABLE community_market ADD COLUMN IF NOT EXISTS creator_fee_bps integer;

-- Taken off the board without being destroyed.
--
-- The alternative was retire --delete, which removes the
-- market_slug row and cascades through community_market, market_surfacer and
-- market_call: the only record of who tagged a market, gone, at exactly the
-- moment somebody would want to look it up. It also orphans the on-chain
-- account beyond the reach of reclaim-rent, which enumerates by database row.
--
-- RETIRED MEANS UNDISCOVERABLE, NOT UNREACHABLE. It disappears from the feed,
-- from pricing, from the agent API and from the one-post-one-market check, so a
-- fresh tag on the same post opens a fresh market. It stays reachable at its own
-- permalink and in its stakers' positions, because hiding a market somebody has
-- money in is hiding their money. A market with anything in its vault is refused
-- outright.
ALTER TABLE community_market ADD COLUMN IF NOT EXISTS retired_at timestamptz;

-- Every extraction, logged for later prompt tuning: the input argument, the
-- engine's structured output, and (on publish) the operator's final edits.
CREATE TABLE IF NOT EXISTS extraction_log (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,          -- 'extract' | 'match' | 'publish'
  input      text NOT NULL,
  output     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- "Tweet mode": every ready-to-post X reply we generated for a mention. The
-- record of what was (manually) posted, and the substrate for the reusable
-- reply logic once we automate. One row per generated reply.
CREATE TABLE IF NOT EXISTS tweet_reply_log (
  id         bigserial PRIMARY KEY,
  source_url text,                    -- the tweet that triggered it
  market_id  text,                    -- venue id or the community market_id
  match_type text NOT NULL,           -- 'venue' | 'closest' | 'new'
  slug       text,
  permalink  text,
  reply_text text NOT NULL,           -- the primary reply we handed the operator
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Permalink landings (/m/{slug}), for the internal wedge metrics (click→pick).
-- One row per view; device_id ties a view to the pick that may follow it.
CREATE TABLE IF NOT EXISTS page_view (
  id         bigserial PRIMARY KEY,
  slug       text NOT NULL,
  device_id  text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS page_view_slug_idx ON page_view(slug);

-- Who surfaced a market — the contributor a tagged claim came from. Keyed by
-- slug so it covers BOTH venue matches (no community_market row) and created
-- markets. The contributor is a tweet author, so the natural identity is a
-- twitter handle; device_id is filled in when that handle has an Oddie account.
CREATE TABLE IF NOT EXISTS market_surfacer (
  slug        text PRIMARY KEY REFERENCES market_slug(slug) ON DELETE CASCADE,
  handle      text,                          -- tweet author, lowercased
  device_id   text,                          -- resolved from handle when known
  source_url  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- The source post's own text and its author's display name, so a market card
-- can SHOW the claim it came from instead of only linking to it. Fetched
-- best-effort from X's public oEmbed at record time (see xOembed.ts) and
-- cached here: the post can be deleted later, and a market that outlives its
-- source should still be able to say what was claimed. Null whenever the
-- fetch failed or the post wasn't public — the card degrades to no preview.
ALTER TABLE market_surfacer ADD COLUMN IF NOT EXISTS source_text text;
ALTER TABLE market_surfacer ADD COLUMN IF NOT EXISTS source_author text;

-- The identity of the source POST, as opposed to its URL. Four spellings of the
-- same tweet (x/twitter/fixupx/vxtwitter) share one key, and a Telegram message
-- gets one too. Before this, the one-post-one-market rule was a regex for
-- "/status/" applied to the raw URL, so it matched no Telegram link at all and
-- the rule was silently absent for that whole surface -- a spend gate that
-- looked present and was not. Backfilled below for rows written before it.
ALTER TABLE market_surfacer ADD COLUMN IF NOT EXISTS source_key text;
-- This has to produce EXACTLY what sourcePostKey() computes for the same URL,
-- or a backfilled row holds a key the runtime never asks for and silently
-- stops deduping. Three things that took getting wrong to notice:
--   substring, not split_part -- split_part carries the query string, so a URL
--     ending "?s=20" became "123?s=20";
--   ::bigint::text -- the code normalises the id through BigInt, so a
--     zero-padded "0000123" must collapse to "123" here too;
--   an anchored host+path test -- the loose '%/status/%' form also keyed rows
--     whose host sourceUrlKind refuses, which the runtime can never match.
UPDATE market_surfacer
   SET source_key = 'x:' || (substring(source_url from '/status/([0-9]+)'))::bigint::text
 WHERE source_key IS NULL
   AND source_url ~ '^https?://(www\.)?(x|twitter|fixupx|vxtwitter)\.com/([A-Za-z0-9_]{1,15}|i/web|i)/status/[0-9]+([/?#]|$)';
CREATE INDEX IF NOT EXISTS market_surfacer_source_key_idx ON market_surfacer (source_key);

-- The Season Points ledger. BACKEND-ONLY (never shown as a standalone number):
-- it is both the audit trail for every award AND the source of truth for a
-- contributor's total (SUM(amount)). dedup_key makes every event idempotent —
-- a re-generated reply or a retried settle can never double-award.
CREATE TABLE IF NOT EXISTS season_points_log (
  id         bigserial PRIMARY KEY,
  device_id  text,                           -- creditee device when resolvable
  handle     text,                           -- creditee handle (always, when known)
  event      text NOT NULL,                  -- surface|three_players|first_timer|clean_resolve
  amount     integer NOT NULL,
  slug       text,                           -- the related market
  dedup_key  text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spl_device_idx ON season_points_log(device_id);
CREATE INDEX IF NOT EXISTS spl_handle_idx ON season_points_log(handle);

-- Loud submissions: "I posted about oddie — here's the link." One row per
-- tweet, forever (tweet_id UNIQUE is the dedup), reviewed by the operator
-- today and by an X API read when credits exist. Approval pays loud_post.
CREATE TABLE IF NOT EXISTS loud_post (
  id          bigserial PRIMARY KEY,
  device_id   text NOT NULL,
  tweet_id    text NOT NULL UNIQUE,
  url         text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  week        text NOT NULL,                    -- ISO week at submission
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
CREATE INDEX IF NOT EXISTS loud_post_device_idx ON loud_post(device_id);
CREATE INDEX IF NOT EXISTS loud_post_status_idx ON loud_post(status);

-- Every creator/protocol fee, real or merely proposed. One row per fee event:
-- a play-token settlement writes one 'creator'/'play' row when a fee was
-- actually credited; a real-money resolve writes 'creator'+'protocol' rows
-- under 'real', but with enforced=false, since no on-chain deduction happens
-- yet (see economy.ts's CREATOR_FEE_BPS_REAL doc comment for why). This is
-- the audit trail for both — "every fee, real or proposed" — so a later pass
-- adding on-chain enforcement has a ledger of what SHOULD have been charged.
CREATE TABLE IF NOT EXISTS market_fee_log (
  id                   bigserial PRIMARY KEY,
  slug                 text NOT NULL,
  market_kind          text NOT NULL,          -- 'play' | 'real'
  fee_kind             text NOT NULL,          -- 'creator' | 'protocol'
  recipient_device_id  text,                    -- null for the protocol row (no personal recipient)
  recipient_handle     text,
  rate_bps             integer NOT NULL,
  basis_amount         bigint NOT NULL,         -- pool the rate applied to: tokens (play) or lamports (real)
  fee_amount           bigint NOT NULL,
  enforced             boolean NOT NULL,        -- true = actually credited; false = logged only, not charged
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfl_slug_idx ON market_fee_log(slug);

-- The home page's featured "Live right now" slots — an admin-ordered list of
-- community market slugs (rank = display order, lowest first). Fewer picks
-- than the home page wants to show falls back to the most recently active
-- open community markets not already in this list — that fallback logic
-- lives in resolveFeatured() in server.ts, where the live market data is.
CREATE TABLE IF NOT EXISTS featured_markets (
  slug   text PRIMARY KEY,
  rank   integer NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now()
);

-- The bot's own durable state, as key/value. Two things live here and both
-- MUST survive a restart or the loop misbehaves in a way nobody notices:
--
--  1. x_since_id: the newest mention already looked at. Lose it and the bot
--     re-reads the whole mention window on boot, which is how a redeploy
--     turns into a burst of duplicate replies.
--  2. x_refresh_token: X ROTATES the refresh token on every refresh and
--     invalidates the old one. Keeping it only in an env var means the value
--     in Railway is stale the moment the first refresh succeeds, and the next
--     cold start cannot authenticate at all. The env var is the SEED; this
--     row is the truth from the first refresh onward.
-- A real profile picture, stored here rather than on a disk or in a bucket.
--
-- The bytes are already square and small by the time they arrive: the browser
-- crops and resizes to 256x256 JPEG on a canvas before uploading, so a row is
-- ~15-25KB and there is no server-side image processing, no object storage to
-- provision, and no filesystem to lose on a redeploy. Postgres holds it fine at
-- this size, and it is one fewer moving part than any alternative.
CREATE TABLE IF NOT EXISTS device_avatar (
  device_id text PRIMARY KEY,
  image     bytea NOT NULL,
  mime      text NOT NULL,
  set_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_state (
  k       text PRIMARY KEY,
  v       text NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);

-- Every mention the bot has decided about, so a decision is made exactly once.
-- since_id alone is not enough: X can return a mention twice around a window
-- boundary, and a crash between "replied" and "advanced since_id" would
-- otherwise repost. The row is written BEFORE the reply is attempted, so a
-- crash mid-post leaves a claimed row and skips rather than double-posts.
-- Under-posting is recoverable by hand; double-posting is not.
CREATE TABLE IF NOT EXISTS x_mention (
  tweet_id   text PRIMARY KEY,
  author     text,
  outcome    text NOT NULL,          -- claimed | replied | skipped | failed
  reason     text,
  slug       text,
  reply_id   text,
  at         timestamptz NOT NULL DEFAULT now()
);

-- Every decision the oracle has ever reached, settled or refused. Append-only,
-- one row per decide() call, including the runs that changed nothing: the
-- REFUSALS are the record here. A market that quietly abstains looks exactly
-- like a market nobody got to, and this table is the only thing that can tell
-- those two apart afterwards. It is also what stops the oracle re-spending a
-- full propose loop on the same stuck market every single run, forever.
--
-- No foreign key to market_slug, deliberately: this follows market_fee_log and
-- not market_call. It is an audit trail, and ON DELETE CASCADE would erase the
-- record of why we declined to settle a market at exactly the moment somebody
-- went looking for it.
CREATE TABLE IF NOT EXISTS oracle_decision (
  id                bigserial PRIMARY KEY,
  slug              text NOT NULL,
  -- 'yes' | 'no', or NULL for "a person needs to look at this". Stored as the
  -- tri-state it is: folding NULL into a gate value would merge "no verdict"
  -- with "the verdict is no".
  settle            text CHECK (settle IN ('yes','no')),
  -- Which gate stopped it. Deliberately NOT constrained. The list grows every
  -- time the oracle learns a new reason to refuse, and a CHECK is applied only
  -- when the table is created, so a new gate name would be accepted by every
  -- fresh test schema and rejected in production.
  gate              text NOT NULL,
  reason            text NOT NULL,
  -- NULL when the proposer never ran. Both code gates decide before a token is
  -- spent, which is the whole point of their being first.
  confidence        text,
  second_opinion    text,
  -- Every citation with the status the audit gave it, as the shape the audit
  -- already produces. jsonb rather than a child table because nothing joins to
  -- a citation.
  citations         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The tallies, lifted out of the jsonb above so that asking "did anything
  -- cite a page that no longer shows its quote" across the whole board does not
  -- mean opening every document.
  cites_verified    integer NOT NULL DEFAULT 0,
  cites_undated     integer NOT NULL DEFAULT 0,
  cites_stale       integer NOT NULL DEFAULT 0,
  cites_absent      integer NOT NULL DEFAULT 0,
  cites_unreachable integer NOT NULL DEFAULT 0,
  -- Whether the model was actually called. The retry policy is built on this
  -- and not on the gate name, so a gate that becomes free later cannot quietly
  -- start counting as a paid attempt.
  paid              boolean NOT NULL DEFAULT false,
  -- Propose-then-delay lives in these three columns. Nothing writes them yet:
  -- the feature waits on whether the oracle runs unattended at all. They are
  -- here now because CREATE TABLE IF NOT EXISTS never ALTERs, so a column added
  -- later is a column production silently does not have.
  --   logged     a decision recorded. Informational, never settleable.
  --   proposed   a verdict serving out its objection window.
  --   objected   a person said no. Terminal.
  --   applied    handed to /api/community/resolve. Terminal.
  state             text NOT NULL DEFAULT 'logged',
  -- Written as now() + an interval BY THE DATABASE and compared against now()
  -- by the database, so one clock measures the window start to finish rather
  -- than the cron host's idea of the time defining when it opened and the
  -- database's deciding when it closed. Not a column DEFAULT: see
  -- device_balance.tokens for what happens when a constant moves in the code
  -- and the DEFAULT silently does not.
  settle_after      timestamptz,
  objection         text,
  decided_at        timestamptz NOT NULL DEFAULT now(),
  acted_at          timestamptz
);
CREATE INDEX IF NOT EXISTS oracle_decision_slug_idx ON oracle_decision(slug, id DESC);

-- The moment a wallet FIRST took a side, and what the crowd said at that moment.
--
-- WHY THIS EXISTS. Pari-mutuel pays every winner pro-rata regardless of when
-- they entered, so the money cannot tell a 30%-contrarian from a 90%-bandwagoner:
-- being early and right earns nothing extra, and being followed actively COSTS
-- the caller (the pile-on dilutes their own payout). If reputation does not pay
-- for earliness, nothing does, and the rational good caller goes quiet. This
-- table is what reputation is computed from: the receipt says "called YES when
-- the crowd said 30%", and that number has to have been written down at the
-- time, because afterwards the pool remembers only how it ended.
--
-- WRITTEN ONLY WHEN A SIGNED STAKE IS BROADCAST, from /api/chain/submit, never
-- at prepare. A prepare can be abandoned, and stamping there would let anyone
-- farm good-looking entries for free: prepare at 30%, never sign, stake later
-- only once the outcome looks safe. The stamp is the first REAL stake.
--
-- FIRST ENTRY WINS (ON CONFLICT DO NOTHING). take_position lets a wallet add to
-- an existing position, and re-stamping on a top-up would open the other cheat:
-- enter tiny at 30%, pile in at 90%, look early with size. The receipt never
-- shows amounts for the same reason.
--
-- No foreign key: this is reputation history, market_fee_log's arrangement, and
-- deleting a market must not delete the record of who called it right.
CREATE TABLE IF NOT EXISTS chain_entry (
  slug        text NOT NULL,
  wallet      text NOT NULL,
  side        text NOT NULL CHECK (side IN ('yes','no')),
  -- The share of THEIR side, 0-100, in the pool as it stood JUST BEFORE their
  -- stake landed. 50 for the first stake into an empty pool: no crowd, no
  -- information, no contrarian credit.
  entry_pct   integer NOT NULL,
  lamports    bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, wallet)
);

-- The bot API's idempotency ledger.
--
-- A caller sends Idempotency-Key: tg:<chat_id>:<message_id> and this table is
-- the final authority on what that key already produced. The bot has its own
-- dedupe, but two people can trigger the same claim in the same second and both
-- requests race past it; only a unique constraint settles that, and the failure
-- mode it prevents costs us on-chain rent.
--
-- A REFUSAL IS RECORDED TOO. An unsettleable claim is a permanent property of
-- its text, so re-asking spends a model call to learn the same thing. The row
-- carries the reason and when it stops being trusted, because the only thing
-- that can change a refusal is our own classifier improving.
CREATE TABLE IF NOT EXISTS api_claim_key (
  -- NAMESPACED BY CALLER. The key is the caller's own header value, so a single
  -- global namespace let any key holder read another's answers and, worse, squat
  -- their keys: send tg:<their chat>:<their message> first and their bot is
  -- handed your market forever. Callers are hashed in, exactly as the quota
  -- bucket does, so the key never lands in a row.
  key         text PRIMARY KEY,
  -- Set when the claim became a market. Null on a refusal.
  slug        text,
  -- Set on a refusal: unresolvable | inappropriate | no_question. Null on success.
  refusal     text,
  detail      text,
  -- When a cached refusal stops being trusted. Null for a market, which never
  -- expires: the same key must always answer with the same market.
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Refusals, keyed on the CLAIM TEXT rather than on a caller's header.
--
-- The per-key ledger above cannot stop this waste: an unsettleable claim is a
-- property of its words, so the same junk under a fresh Idempotency-Key spends
-- a fresh model call to be told the same thing, and the caller chooses that
-- header. Measured: five keys over identical refused text, five model calls.
-- Hashed, so the text itself is not stored twice.
CREATE TABLE IF NOT EXISTS api_refusal_text (
  text_hash   text PRIMARY KEY,
  reason      text NOT NULL,
  detail      text,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Per-caller, per-group rate limiting, as a token bucket.
--
-- Keyed on the CALLER AND THE GROUP, never on IP: every request from a bot
-- arrives from one server address, so an IP-keyed limit would make every group
-- it serves share a single bucket and let the busiest one starve the rest.
--
-- A bucket rather than a flat hourly cap because arguments cluster: a goal goes
-- in and six people make six predictions in ninety seconds. A flat cap throttles
-- exactly when the product is working.
--
-- Rows are keyed by a HASH of the API key, so the key itself never lands in a
-- table or a log line.
CREATE TABLE IF NOT EXISTS api_quota (
  bucket      text PRIMARY KEY,
  tokens      double precision NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Genesis profile snapshot: what users/me said at the moment the account
-- connected, plus the archetype verdict computed from it right then. One row
-- per X identity; reconnecting refreshes it (see genesis/profileStore.ts).
-- IF NOT EXISTS never alters a live table: any future column change goes in
-- as an explicit ALTER below, like market_surfacer's.
CREATE TABLE IF NOT EXISTS genesis_profile (
  provider_uid  text PRIMARY KEY,             -- X numeric id; handles rename
  handle        text NOT NULL,                -- without the @
  display_name  text,
  bio           text,
  x_created_at  timestamptz,
  tweet_count   integer,
  followers     integer,
  following     integer,
  pinned_text   text,
  archetype     text NOT NULL,
  headline      text NOT NULL,
  reason        text NOT NULL,
  captured_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS genesis_profile_handle_idx ON genesis_profile (lower(handle));

-- The Genesis season. All three are keyed on the X HANDLE, lowercased, NOT on
-- a connected account: "every X account gets 5 tickets" is a promise to every
-- tagger, and keying on the account would mean the people who connected were
-- the only ones who could ever run out. See genesis/season.ts.

-- Every ticket movement. The log IS the balance (5 + SUM(delta)); dedup_key
-- makes a retried sweep or a replayed submit idempotent.
CREATE TABLE IF NOT EXISTS genesis_ticket_log (
  id         bigserial PRIMARY KEY,
  handle     text NOT NULL,
  delta      integer NOT NULL,               -- -1 spend, +1 regen
  reason     text NOT NULL,                  -- 'tag' | 'bettor'
  dedup_key  text NOT NULL UNIQUE,           -- 'tag:<slug>' | 'bettor:<wallet>'
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS genesis_ticket_log_handle_idx ON genesis_ticket_log (handle);

-- Who OPENED a market by tagging. Deliberately not market_surfacer: that row
-- records the claim's author (provenance), and on a reply-tag the tagger is
-- somebody else entirely.
CREATE TABLE IF NOT EXISTS genesis_tag (
  slug           text PRIMARY KEY REFERENCES market_slug(slug) ON DELETE CASCADE,
  handle         text NOT NULL,              -- the tagger, lowercased
  source_handle  text,                       -- the claim's author, when there was one
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS genesis_tag_handle_idx ON genesis_tag (handle);

-- First touch, once per wallet FOREVER: the board counts humans who put real
-- money in, so one wallet funding ten markets is one person, credited to the
-- market that got them in.
CREATE TABLE IF NOT EXISTS genesis_bettor (
  wallet   text PRIMARY KEY,
  slug     text NOT NULL,
  handle   text,                             -- creditee; null when nobody tagged it
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS genesis_bettor_handle_idx ON genesis_bettor (handle);
`;

let pool: pg.Pool | null = null;
let schemaReady: Promise<void> | null = null;

function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  return pool;
}

/** Idempotent, runs once per process. Three queries do not need a migration tool. */
/**
 * Changes to a table that ALREADY EXISTS.
 *
 * The DDL above is all `CREATE TABLE IF NOT EXISTS`, which is exactly right for
 * adding a table and does NOTHING for changing one: a database that already has
 * the old shape keeps it, silently, and the first insert against the new
 * columns fails in production while every local test passes against a fresh
 * schema. That happened here, one deploy apart, and took the route down with it.
 *
 * So anything that alters an existing table goes here, written to be safe to run
 * on every boot and on a database that has never seen the old shape either.
 */
const MIGRATIONS = `
-- device_avatar changed from a chosen emoji + hue to real uploaded bytes.
ALTER TABLE device_avatar DROP COLUMN IF EXISTS emoji;
ALTER TABLE device_avatar DROP COLUMN IF EXISTS hue;
ALTER TABLE device_avatar ADD COLUMN IF NOT EXISTS image bytea;
ALTER TABLE device_avatar ADD COLUMN IF NOT EXISTS mime text;
-- Rows from the emoji era carry no picture and cannot be converted into one.
DELETE FROM device_avatar WHERE image IS NULL;
`;

function ensureSchema(): Promise<void> {
  schemaReady ??= db()
    .query(DDL)
    .then(() => db().query(MIGRATIONS))
    .then(() => console.log("[store] postgres ready — slugs persist across restarts"));
  return schemaReady;
}

interface SlugRow {
  slug: string;
  venue: string;
  venue_id: string;
  question: string;
  yes_pct: number;
  closes_at: Date | null;
  volume_usd: number;
  venue_url: string;
  created_at: Date;
}

function rowToRecord(r: SlugRow, calls: Call[]): SlugRecord {
  return {
    slug: r.slug,
    createdAt: r.created_at.toISOString(),
    calls,
    market: {
      venue: r.venue as Market["venue"],
      venueId: r.venue_id,
      question: r.question,
      yesPct: r.yes_pct,
      closesAt: r.closes_at ? r.closes_at.toISOString() : null,
      volumeUsd: Number(r.volume_usd),
      venueUrl: r.venue_url,
      tags: [], // not part of the snapshot; only matching uses tags, and matching uses live markets
    },
  };
}

async function loadCalls(slug: string): Promise<Call[]> {
  const { rows } = await db().query<{ side: "yes" | "no"; tokens: number; at: Date }>(
    `SELECT side, tokens, at FROM market_call WHERE slug = $1 ORDER BY at ASC`,
    [slug],
  );
  return rows.map((c) => ({ side: c.side, tokens: c.tokens, at: c.at.toISOString() }));
}

// --- In-memory backend (no DATABASE_URL) ------------------------------------

const mem = new Map<string, SlugRecord>();

// --- Public interface: unchanged shape, now async ---------------------------

/** Mint (or refresh) the slug for a market. Idempotent on (venue, venueId). */
export async function createSlug(market: Market): Promise<SlugRecord> {
  const slug = slugFor(market);

  if (!PERSISTENT) {
    const existing = mem.get(slug);
    if (existing) {
      existing.market = market; // refresh odds
      return existing;
    }
    const rec: SlugRecord = { slug, market, createdAt: new Date().toISOString(), calls: [] };
    mem.set(slug, rec);
    return rec;
  }

  await ensureSchema();
  // ON CONFLICT on (venue, venue_id) refreshes the snapshot but leaves `slug`
  // alone, so a slug already handed out in a tweet is never re-minted.
  const { rows } = await db().query<SlugRow>(
    `INSERT INTO market_slug (slug, venue, venue_id, question, yes_pct, closes_at, volume_usd, venue_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (venue, venue_id) DO UPDATE
       SET question = EXCLUDED.question,
           -- Roll the reading the delta is measured against, at most once per
           -- window. market_slug.yes_pct on the right-hand side is the row as
           -- it was BEFORE this update, which is exactly the reading we want to
           -- keep; every right-hand side in a DO UPDATE sees the old row, so it
           -- does not matter that yes_pct is being reassigned two lines down.
           -- Without the window this would compare against the last refresh,
           -- which is minutes old and always reads zero.
           prev_pct = CASE WHEN market_slug.prev_pct_at IS NULL
                             OR market_slug.prev_pct_at < now() - interval '20 hours'
                           THEN market_slug.yes_pct ELSE market_slug.prev_pct END,
           prev_pct_at = CASE WHEN market_slug.prev_pct_at IS NULL
                                OR market_slug.prev_pct_at < now() - interval '20 hours'
                              THEN now() ELSE market_slug.prev_pct_at END,
           yes_pct = EXCLUDED.yes_pct,
           closes_at = EXCLUDED.closes_at,
           volume_usd = EXCLUDED.volume_usd,
           venue_url = EXCLUDED.venue_url
     RETURNING *`,
    [slug, market.venue, market.venueId, market.question, market.yesPct, market.closesAt, market.volumeUsd, market.venueUrl],
  );
  return rowToRecord(rows[0], await loadCalls(rows[0].slug));
}

/**
 * Resolve a slug. `liveMarkets` lets a slug that was never written down (a card
 * shared straight out of the feed) still resolve, by re-deriving slugs over the
 * live set — and it gets persisted on the way out, so the next lookup is cheap.
 */
export async function getSlug(slug: string, liveMarkets: Market[] = []): Promise<SlugRecord | undefined> {
  if (!PERSISTENT) {
    const hit = mem.get(slug);
    if (hit) {
      // Prefer live odds over the stored snapshot — same reasoning as the
      // Postgres branch below, and the same bug class this file already has
      // scars from: mem and Postgres silently disagreeing because a fix only
      // ever landed on one side. `hit` is a reference INTO the mem Map, not a
      // copy, so this returns an overridden copy rather than mutating the
      // stored snapshot in place.
      const live = liveMarkets.find((m) => m.venue === hit.market.venue && m.venueId === hit.market.venueId);
      return live ? { ...hit, market: live } : hit;
    }
    const derived = liveMarkets.find((m) => slugFor(m) === slug);
    return derived ? createSlug(derived) : undefined;
  }

  await ensureSchema();
  const { rows } = await db().query<SlugRow>(`SELECT * FROM market_slug WHERE slug = $1`, [slug]);
  if (rows[0]) {
    const rec = rowToRecord(rows[0], await loadCalls(slug));
    // Prefer live odds when the market is still trading; the snapshot is the
    // floor, not the ceiling.
    const live = liveMarkets.find((m) => m.venue === rec.market.venue && m.venueId === rec.market.venueId);
    if (live) rec.market = live;
    return rec;
  }

  const derived = liveMarkets.find((m) => slugFor(m) === slug);
  return derived ? createSlug(derived) : undefined;
}

// --- Paper trading ----------------------------------------------------------

export { STARTING_PREDICTIONS, CALL_COST, PROVISIONAL_BELOW, winBonus } from "./economy.js";

/** In-memory backend (no DATABASE_URL): dev and tests, never production. */
interface MemCall {
  id: number;
  shareToken?: string;
  deviceId: string;
  slug: string;
  question: string;
  side: "yes" | "no";
  tokens: number;
  entryPct: number;
  at: string;
  closedAt: string | null;
  exitPct: number | null;
  proceeds: number | null;
}
const memBalance = new Map<string, { tokens: number; toppedUpAt: number }>();
const memCalls: MemCall[] = [];
let memId = 0;

/** Test-only escape hatch, same convention as _memGrant/_memDeviceAccount: lets
 *  a test backdate a settled call's closedAt so weeklyScoreDeltaFor's 7-day
 *  window has something real to draw a "before" and "after" boundary through,
 *  without a test literally waiting a week. */
export const _memCalls = memCalls;

export interface Wallet {
  tokens: number;
}

/** The price of a side, right now, or null when nothing can price it. */
function sidePctOf(m: Market | undefined, side: "yes" | "no"): number | null {
  if (!m) return null;
  const p = side === "yes" ? m.yesPct : 100 - m.yesPct;
  return p > 0 && p < 100 ? p : null; // 0 or 100 is a settled market, not a quote
}

/**
 * The price of a side in the LIVE set, and nowhere else.
 *
 * getSlug falls back to the stored snapshot when a market has left the venue's
 * listing, which is exactly right for rendering a shared card — a link tweeted
 * on Monday must still open on Friday — and exactly wrong for tokens. Pricing a
 * sale off a snapshot closes a position at whatever the odds happened to be the
 * last time anyone looked. That is not a stale read, it is a token printer, and
 * the first test to point a delisted market at this code found one.
 *
 * So: no live quote, no trade. The position stays open, and says so.
 */
function livePctOf(slug: string, side: "yes" | "no", liveMarkets: Market[]): number | null {
  return sidePctOf(liveMarkets.find((m) => slugFor(m) === slug), side);
}

export interface OpenPosition {
  id: number;
  slug: string;
  question: string;
  category: string;
  side: "yes" | "no";
  tokens: number;
  entryPct: number;
  /** Today's price for this side. Null when the venue no longer quotes it. */
  nowPct: number | null;
  /** Points gained or lost so far. This is the number reputation is made of. */
  edgeNow: number | null;
  /** What selling right now would return. */
  valueNow: number | null;
  /** What holding to a winning settlement would return — the card's "win N". */
  toWin: number;
  at: string;
}

export interface ClosedPosition {
  id: number;
  slug: string;
  question: string;
  category: string;
  side: "yes" | "no";
  tokens: number;
  entryPct: number;
  exitPct: number;
  proceeds: number;
  edge: number;
  at: string;
  closedAt: string;
}

/** Exposed so the account layer can write to the same database this module owns. */
export { PERSISTENT as STORE_PERSISTENT };
export function storeDb(): pg.Pool { return db(); }
export function storeSchema(): Promise<void> { return ensureSchema(); }

/**
 * The device a request's tokens, calls and reputation actually belong to.
 *
 * An anonymous browser owns itself. A browser that has signed in owns nothing —
 * it points at the account's canonical device, which is whichever browser first
 * linked. That indirection is the entire account system: no balance is copied,
 * no position is duplicated, and a person signed in on three phones reads and
 * writes one stream.
 *
 * Called at the top of every device-keyed operation. An unlinked device
 * resolves to itself, so the anonymous path costs one indexed lookup and
 * changes nothing.
 */
const memDeviceAccount = new Map<string, string>(); // device -> canonical device

export async function resolveDevice(deviceId: string): Promise<string> {
  if (!PERSISTENT) return memDeviceAccount.get(deviceId) ?? deviceId;
  await ensureSchema();
  const { rows } = await db().query<{ canonical_device: string }>(
    `SELECT a.canonical_device FROM device_account da
       JOIN account a ON a.id = da.account_id
      WHERE da.device_id = $1`,
    [deviceId],
  );
  return rows[0]?.canonical_device ?? deviceId;
}

/** In-memory link table, for the no-DATABASE_URL path. */
export const _memDeviceAccount = memDeviceAccount;

/** In-memory bonus credit, for the no-DATABASE_URL path. */
export function _memGrant(deviceId: string, tokens: number): void {
  const cur = memBalance.get(deviceId) ?? { tokens: STARTING_PREDICTIONS, toppedUpAt: Date.now() };
  memBalance.set(deviceId, { ...cur, tokens: cur.tokens + tokens });
}

/**
 * Read a device's wallet. Predictions never accrue passively — the daily grant
 * is an ACTIVE claim (claimStatus/claimDaily) — so this only ensures the row
 * exists and reports the balance.
 */
export async function getWallet(rawDeviceId: string): Promise<Wallet> {
  const deviceId = await resolveDevice(rawDeviceId);

  if (!PERSISTENT) {
    const cur = memBalance.get(deviceId) ?? { tokens: STARTING_PREDICTIONS, toppedUpAt: Date.now() };
    if (!memBalance.has(deviceId)) memBalance.set(deviceId, cur);
    return { tokens: cur.tokens };
  }

  await ensureSchema();
  await db().query(`INSERT INTO device_balance (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [deviceId]);
  const { rows } = await db().query<{ tokens: number }>(`SELECT tokens FROM device_balance WHERE device_id = $1`, [deviceId]);
  return { tokens: rows[0].tokens };
}

/* The daily claim lived here: a per-device streak, a 24h window, and a grant
 * of both dormant tokens and live score for tapping a button once a day. The
 * routes went first; these were the store halves they called, unreachable
 * since. The claim_streak and last_claim_at columns stay in the schema as
 * dormant history rather than being dropped out from under people's rows. */

/** Tokens only. Kept for callers that do not care about the top-up. */
export async function getBalance(deviceId: string): Promise<number> {
  return (await getWallet(deviceId)).tokens;
}

export type PlaceResult =
  | { ok: true; id: number; balance: number; calls: number; pctAt: number; firstEver: boolean }
  | { ok: false; reason: "insufficient"; balance: number }
  | { ok: false; reason: "unknown-market" }
  | { ok: false; reason: "unpriced" };

/** Does this device have ANY call, ever (open, closed, sold — doesn't matter)?
 *  The cheapest possible "has this browser ever played" check: one EXISTS
 *  against market_call, no joins. Shared by placeCall's firstEver (must run
 *  BEFORE this call lands) and the home page's new-user onboarding cue. */
async function hasAnyCallFor(deviceId: string): Promise<boolean> {
  if (!PERSISTENT) return memCalls.some((c) => c.deviceId === deviceId);
  await ensureSchema();
  const { rows } = await db().query<{ e: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM market_call WHERE device_id=$1) AS e`, [deviceId],
  );
  return rows[0]?.e === true;
}

/** Home page onboarding: true for a device that has never placed a call — the
 *  gate for stage 1 of the two-stage onboarding (the "make your first call"
 *  cue). deviceId here is NOT pre-resolved (unlike most exports) because the
 *  caller — /api/home — already has a raw deviceId and this is a thin negation
 *  of hasAnyCallFor; resolving through an account is still correct since a
 *  signed-in device's history lives on its canonical device either way. */
export async function isNewUserFor(rawDeviceId: string): Promise<boolean> {
  const deviceId = await resolveDevice(rawDeviceId);
  return !(await hasAnyCallFor(deviceId));
}

/**
 * The one write of paper trading: deduct the stake and record the call, or do
 * neither. In Postgres that is a transaction around a conditional UPDATE —
 * `SET tokens = tokens - $stake WHERE tokens >= $stake` either returns the new
 * balance or touches nothing, so two tabs racing the same balance cannot spend
 * it twice; the CHECK constraint backstops even that.
 */
export async function placeCall(
  slug: string,
  side: "yes" | "no",
  tokens: number,
  rawDeviceId: string,
  liveMarkets: Market[] = [],
): Promise<PlaceResult> {
  const deviceId = await resolveDevice(rawDeviceId);
  const rec = await getSlug(slug, liveMarkets);
  if (!rec) return { ok: false, reason: "unknown-market" };
  const pctAt = livePctOf(rec.slug, side, liveMarkets);
  // A side quoted at 0 or 100 cannot be entered: there are no shares to buy at
  // zero, and nothing to win at certainty.
  if (pctAt === null) return { ok: false, reason: "unpriced" };

  if (!PERSISTENT) {
    const w = await getWallet(deviceId);
    if (w.tokens < tokens) return { ok: false, reason: "insufficient", balance: w.tokens };
    const firstEver = !(await hasAnyCallFor(deviceId)); // before this call lands
    memBalance.set(deviceId, { tokens: w.tokens - tokens, toppedUpAt: memBalance.get(deviceId)!.toppedUpAt });
    rec.calls.push({ side, tokens, at: new Date().toISOString() });
    memCalls.unshift({
      id: ++memId, deviceId, slug: rec.slug, question: rec.market.question, side, tokens,
      entryPct: pctAt, at: new Date().toISOString(), closedAt: null, exitPct: null, proceeds: null,
    });
    const distinct = new Set(memCalls.filter((c) => c.slug === rec.slug && c.deviceId).map((c) => c.deviceId)).size;
    void awardParticipation(rec.slug, deviceId, firstEver, distinct);
    void notifyOppositeSide(rec.slug, rec.market.question, deviceId, side);
    return { ok: true, id: memId, balance: w.tokens - tokens, calls: rec.calls.length, pctAt, firstEver };
  }

  await getWallet(deviceId); // ensure the row exists (and collect any top-up) first
  // Is this the device's first-ever call? Read BEFORE the insert (best-effort;
  // a read failure just means no first-timer award, never a blocked call).
  const firstEver = await hasAnyCallFor(deviceId).then((has) => !has).catch(() => false);
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const upd = await client.query<{ tokens: number }>(
      `UPDATE device_balance SET tokens = tokens - $1 WHERE device_id = $2 AND tokens >= $1 RETURNING tokens`,
      [tokens, deviceId],
    );
    if (upd.rows.length === 0) {
      await client.query("ROLLBACK");
      const { rows } = await client.query<{ tokens: number }>(`SELECT tokens FROM device_balance WHERE device_id = $1`, [deviceId]);
      return { ok: false, reason: "insufficient", balance: rows[0]?.tokens ?? 0 };
    }
    const ins = await client.query<{ id: number }>(
      `INSERT INTO market_call (slug, side, tokens, device_id, pct_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [rec.slug, side, tokens, deviceId, pctAt],
    );
    await client.query("COMMIT");
    rec.calls = await loadCalls(rec.slug);
    // Contribution awards land AFTER commit, off the hot path. The distinct-count
    // read races with concurrent calls, but the dedup key makes a double-award at
    // "exactly 3" impossible, so a race at worst awards on someone else's insert.
    const distinct = await db().query<{ n: number }>(
      `SELECT count(DISTINCT device_id)::int n FROM market_call WHERE slug=$1 AND device_id IS NOT NULL`, [rec.slug],
    ).then((r) => r.rows[0]?.n ?? 0).catch(() => 0);
    void awardParticipation(rec.slug, deviceId, firstEver, distinct);
    void notifyOppositeSide(rec.slug, rec.market.question, deviceId, side);
    return { ok: true, id: ins.rows[0].id, balance: upd.rows[0].tokens, calls: rec.calls.length, pctAt, firstEver };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type SellResult =
  | { ok: true; balance: number; proceeds: number; stake: number; entryPct: number; exitPct: number; edge: number }
  | { ok: false; reason: "not-found" | "already-closed" | "no-entry-price" | "unpriced" };

/**
 * Close a position at the venue's current price for that side.
 *
 * Selling and settling are the same act at different prices, so this writes the
 * same three columns settlement will: when it left, at what price, for how much.
 * The edge is never stored — it is `exit_pct - pct_at`, and a stored copy is a
 * second source of truth waiting to disagree with the first.
 *
 * The row is locked FOR UPDATE before anything is credited, so a double-tapped
 * Sell button pays out once: the second transaction finds `closed_at` set.
 */
export async function sellPosition(
  id: number,
  rawDeviceId: string,
  liveMarkets: Market[] = [],
): Promise<SellResult> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) {
    const pos = memCalls.find((c) => c.id === id && c.deviceId === deviceId);
    if (!pos) return { ok: false, reason: "not-found" };
    if (pos.closedAt) return { ok: false, reason: "already-closed" };
    const exitPct = livePctOf(pos.slug, pos.side, liveMarkets);
    if (exitPct === null) return { ok: false, reason: "unpriced" };
    const proceeds = proceedsFor(pos.tokens, pos.entryPct, exitPct);
    pos.closedAt = new Date().toISOString();
    pos.exitPct = exitPct;
    pos.proceeds = proceeds;
    const w = memBalance.get(deviceId)!;
    memBalance.set(deviceId, { ...w, tokens: w.tokens + proceeds });
    return { ok: true, balance: w.tokens + proceeds, proceeds, stake: pos.tokens, entryPct: pos.entryPct, exitPct, edge: edgePts(pos.entryPct, exitPct) };
  }

  await ensureSchema();
  // Price the market before opening the transaction: it is a network read, and
  // a row lock held across one is a lock held for as long as a venue is slow.
  const head = await db().query<{ slug: string; side: "yes" | "no"; tokens: number; pct_at: number | null; closed_at: Date | null }>(
    `SELECT slug, side, tokens, pct_at, closed_at FROM market_call WHERE id = $1 AND device_id = $2`,
    [id, deviceId],
  );
  if (head.rows.length === 0) return { ok: false, reason: "not-found" };
  if (head.rows[0].closed_at) return { ok: false, reason: "already-closed" };
  if (head.rows[0].pct_at === null) return { ok: false, reason: "no-entry-price" };

  const exitPct = livePctOf(head.rows[0].slug, head.rows[0].side, liveMarkets);
  if (exitPct === null) return { ok: false, reason: "unpriced" };

  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ tokens: number; pct_at: number; closed_at: Date | null }>(
      `SELECT tokens, pct_at, closed_at FROM market_call WHERE id = $1 AND device_id = $2 FOR UPDATE`,
      [id, deviceId],
    );
    if (locked.rows.length === 0) { await client.query("ROLLBACK"); return { ok: false, reason: "not-found" }; }
    if (locked.rows[0].closed_at) { await client.query("ROLLBACK"); return { ok: false, reason: "already-closed" }; }

    const stake = locked.rows[0].tokens;
    const entryPct = locked.rows[0].pct_at;
    const proceeds = proceedsFor(stake, entryPct, exitPct);

    await client.query(
      `UPDATE market_call SET closed_at = now(), exit_pct = $1, proceeds = $2 WHERE id = $3 AND closed_at IS NULL`,
      [exitPct, proceeds, id],
    );
    const bal = await client.query<{ tokens: number }>(
      `UPDATE device_balance SET tokens = tokens + $1 WHERE device_id = $2 RETURNING tokens`,
      [proceeds, deviceId],
    );
    await client.query("COMMIT");
    return { ok: true, balance: bal.rows[0].tokens, proceeds, stake, entryPct, exitPct, edge: edgePts(entryPct, exitPct) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface Positions {
  open: OpenPosition[];
  closed: ClosedPosition[];
  overall: Reputation;
  /** Reputation per category, so "good at crypto, hopeless at football" is visible. */
  byCategory: (Reputation & { category: string })[];
}

interface CallRow {
  id: number; slug: string; question: string; side: "yes" | "no"; tokens: number;
  pct_at: number | null; exit_pct: number | null; proceeds: number | null;
  at: Date | string; closed_at: Date | string | null;
}

function splitPositions(rows: CallRow[], liveMarkets: Market[]): Positions {
  const iso = (d: Date | string) => (typeof d === "string" ? d : d.toISOString());
  const open: OpenPosition[] = [];
  const closed: ClosedPosition[] = [];

  for (const r of rows) {
    const category = categorizeText(r.question);
    if (r.closed_at && r.pct_at !== null && r.exit_pct !== null) {
      closed.push({
        id: r.id, slug: r.slug, question: r.question, category, side: r.side, tokens: r.tokens,
        entryPct: r.pct_at, exitPct: r.exit_pct, proceeds: r.proceeds ?? 0,
        edge: edgePts(r.pct_at, r.exit_pct), at: iso(r.at), closedAt: iso(r.closed_at),
      });
      continue;
    }
    if (r.closed_at) continue; // closed but unscorable: a row from before prices were stored
    // An open position from before `pct_at` existed has no entry price, so it
    // cannot be priced, sold or scored. It is shown, honestly, as unpriced.
    const entryPct = r.pct_at;
    const nowPct = entryPct === null ? null : livePctOf(r.slug, r.side, liveMarkets);
    open.push({
      id: r.id, slug: r.slug, question: r.question, category, side: r.side, tokens: r.tokens,
      entryPct: entryPct ?? 0,
      nowPct,
      edgeNow: entryPct !== null && nowPct !== null ? edgePts(entryPct, nowPct) : null,
      // NOTE (flagged for review, not decided here): valueNow is still the OLD
      // proportional mark-to-market (proceedsFor), inherited from when a stake
      // could be any size. Now that every call stakes exactly CALL_COST (1),
      // this can only ever resolve to 0 or 1 — the live "sell now" price lost
      // its granularity along with variable staking. toWin below is fixed to
      // the real payout (winBonus, floor/cap included) so it never overstates
      // what settlement will actually pay; valueNow's degraded precision is a
      // separate, pre-existing feature (cash-out / sellPosition) this redesign
      // did not touch.
      valueNow: entryPct !== null && nowPct !== null ? proceedsFor(r.tokens, entryPct, nowPct) : null,
      toWin: entryPct ? winBonus(entryPct) : 0,
      at: iso(r.at),
    });
  }

  const overall = reputationOf(closed.map((c) => c.edge));
  const byCat = new Map<string, number[]>();
  for (const c of closed) byCat.set(c.category, [...(byCat.get(c.category) ?? []), c.edge]);
  const byCategory = [...byCat.entries()]
    .map(([category, edges]) => ({ category, ...reputationOf(edges) }))
    .sort((a, b) => (b.avgEdge ?? 0) - (a.avgEdge ?? 0));

  return { open, closed, overall, byCategory };
}

/** Everything the Positions screen shows: what is live, what is done, and the score. */
export async function positionsFor(rawDeviceId: string, liveMarkets: Market[] = []): Promise<Positions> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) {
    const rows: CallRow[] = memCalls
      .filter((c) => c.deviceId === deviceId)
      .map((c) => ({ id: c.id, slug: c.slug, question: c.question, side: c.side, tokens: c.tokens,
        pct_at: c.entryPct, exit_pct: c.exitPct, proceeds: c.proceeds, at: c.at, closed_at: c.closedAt }));
    return splitPositions(rows, liveMarkets);
  }
  await ensureSchema();
  const { rows } = await db().query<CallRow>(
    `SELECT c.id, c.slug, s.question, c.side, c.tokens, c.pct_at, c.exit_pct, c.proceeds, c.at, c.closed_at
       FROM market_call c JOIN market_slug s ON s.slug = c.slug
      WHERE c.device_id = $1 ORDER BY c.at DESC`,
    [deviceId],
  );
  return splitPositions(rows, liveMarkets);
}

export interface LeaderRow {
  deviceId: string;
  /** What the row is called in public: the X handle if one is linked, else the
   *  device's own (random or chosen) handle, else a last-resort device stub. */
  handle: string;
  avgEdge: number;
  closed: number;
  provisional: boolean;
  /** Raw hit rate, 0-100. Null while provisional — the same gate accuracyFor
   *  applies, because a percentage over three calls is noise wearing a number.
   *  The board still RANKS by edge; this rides along because accuracy is how
   *  people describe themselves ("64% accurate"), and a board that shows only
   *  a calibration metric can't be quoted back by the person on it. */
  accuracyPct: number | null;
  /** What the board RANKS by — the same figure the profile shows. */
  oddies: number;
  /** >=1. Shown as a badge where earned, so the board says out loud that
   *  posting is what moves it. */
  loudMultiplier: number;
}

/**
 * Ranked by ODDIES — the same number the profile shows, the cards print and
 * every award pays into.
 *
 * It used to rank by average edge alone, and that quietly made the scoreboard
 * measure something different from the economy. Tagging a market, bringing a
 * crowd to it, posting about oddie and earning the loud multiplier all move a
 * player\'s oddies and moved this board not at all — so the one surface that
 * says "here is who is winning" was answering a question nobody was being
 * paid to win. Ranking by oddies makes it a loudness board by construction,
 * because loudness is already inside the number.
 *
 * Accuracy is not lost: it is the quality multiplier inside oddies, and
 * accuracyPct still rides along as the column people quote themselves with.
 *
 * Provisional players are listed and marked rather than hidden — a board that
 * only shows finished players gives a new one nothing to climb toward — but
 * they sort below everyone whose number has settled.
 */
/** How many edge-ranked candidates get their oddies computed. See the bound
 *  note in leaderboard() for when this stops being the right shape. */
const LEADERBOARD_SCORE_CANDIDATES = 40;

export async function leaderboard(limit = 20): Promise<LeaderRow[]> {
  let rows: { device_id: string; edges: number[]; handle: string | null; correct: number; settled: number }[];
  if (!PERSISTENT) {
    const byDev = new Map<string, number[]>();
    const correctByDev = new Map<string, number>();
    for (const c of memCalls) {
      if (!c.closedAt || c.exitPct === null) continue;
      byDev.set(c.deviceId, [...(byDev.get(c.deviceId) ?? []), edgePts(c.entryPct, c.exitPct)]);
      // exit_pct 100 = the side they took happened. A SOLD position exits at
      // the market price, not 0/100, so it contributes an edge but is not a
      // right-or-wrong outcome — same rule resolvedRowsFor uses.
      if (c.exitPct === 100) correctByDev.set(c.deviceId, (correctByDev.get(c.deviceId) ?? 0) + 1);
    }
    // Every device that has CALLED anything, not only those with something
    // closed. Edges stay empty until a market resolves; the row exists from
    // the first call.
    const called = new Set(memCalls.filter((c) => c.deviceId).map((c) => c.deviceId));
    rows = [...called].map((device_id) => ({
      device_id, edges: byDev.get(device_id) ?? [], handle: memHandle.get(device_id) ?? null,
      correct: correctByDev.get(device_id) ?? 0,
      settled: memCalls.filter((c) => c.deviceId === device_id && (c.exitPct === 100 || c.exitPct === 0)).length,
    }));
  } else {
    await ensureSchema();
    // The X handle outranks the chosen one and both outrank the stub, so the
    // board names people the way the rest of the product does.
    const q = await db().query<{ device_id: string; edges: number[]; handle: string | null; correct: number; settled: number }>(
      `SELECT mc.device_id,
              COALESCE(array_agg(mc.exit_pct - mc.pct_at)
                       FILTER (WHERE mc.closed_at IS NOT NULL AND mc.pct_at IS NOT NULL AND mc.exit_pct IS NOT NULL),
                       '{}') AS edges,
              COUNT(*) FILTER (WHERE mc.exit_pct = 100)::int AS correct,
              COUNT(*) FILTER (WHERE mc.exit_pct IN (0, 100))::int AS settled,
              COALESCE(tw.handle, db.handle) AS handle
         FROM market_call mc
         LEFT JOIN device_balance db ON db.device_id = mc.device_id
         LEFT JOIN LATERAL (
           SELECT a.handle FROM account a
            WHERE a.canonical_device = mc.device_id AND a.provider = 'twitter' AND a.handle IS NOT NULL
            ORDER BY a.created_at LIMIT 1
         ) tw ON true
        WHERE mc.device_id IS NOT NULL
        GROUP BY mc.device_id, tw.handle, db.handle`,
    );
    rows = q.rows;
  }

  // A board row without a name gets one minted on the spot — same generator,
  // same uniqueness — so devices from before handles existed never show a stub.
  for (const r of rows) {
    if (!r.handle) r.handle = await ensureHandle(r.device_id).catch(() => `#${r.device_id.slice(0, 4)}`);
  }

  // See excludedLeaderboardDeviceId — the brand's own @oddiefun account never
  // competes on a public board.
  const excludedId = await excludedLeaderboardDeviceId();
  const ranked = rows
    .map((r) => {
      const rep = reputationOf(r.edges.map(Number));
      return {
        deviceId: r.device_id,
        // Stored X handles carry their own "@"; the UI prefixes one for everybody,
        // so strip it here or the board reads "@@levvercetti" (it did).
        handle: (r.handle ?? `#${r.device_id.slice(0, 4)}`).replace(/^@+/, ""),
        ...rep,
        // A caller with nothing resolved yet has no edge to average. They are
        // still on the board — the behaviour the product pays most for (tag a
        // market, bring a crowd, post about it) earns oddies the same day,
        // while a resolution can be weeks out, and a board that hides its
        // newest loud player until then gives the flywheel's freshest fuel no
        // recognition at all. They read as provisional and sort below every
        // settled record, so appearing costs credibility nothing: you can be
        // seen without ever outranking somebody who has actually been right.
        avgEdge: rep.avgEdge ?? 0,
        provisional: rep.avgEdge === null ? true : rep.provisional,
        // Computed over SETTLED calls only (the 0/100 exits), not over every
        // closed one — a sold position has an edge but no verdict, so counting
        // it in the denominator would quietly understate everyone who scalps.
        // WITHHELD while provisional, matching accuracyFor everywhere else: a
        // percentage over three calls is noise wearing a number, and the board
        // is the one place people would quote it from.
        accuracyPct: !rep.provisional && r.settled > 0
          ? Math.round((r.correct / r.settled) * 100) : null,
      };
    })
    .filter((r) => r.deviceId !== excludedId);

  // Everyone on the loudness ladder who has never taken a play position.
  //
  // The candidate list above is built from market_call, and nothing writes
  // market_call any more, so the board could only ever show people who were
  // playing before the pivot. Someone who tags markets every day and brings a
  // crowd to every one of them was invisible on the one surface that says
  // "here is who is winning", while the landing page invited them to climb it.
  const known = new Set(ranked.map((r) => r.deviceId));
  for (const l of await loudnessRanking().catch(() => [])) {
    if (known.has(l.deviceId) || l.deviceId === excludedId) continue;
    ranked.push({
      deviceId: l.deviceId,
      handle: (await ensureHandle(l.deviceId).catch(() => `#${l.deviceId.slice(0, 4)}`)).replace(/^@+/, ""),
      avgEdge: 0, closed: 0, provisional: true, accuracyPct: null,
    });
  }
  // Sorted by oddies alone. It used to put every provisional row below every
  // settled one, which on a board that no longer settles anything means the
  // people the product actually pays would sort under a frozen historical tail
  // no matter how loud they got.
  ranked.sort((a, b) => b.avgEdge - a.avgEdge);

  // Oddies for the rows that could plausibly place. accuracyFor is reused
  // rather than reimplemented so the board can never disagree with the profile
  // about a person\'s number.
  //
  // KNOWN BOUND, stated rather than hidden: this is one accuracyFor per
  // candidate, and it is capped at LEADERBOARD_SCORE_CANDIDATES. At today\'s
  // handful of players that is a few reads on a page nobody loads in a loop.
  // It stops being acceptable the moment the candidate list is long — the fix
  // then is set-based aggregates keyed by device, not a bigger cap.
  const candidates = ranked.slice(0, LEADERBOARD_SCORE_CANDIDATES);
  const scored = await Promise.all(candidates.map(async (r) => {
    const acc = await accuracyFor(r.deviceId).catch(() => null);
    return { ...r, oddies: acc?.oddieScore ?? 0, loudMultiplier: acc?.loudMultiplier ?? 1 };
  }));
  return scored
    .sort((a, b) => b.oddies - a.oddies || b.avgEdge - a.avgEdge)
    .slice(0, limit);
}

// --- Week-1 events ----------------------------------------------------------

/** The only names that are ever written. An unknown name is dropped, not stored. */
export const EVENT_NAMES = ["feed_view", "card_view", "side_tap", "amount_confirm", "cat_change", "sell", "share_open", "share_done", "alerts_view", "notice_view", "allowlist_denied", "invite_sent", "invite_accepted", "taste_pick", "gate_shown", "gate_signin", "challenge_click", "save_nudge_shown", "save_nudge_dismissed", "loud_claim_open", "loud_submit", "feed_end_tag"] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export interface EventInput {
  name: EventName;
  deviceId: string;
  slug?: string | null;
  idx?: number | null;
  side?: "yes" | "no" | null;
  cat?: string | null;
}

/**
 * Append one event. Two sinks, deliberately:
 *
 *  - a JSON line on stdout, which lands in `railway logs` and is greppable
 *    within seconds of a deploy, with no database to be up;
 *  - a row in Postgres, which survives log rotation. Railway's log retention is
 *    shorter than a week on the current plan, and Week 1 is a week.
 *
 * Neither sink stores an IP, a user agent, or anything a person typed. Failure
 * to write is logged and swallowed: an analytics outage must never turn into a
 * feed that will not load.
 */
export async function recordEvent(e: EventInput): Promise<void> {
  console.log(JSON.stringify({ evt: e.name, did: e.deviceId, slug: e.slug ?? null, idx: e.idx ?? null, side: e.side ?? null, cat: e.cat ?? null }));
  if (!PERSISTENT) return;
  try {
    await ensureSchema();
    await db().query(`INSERT INTO event (name, device_id, slug, idx, side, cat) VALUES ($1,$2,$3,$4,$5,$6)`, [
      e.name,
      e.deviceId,
      e.slug ?? null,
      e.idx ?? null,
      e.side ?? null,
      e.cat ?? null,
    ]);
  } catch (err) {
    console.error("[store] event write failed:", (err as Error).message);
  }
}

/* ------------------------------------------------------------------ handles --
 * One identity system, two sources: an anonymous device carries a random,
 * editable handle on its balance row; a linked X account's real @handle wins at
 * display time (the server composes that — the store only owns the stored one).
 */

const memHandle = new Map<string, string>();

/** The device's stored handle, minting a random one on first sight. */
export async function ensureHandle(rawDeviceId: string): Promise<string> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) {
    let h = memHandle.get(deviceId);
    if (!h) {
      do { h = randomHandle(); } while ([...memHandle.values()].includes(h));
      memHandle.set(deviceId, h);
    }
    return h;
  }

  await ensureSchema();
  await db().query(`INSERT INTO device_balance (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [deviceId]);
  const cur = await db().query<{ handle: string | null }>(`SELECT handle FROM device_balance WHERE device_id = $1`, [deviceId]);
  if (cur.rows[0]?.handle) return cur.rows[0].handle;

  // Mint against the unique index. `handle IS NULL` keeps a race between two
  // tabs from overwriting a name the other tab just won.
  for (let i = 0; i < 12; i++) {
    const candidate = randomHandle();
    try {
      const upd = await db().query<{ handle: string }>(
        `UPDATE device_balance SET handle = $1 WHERE device_id = $2 AND handle IS NULL RETURNING handle`,
        [candidate, deviceId],
      );
      if (upd.rows.length === 1) return upd.rows[0].handle;
      const again = await db().query<{ handle: string | null }>(`SELECT handle FROM device_balance WHERE device_id = $1`, [deviceId]);
      if (again.rows[0]?.handle) return again.rows[0].handle; // the other tab won; use its name
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err; // 23505 = collision; roll again
    }
  }
  throw new Error("could not mint a unique handle");
}

export type SetHandleResult = { ok: true; handle: string } | { ok: false; reason: string };

/** Rename. Validation is handles.ts's; uniqueness is the index's; this stitches them. */
export async function setHandle(rawDeviceId: string, proposed: string): Promise<SetHandleResult> {
  const verdict = validateHandle(proposed);
  if (!verdict.ok) return verdict;
  const deviceId = await resolveDevice(rawDeviceId);

  if (!PERSISTENT) {
    const taken = [...memHandle.entries()].some(([d, h]) => d !== deviceId && h.toLowerCase() === verdict.handle);
    if (taken) return { ok: false, reason: "already taken" };
    memHandle.set(deviceId, verdict.handle);
    return { ok: true, handle: verdict.handle };
  }

  await ensureSchema();
  await db().query(`INSERT INTO device_balance (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [deviceId]);
  try {
    await db().query(`UPDATE device_balance SET handle = $1 WHERE device_id = $2`, [verdict.handle, deviceId]);
    return { ok: true, handle: verdict.handle };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { ok: false, reason: "already taken" };
    throw err;
  }
}

/* ------------------------------------------------------------------ notices --
 * Real notifications. A row is appended when something actually happened to
 * this stream — settlement, today — and the UI only ever reads.
 */

export interface Notice {
  id: number;
  kind: string;
  body: string;
  delta: number | null;
  slug: string | null;
  /** The settled call this notice is about, so the alert can mint its share card. */
  callId: number | null;
  at: string;
  /** Settlement notices only: the odds they took (their side's price) and the
   *  resolved outcome — enough for the client to build a "Share to X" intent. */
  oddsPct?: number | null;
  outcome?: "yes" | "no" | null;
}

interface MemNotice extends Notice { deviceId: string; seenAt: string | null; count: number | null }
const memNotices: MemNotice[] = [];
let memNoticeId = 0;

export async function noticesFor(rawDeviceId: string, limit = 30): Promise<Notice[]> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) {
    return memNotices.filter((n) => n.deviceId === deviceId).slice(0, limit)
      .map(({ deviceId: _d, seenAt: _s, count: _c, ...n }) => n);
  }
  await ensureSchema();
  // Join the settled call so a settlement notice carries the odds they took and
  // the resolved outcome (won ⇒ their side, else the opposite) for the share intent.
  const { rows } = await db().query<{
    id: number; kind: string; body: string; delta: number | null; slug: string | null; call_id: number | null; created_at: Date;
    pct_at: number | null; side: "yes" | "no" | null; exit_pct: number | null;
  }>(
    `SELECT n.id, n.kind, n.body, n.delta, n.slug, n.call_id, n.created_at, mc.pct_at, mc.side, mc.exit_pct
       FROM notice n LEFT JOIN market_call mc ON mc.id = n.call_id
      WHERE n.device_id = $1 ORDER BY n.created_at DESC, n.id DESC LIMIT $2`,
    [deviceId, limit],
  );
  return rows.map((r) => {
    const settle = r.kind === "settle_win" || r.kind === "settle_loss";
    const won = r.exit_pct === 100;
    const outcome = settle && r.side ? (won ? r.side : r.side === "yes" ? "no" : "yes") : null;
    return {
      id: r.id, kind: r.kind, body: r.body, delta: r.delta, slug: r.slug, callId: r.call_id, at: r.created_at.toISOString(),
      oddsPct: settle && r.pct_at != null ? Math.max(1, Math.min(99, Math.round(r.pct_at))) : null,
      outcome,
    };
  });
}

// --- Accuracy record (per user, per category) -------------------------------
// The public reputation metric. Derived, not stored: a RESOLVED pick is a
// settled market_call whose exit_pct is exactly 0 or 100 (a SOLD position exits
// at a live 1–99 price, so this cleanly excludes trading from the record).
// correct = exit_pct 100; category = the community category if any, else the
// market's. Streaks are chronological by resolution time.
const MIN_RESOLVED_FOR_ACCURACY = 5;   // below this: "building track record", no %
const MIN_PER_CATEGORY_FOR_BEST = 2;   // don't crown "100% in Crypto" off one pick

export interface CategoryAccuracy { category: string; resolved: number; correct: number; pct: number }
export interface AccuracyRecord {
  resolved: number;
  correct: number;
  accuracyPct: number | null; // raw hit rate — null until resolved >= minResolved
  // The one score. Activity sets the magnitude (resolved calls, markets you
  // created, contribution points); meanEdge — mean(outcome − impliedProb), how
  // much you beat the odds you took — scales it between 0.5x and 1.5x. The
  // formula lives in economy.ts's oddieScoreFrom, which is its only definition.
  oddieScore: number | null;  // >= 0, unbounded; null until hasEnough
  /** >=1, the loud multiplier applied to the markets half (see economy.ts). */
  loudMultiplier: number;
  /** Markets this device put on the board. The score's biggest rung, and what
   *  the entry badge is judged on, so every surface reads it from here. */
  marketsCreated: number;
  /** Points credited to the growth ledger, the score's other half. */
  contributionPoints: number;
  /**
   * ALWAYS 0. DO NOT DISPLAY.
   *
   * creatorStatsFor computes it with COUNT(DISTINCT market_call.device_id), and
   * market_call is the dead play-token table. Real positions are per-user PDAs
   * on chain with no index, so there is no cheap count of "people in your
   * markets" and this cannot be revived by fixing a query. The honest reach
   * figure is pooledLamports, which /api/me/earnings sums off chain.
   *
   * Kept only so scoreActivityFor's shape does not change under its callers.
   */
  tradersReached: number;
  meanEdge: number | null;    // −1..1, the raw signal behind the score
  hasEnough: boolean;
  minResolved: number;
  streak: number;             // current trailing consecutive-correct
  bestStreak: number;
  bestTopic: { category: string; pct: number; resolved: number } | null;
  // Per-category accuracy, gated the SAME way the global accuracyPct is: a
  // category needs its own MIN_RESOLVED_FOR_ACCURACY resolved picks before it
  // appears here at all. A category short of that bar is simply absent — never
  // a placeholder, never a misleadingly-precise % off a couple of picks. (Not to
  // be confused with bestTopic above, a DIFFERENT, lower bar — "best topic" is
  // allowed to crown a category off a smaller sample.)
  byCategory: CategoryAccuracy[];
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Pure: resolved picks in RESOLUTION order (oldest first) → the record. Each
 *  row carries `pct` = the implied probability of the side they took (0..1). */
function computeAccuracy(
  rows: { correct: boolean; category: string; pct: number }[],
  /** Activity terms. Defaulted so every existing caller and test keeps working
   *  and gets the accuracy-only half of the score; accuracyFor supplies the
   *  real numbers. */
  activity: { marketsCreated?: number; contributionPoints?: number; callsMade?: number; loudMultiplier?: number; tradersReached?: number } = {},
): AccuracyRecord {
  const resolved = rows.length;
  const correct = rows.filter((r) => r.correct).length;

  let cur = 0, best = 0;
  for (const r of rows) { if (r.correct) { cur++; if (cur > best) best = cur; } else cur = 0; }

  // Calibration-adjusted score: per pick, edge = outcome(1|0) − impliedProb.
  const meanEdge = resolved ? rows.reduce((a, r) => a + ((r.correct ? 1 : 0) - r.pct), 0) / resolved : 0;
  // The score is now activity-led — see oddieScoreFrom in economy.ts for the
  // formula and for why it is weighted that way. This file no longer decides
  // what a score is; it supplies the inputs.
  const marketsCreated = activity.marketsCreated ?? 0;
  const oddieScore = oddieScoreFrom({
    callsMade: activity.callsMade ?? 0,
    resolvedCalls: resolved,
    marketsCreated,
    contributionPoints: activity.contributionPoints ?? 0,
    meanEdge: resolved ? meanEdge : null,
    loudMultiplier: activity.loudMultiplier ?? 1,
  });

  /**
   * Whether there is a record here worth showing a number for.
   *
   * This used to be `resolved >= MIN_RESOLVED_FOR_ACCURACY`: ten settled play
   * positions. Nothing settles play positions any more, so that gate had
   * quietly become permanently false, and with it went the score, the rank and
   * every badge. The whole trophy room was invisible to everyone who arrived
   * after the pivot.
   *
   * The ladder answers the same question directly: you have a record once you
   * have earned something on it.
   */
  const hasEnough = oddieScore > 0;

  const m = new Map<string, { resolved: number; correct: number }>();
  for (const r of rows) { const e = m.get(r.category) ?? { resolved: 0, correct: 0 }; e.resolved++; if (r.correct) e.correct++; m.set(r.category, e); }
  const byCategoryAll: CategoryAccuracy[] = [...m.entries()]
    .map(([category, e]) => ({ category, resolved: e.resolved, correct: e.correct, pct: Math.round((100 * e.correct) / e.resolved) }))
    .sort((a, b) => b.pct - a.pct || b.resolved - a.resolved);
  // "Best topic" keeps its own, lower bar (MIN_PER_CATEGORY_FOR_BEST) — a category
  // can be someone's standout even off a couple of picks. The displayed BREAKDOWN
  // below reuses the global accuracy threshold instead: the same "building track
  // record" convention, applied per category rather than to the whole record.
  const topPick = byCategoryAll.filter((c) => c.resolved >= MIN_PER_CATEGORY_FOR_BEST)[0] ?? byCategoryAll[0] ?? null;
  const byCategory = byCategoryAll.filter((c) => c.resolved >= MIN_RESOLVED_FOR_ACCURACY);

  return {
    resolved, correct,
    // Gated on RESOLVED, never on hasEnough. The two used to mean the same
    // thing; hasEnough now means "there is something on the loudness ladder",
    // and a device can have a score with zero resolved picks. Guarding a
    // division by hasEnough then computes 0/0, and Math.round(NaN) is NaN,
    // which is not `== null` and so passes every downstream null check: it
    // reached the share PNG, the og:description and a pre-filled tweet as the
    // literal text "NaN% accuracy".
    accuracyPct: resolved >= MIN_RESOLVED_FOR_ACCURACY ? Math.round((100 * correct) / resolved) : null,
    // NOT gated on hasEnough. That gate exists so a hit-rate is never quoted off
    // two picks — a sample-size problem, and the right call for accuracyPct. The
    // score is activity-led now, and activity is not a sample: someone who has
    // tagged ten markets has genuinely earned something, and holding their score
    // at null until five of their CALLS resolve would hide the half of the
    // formula that is supposed to dominate. Null only when there is no activity
    // at all, which is the honest "nothing yet".
    oddieScore: oddieScore > 0 ? oddieScore : null,
    loudMultiplier: activity.loudMultiplier ?? 1,
    marketsCreated,
    contributionPoints: activity.contributionPoints ?? 0,
    tradersReached: activity.tradersReached ?? 0,
    meanEdge: resolved >= MIN_RESOLVED_FOR_ACCURACY ? Math.round(meanEdge * 1000) / 1000 : null,
    hasEnough, minResolved: MIN_RESOLVED_FOR_ACCURACY,
    streak: cur, bestStreak: best,
    bestTopic: topPick ? { category: topPick.category, pct: topPick.pct, resolved: topPick.resolved } : null,
    byCategory,
  };
}

type ResolvedRow = { correct: boolean; category: string; pct: number; closedAt: string };

/** Every resolved, decisively-settled pick for a (already-resolved) device, in
 *  resolution order — the raw material both accuracyFor and weeklyScoreDeltaFor
 *  run computeAccuracy over. Pulled into its own function so the two never drift
 *  on what counts as "resolved" (see the comment above accuracyFor). */
async function resolvedRowsFor(deviceId: string): Promise<ResolvedRow[]> {
  // pct = the implied probability of the side taken (their price ÷ 100), clamped
  // to (0,1). It is what the calibration score is measured against.
  const prob = (pctAt: number) => clamp(pctAt / 100, 0.01, 0.99);
  if (!PERSISTENT) {
    return memCalls
      .filter((c) => c.deviceId === deviceId && c.closedAt && (c.exitPct === 100 || c.exitPct === 0) && c.entryPct != null)
      .sort((a, b) => (a.closedAt! < b.closedAt! ? -1 : a.closedAt! > b.closedAt! ? 1 : a.id - b.id))
      .map((c) => ({ correct: c.exitPct === 100, category: memCommunity.get(c.slug)?.category ?? categorizeText(c.question), pct: prob(c.entryPct), closedAt: c.closedAt! }));
  }
  await ensureSchema();
  const { rows: qr } = await db().query<{ exit_pct: number; pct_at: number; question: string; comm_cat: string | null; closed_at: Date }>(
    `SELECT mc.exit_pct, mc.pct_at, s.question, cm.category AS comm_cat, mc.closed_at
       FROM market_call mc
       JOIN market_slug s ON s.slug = mc.slug
       LEFT JOIN community_market cm ON cm.slug = mc.slug
      WHERE mc.device_id = $1 AND mc.closed_at IS NOT NULL
        AND mc.exit_pct IN (0, 100) AND mc.pct_at IS NOT NULL
      ORDER BY mc.closed_at ASC, mc.id ASC`,
    [deviceId],
  );
  return qr.map((r) => ({ correct: r.exit_pct === 100, category: r.comm_cat ?? categorizeText(r.question), pct: prob(r.pct_at), closedAt: r.closed_at.toISOString() }));
}

/** The activity half of the score, read once. Every surface that recomputes a
 *  score for a device needs the same three numbers, and reading them in one
 *  place is what stops the app quoting two different scores for one person. */
export async function scoreActivityFor(rawDeviceId: string): Promise<{ marketsCreated: number; contributionPoints: number; callsMade: number; loudMultiplier: number; tradersReached: number }> {
  const deviceId = await resolveDevice(rawDeviceId);
  const [creator, contributionPoints, callsMade, loud] = await Promise.all([
    creatorStatsFor(deviceId).catch(() => null),
    seasonPointsFor(deviceId).catch(() => 0),
    callsMadeFor(deviceId).catch(() => 0),
    loudStatusFor(deviceId).catch(() => ({ multiplier: 1 })),
  ]);
  return { marketsCreated: creator?.marketsCreated ?? 0, tradersReached: creator?.tradersReached ?? 0, contributionPoints, callsMade, loudMultiplier: loud.multiplier };
}

/** Every call this device has taken, open or closed. The volume half of the
 *  score — counted the moment a call is made, not when it resolves. */
/**
 * How many DISTINCT markets a day, at most, can earn a device its per-call
 * oddies. Calls themselves are free and unlimited — the cap is on the reward,
 * never on playing — so somebody can swipe through a hundred markets in a
 * sitting and every one of them still becomes a position, a resolution and a
 * verdict post. What it stops is the printer: with calls costing nothing, an
 * uncapped per-call award would mint oddies for hammering a button.
 *
 * Set where a real session lands and an abuser does not: full-screen cards
 * make ten to twenty swipes an engaged sitting, so a genuine player finishes
 * theirs without ever meeting the cap and only deliberate grinding hits it.
 */
export const DAILY_EARNING_MARKETS = 20;

/**
 * The volume half of the score: distinct markets called, counted per day and
 * capped at DAILY_EARNING_MARKETS each, then summed across days.
 *
 * Per DAY and per MARKET, both deliberately. Per market, because the same
 * market called twice is not twice the volume. Per day, because the cap has to
 * bound a rate rather than a lifetime — a lifetime cap would punish the
 * regular who has been here a year, which is exactly backwards.
 */
export async function callsMadeFor(rawDeviceId: string): Promise<number> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) {
    const perDay = new Map<string, Set<string>>();
    for (const c of memCalls) {
      if (c.deviceId !== deviceId) continue;
      const day = c.at.slice(0, 10);
      (perDay.get(day) ?? perDay.set(day, new Set()).get(day)!).add(c.slug);
    }
    let n = 0;
    for (const slugs of perDay.values()) n += Math.min(slugs.size, DAILY_EARNING_MARKETS);
    return n;
  }
  await ensureSchema();
  const { rows } = await db().query<{ n: string }>(
    `SELECT COALESCE(SUM(LEAST(d.n, $2)), 0)::text AS n
       FROM (SELECT count(DISTINCT slug) AS n
               FROM market_call WHERE device_id = $1
              GROUP BY date_trunc('day', at)) d`, [deviceId, DAILY_EARNING_MARKETS]);
  return Number(rows[0]?.n ?? 0);
}

export async function accuracyFor(rawDeviceId: string): Promise<AccuracyRecord> {
  const deviceId = await resolveDevice(rawDeviceId);
  const [rows, activity] = await Promise.all([
    resolvedRowsFor(deviceId),
    scoreActivityFor(deviceId),
  ]);
  return computeAccuracy(rows, activity);
}

export interface WeeklyScoreDelta { delta: number; direction: "up" | "down" }
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The Oddie Score's motion this week — "the trophy room has a sense of
 *  motion" — computed by re-running computeAccuracy on the SAME chronological
 *  record twice: once over everything, once over everything strictly before
 *  the 7-day cutoff. The difference is exactly what this week's resolutions
 *  did to the score, not an approximation. null (hide, never a "▲ +0" from
 *  thin air) when nothing resolved in the window at all — the UI's cue to omit
 *  the line entirely rather than show a stale or manufactured number. */
/**
 * What this week actually added, on the ladder the score is now made of.
 *
 * It used to measure the week's RESOLUTIONS: it recomputed accuracy with and
 * without them and reported the difference. That reading is gone with the play
 * economy, because resolutions no longer move the score at all and the answer
 * became a permanent null.
 *
 * So it measures the same thing the score does: points credited to the growth
 * ledger in the last seven days, doubled by the same weight the total uses.
 * Markets tagged already pay into that ledger on surfacing, so a week spent
 * tagging shows up here without counting the same act twice.
 */
export async function weeklyScoreDeltaFor(rawDeviceId: string): Promise<WeeklyScoreDelta | null> {
  const deviceId = await resolveDevice(rawDeviceId);
  const cutoff = Date.now() - WEEK_MS;
  let earned = 0;    // growth-ledger points credited in the window
  let tagged = 0;    // markets put on the board in the window

  if (!PERSISTENT) {
    for (const r of memSeasonLog) {
      if (r.deviceId !== deviceId) continue;
      if (Date.parse(r.createdAt) < cutoff) continue;
      earned += r.amount;
    }
    for (const [, sf] of memSurfacer) {
      if (sf.deviceId !== deviceId) continue;
      if (Date.parse(sf.createdAt) < cutoff) continue;
      tagged++;
    }
  } else {
    await ensureSchema();
    const [pts, made] = await Promise.all([
      db().query<{ total: string | null }>(
        `SELECT SUM(amount)::bigint AS total FROM season_points_log
          WHERE device_id = $1 AND created_at >= now() - interval '7 days'`, [deviceId]),
      db().query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM market_surfacer
          WHERE device_id = $1 AND created_at >= now() - interval '7 days'`, [deviceId]),
    ]);
    earned = Number(pts.rows[0]?.total ?? 0);
    tagged = Number(made.rows[0]?.n ?? 0);
  }

  if (!earned && !tagged) return null;   // a quiet week says nothing rather than "+0"
  // BOTH halves of the score, or the arrow contradicts the number above it.
  // Reading the ledger alone was wrong by 100 x multiplier per market: tagging
  // pays a 50-point `surface` ledger row AND counts in marketsCreated, and only
  // the first of those is in season_points_log. A week with one tagged market
  // moved the score by 200 at 1x and reported "+100".
  const { multiplier } = await loudStatusFor(deviceId).catch(() => ({ multiplier: 1 }));
  const delta = earned * SCORE_WEIGHTS.contribution
    + Math.round(tagged * SCORE_WEIGHTS.marketCreated * multiplier);
  if (!delta) return null;
  return { delta, direction: delta >= 0 ? "up" : "down" };
}

/** Reverse handle → device lookup, for the public profile page at /@{handle}.
 *  Delegates to deviceForTwitterHandle (declared below — safe: it's a hoisted
 *  function declaration) rather than reimplementing the same two-source
 *  resolution here. It used to only check a device's CHOSEN handle (mem:
 *  memHandle; prod: device_balance.handle), so a user who linked X but never
 *  separately picked that same string as their handle got a working private
 *  profile and a 404 on their own /@handle. deviceForTwitterHandle already
 *  checks the LINKED account first and falls back to the chosen handle — the
 *  exact resolution /@handle needs — so reusing it means the two call sites
 *  (Season Points attribution, public profile lookup) can't drift apart again. */
export async function deviceForHandle(rawHandle: string): Promise<string | null> {
  return deviceForTwitterHandle(rawHandle);
}

export interface ResolvedCall {
  question: string;
  side: "yes" | "no";
  oddsPct: number;        // the price they took on their side
  outcome: "yes" | "no";  // how the market resolved
  correct: boolean;
  closedAt: string;
}

/** A device's recent RESOLVED calls (exit_pct 0/100), newest first — the public
 *  profile's track feed. Sold positions (exit 1–99) are excluded, same rule as
 *  the accuracy record. */
export async function resolvedCallsFor(rawDeviceId: string, limit = 20): Promise<ResolvedCall[]> {
  const deviceId = await resolveDevice(rawDeviceId);
  const n = Math.max(1, Math.min(50, Math.floor(limit)));
  const shape = (side: "yes" | "no", exit: number, pct: number, question: string, closedAt: string): ResolvedCall => {
    const correct = exit === 100;
    return { question, side, oddsPct: Math.max(1, Math.min(99, Math.round(pct))), outcome: correct ? side : side === "yes" ? "no" : "yes", correct, closedAt };
  };
  if (!PERSISTENT) {
    return memCalls
      .filter((c) => c.deviceId === deviceId && c.closedAt && (c.exitPct === 100 || c.exitPct === 0) && c.entryPct != null)
      .sort((a, b) => (a.closedAt! < b.closedAt! ? 1 : a.closedAt! > b.closedAt! ? -1 : b.id - a.id))
      .slice(0, n)
      .map((c) => shape(c.side, c.exitPct as number, c.entryPct, c.question, c.closedAt!));
  }
  await ensureSchema();
  const { rows } = await db().query<{ side: "yes" | "no"; exit_pct: number; pct_at: number; question: string; closed_at: Date }>(
    `SELECT mc.side, mc.exit_pct, mc.pct_at, s.question, mc.closed_at
       FROM market_call mc JOIN market_slug s ON s.slug = mc.slug
      WHERE mc.device_id = $1 AND mc.closed_at IS NOT NULL
        AND mc.exit_pct IN (0, 100) AND mc.pct_at IS NOT NULL
      ORDER BY mc.closed_at DESC, mc.id DESC LIMIT $2`,
    [deviceId, n],
  );
  return rows.map((r) => shape(r.side, r.exit_pct, r.pct_at, r.question, r.closed_at.toISOString()));
}

/* ------------------------------------------------------ resolution celebration --
 * The app's one required emotional beat: a device that opens with resolved
 * positions it hasn't been SHOWN yet gets the full-screen celebration instead
 * of learning the outcome only from the flat notice line. This reads the exact
 * same settle_win/settle_loss notices settleMarket already writes — no second
 * write path — plus the before/after Oddie Score and streak, computed the
 * same way accuracyFor does (computeAccuracy over the chronological record,
 * run twice: once excluding the newly-resolved call, once including it).
 */

export interface Celebration {
  noticeId: number;
  callId: number;
  slug: string;
  question: string;
  side: "yes" | "no";
  outcome: "yes" | "no";
  won: boolean;
  oddsPct: number;              // the price they took on their side
  proceeds: number | null;      // points paid out — null on a loss
  scoreBefore: number;          // 500 (the neutral baseline) if not hasEnough yet
  scoreAfter: number | null;    // null only if still short of the accuracy floor
  streakBefore: number;
  streakAfter: number;
  streakExtended: boolean;      // a genuinely new streak worth naming (>= 2)
  challengeHandle: string | null;
  settledAt: string;
}

type CelebrationRow = {
  callId: number; slug: string; question: string; side: "yes" | "no";
  entryPct: number; exitPct: number; proceeds: number | null; category: string; closedAt: string;
};

export async function celebrationsFor(rawDeviceId: string): Promise<Celebration[]> {
  const deviceId = await resolveDevice(rawDeviceId);
  const prob = (pctAt: number) => clamp(pctAt / 100, 0.01, 0.99);

  let rows: CelebrationRow[];
  let unseenCallIds: Set<number>;
  let noticeIdByCall: Map<number, number>;

  if (!PERSISTENT) {
    const calls = memCalls
      .filter((c) => c.deviceId === deviceId && c.closedAt && (c.exitPct === 100 || c.exitPct === 0) && c.entryPct != null)
      .sort((a, b) => (a.closedAt! < b.closedAt! ? -1 : a.closedAt! > b.closedAt! ? 1 : a.id - b.id));
    rows = calls.map((c) => ({
      callId: c.id, slug: c.slug, question: c.question, side: c.side, entryPct: c.entryPct,
      exitPct: c.exitPct as number, proceeds: c.proceeds,
      category: memCommunity.get(c.slug)?.category ?? categorizeText(c.question),
      closedAt: c.closedAt!,
    }));
    const unseen = memNotices.filter((n) =>
      n.deviceId === deviceId && (n.kind === "settle_win" || n.kind === "settle_loss") && !n.seenAt);
    unseenCallIds = new Set(unseen.map((n) => n.callId).filter((x): x is number => x != null));
    noticeIdByCall = new Map(unseen.map((n) => [n.callId as number, n.id]));
  } else {
    await ensureSchema();
    const { rows: qr } = await db().query<{
      call_id: number; slug: string; question: string; side: "yes" | "no"; pct_at: number;
      exit_pct: number; proceeds: number | null; comm_cat: string | null; closed_at: Date;
    }>(
      `SELECT mc.id AS call_id, mc.slug, s.question, mc.side, mc.pct_at, mc.exit_pct, mc.proceeds,
              cm.category AS comm_cat, mc.closed_at
         FROM market_call mc
         JOIN market_slug s ON s.slug = mc.slug
         LEFT JOIN community_market cm ON cm.slug = mc.slug
        WHERE mc.device_id = $1 AND mc.closed_at IS NOT NULL
          AND mc.exit_pct IN (0, 100) AND mc.pct_at IS NOT NULL
        ORDER BY mc.closed_at ASC, mc.id ASC`,
      [deviceId],
    );
    rows = qr.map((r) => ({
      callId: r.call_id, slug: r.slug, question: r.question, side: r.side, entryPct: r.pct_at,
      exitPct: r.exit_pct, proceeds: r.proceeds, category: r.comm_cat ?? categorizeText(r.question),
      closedAt: r.closed_at.toISOString(),
    }));
    const { rows: nr } = await db().query<{ id: number; call_id: number }>(
      `SELECT id, call_id FROM notice
        WHERE device_id = $1 AND kind IN ('settle_win','settle_loss') AND seen_at IS NULL AND call_id IS NOT NULL`,
      [deviceId],
    );
    unseenCallIds = new Set(nr.map((r) => r.call_id));
    noticeIdByCall = new Map(nr.map((r) => [r.call_id, r.id]));
  }

  if (unseenCallIds.size === 0) return [];

  // Read once, used for every before/after in the loop below — the same numbers
  // the profile scores with, so the movement a celebration claims matches the
  // movement the profile shows. Fetched only after the early return, since a
  // device with nothing to celebrate should not pay for it.
  const activity = await scoreActivityFor(deviceId);
  const accRow = (r: CelebrationRow) => ({ correct: r.exitPct === 100, category: r.category, pct: prob(r.entryPct) });
  const out: Celebration[] = [];
  const slugsNeeded = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!unseenCallIds.has(r.callId)) continue;
    const before = computeAccuracy(rows.slice(0, i).map(accRow), activity);
    const after = computeAccuracy(rows.slice(0, i + 1).map(accRow), activity);
    const won = r.exitPct === 100;
    const outcome = won ? r.side : r.side === "yes" ? "no" : "yes";
    slugsNeeded.add(r.slug);
    out.push({
      noticeId: noticeIdByCall.get(r.callId)!,
      callId: r.callId, slug: r.slug, question: r.question, side: r.side, outcome, won,
      oddsPct: Math.max(1, Math.min(99, Math.round(r.entryPct))),
      proceeds: won ? r.proceeds : null,
      scoreBefore: before.hasEnough ? (before.oddieScore as number)
        : oddieScoreFrom({ ...activity, resolvedCalls: before.resolved, meanEdge: 0 }),
      scoreAfter: after.hasEnough ? after.oddieScore : null,
      streakBefore: before.streak, streakAfter: after.streak,
      streakExtended: after.streak > before.streak && after.streak >= 2,
      challengeHandle: null, // filled in below, once, batched
      settledAt: r.closedAt,
    });
  }

  const surfacers = await surfacersFor([...slugsNeeded]).catch(() => ({} as Record<string, SurfacerInfo>));
  for (const c of out) c.challengeHandle = surfacers[c.slug]?.handle ?? null;

  return out;
}

/**
 * Mark celebrations as shown — the only write in this flow, and the thing that
 * makes each resolution fire exactly once. Call this when, and only when, the
 * client actually FINISHES showing the batch (dismissed, or swiped past the
 * last card) — never at fetch time. A render crash before anything was shown
 * leaves the celebration to try again next load instead of silently vanishing.
 */
/**
 * Ids arrive as STRINGS and stay strings all the way to Postgres.
 *
 * notice.id is a bigserial, and node-postgres returns int8 as a string rather
 * than risk a JS number past 2^53. So the id a client hands back is the string
 * it was given, and any step that insisted on `number` silently dropped it.
 * `$2::bigint[]` binds a string array without complaint, so there is nothing to
 * convert; the in-memory path compares as strings for the same reason.
 */
export async function markCelebrationsSeen(rawDeviceId: string, noticeIds: Array<number | string>): Promise<void> {
  const deviceId = await resolveDevice(rawDeviceId);
  const ids = [...new Set(noticeIds.map(String))].filter((n) => /^\d+$/.test(n));
  if (!ids.length) return;
  if (!PERSISTENT) {
    const now = new Date().toISOString();
    for (const n of memNotices) if (n.deviceId === deviceId && ids.includes(String(n.id))) n.seenAt = now;
    return;
  }
  await ensureSchema();
  // Explicit ::bigint[] — notice.id is bigserial (bigint). Left to inference,
  // a plain JS number array can bind as int4[], and bigint = ANY(int4[])
  // leans on an implicit cross-type promotion instead of a guaranteed match;
  // this is the one write that makes a celebration fire exactly once, so it
  // gets the unambiguous cast rather than trusting the driver to infer right.
  await db().query(
    `UPDATE notice SET seen_at = now() WHERE device_id = $1 AND id = ANY($2::bigint[]) AND seen_at IS NULL`,
    [deviceId, ids],
  );
}

export interface MarketCaller {
  handle: string | null;  // null -> the client shows "anonymous caller"
  side: "yes" | "no";
  pct: number;            // the odds they took, at entry
  at: string;
}
/** Every call on a market, most-recent-first — the permalink page's "who
 *  called what". A LINKED X handle wins over a merely chosen one (same
 *  convention as the leaderboard/profile); a device with neither is exactly
 *  what "anonymous caller" means, not a bug. Capped at `limit`; `total` is the
 *  real count so the client can render "+N more" without a second round trip. */
export async function callersFor(rawSlug: string, limit = 20): Promise<{ callers: MarketCaller[]; total: number }> {
  const slug = rawSlug;
  const n = Math.max(1, Math.min(50, Math.floor(limit)));
  if (!PERSISTENT) {
    const { _memAccounts } = await import("./accounts.js");
    const twByDevice = new Map<string, string>();
    for (const a of _memAccounts) if (a.provider === "twitter" && a.handle) twByDevice.set(a.canonicalDevice, a.handle.replace(/^@+/, ""));
    const rows = memCalls
      .filter((c) => c.slug === slug && c.deviceId)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id));
    const callers = rows.slice(0, n).map((c) => ({
      handle: twByDevice.get(c.deviceId) ?? memHandle.get(c.deviceId) ?? null,
      side: c.side, pct: c.entryPct, at: c.at,
    }));
    return { callers, total: rows.length };
  }
  await ensureSchema();
  const [{ rows }, countRes] = await Promise.all([
    db().query<{ side: "yes" | "no"; pct_at: number; at: Date; handle: string | null }>(
      `SELECT mc.side, mc.pct_at, mc.at, COALESCE(tw.handle, db.handle) AS handle
         FROM market_call mc
         LEFT JOIN device_balance db ON db.device_id = mc.device_id
         LEFT JOIN LATERAL (
           SELECT a.handle FROM account a
            WHERE a.canonical_device = mc.device_id AND a.provider = 'twitter' AND a.handle IS NOT NULL
            ORDER BY a.created_at LIMIT 1
         ) tw ON true
        WHERE mc.slug = $1 AND mc.device_id IS NOT NULL AND mc.pct_at IS NOT NULL
        ORDER BY mc.at DESC, mc.id DESC LIMIT $2`,
      [slug, n],
    ),
    db().query<{ n: string }>(`SELECT count(*)::text n FROM market_call WHERE slug = $1 AND device_id IS NOT NULL`, [slug]),
  ]);
  const callers = rows.map((r) => ({
    handle: r.handle ? r.handle.replace(/^@+/, "") : null,
    side: r.side, pct: r.pct_at, at: r.at.toISOString(),
  }));
  return { callers, total: Number(countRes.rows[0]?.n ?? callers.length) };
}

export interface SettledWinner {
  handle: string | null;  // null -> the client shows "anonymous caller"
  side: "yes" | "no";
  pct: number;            // the odds they took at entry — the lower, the better the call
}
export interface SettledMarket {
  slug: string;
  question: string;
  outcome: "yes" | "no";
  settledAt: string;
  callers: number;             // distinct devices that called it, either side
  winners: SettledWinner[];    // the ones who called it right, best odds first, capped
  winnerTotal: number;
}

/** How many winning callers a settled row names before it says "+N more". Two,
 *  not more: the best-priced call is the interesting one, the rest is a count,
 *  and this keeps the settled block short enough that the leaderboard teaser
 *  below it still lands near the first screen on a desktop viewport. */
const SETTLED_WINNERS_SHOWN = 2;

/**
 * Recently settled markets and who called them right — the home page's proof
 * that "see who was right" actually completes, not a promise.
 *
 * Reads the SAME market_call rows everything else reads, so there is nothing to
 * fabricate: a settled call is one with closed_at set and exit_pct at exactly 0
 * or 100. (A SOLD position exits at a live 1–99 price, so that filter cleanly
 * excludes trading — identical convention to computeAccuracy above.) exit_pct
 * 100 IS the winning side, which is how the outcome is derived for venue
 * markets too, not just community ones; community_market.resolved_outcome is
 * the fallback for the case where every caller took the losing side and no
 * winning row exists to read it off. A market whose outcome cannot be
 * established either way is skipped rather than guessed at.
 *
 * Ordered by when each market actually settled (max closed_at), most recent
 * first. Winners are ordered by the odds they took, ASCENDING: the caller who
 * was right at 20% beat worse odds than the one who was right at 80%, and that
 * is the interesting one to name first.
 */
export async function recentlySettled(limit = 3): Promise<SettledMarket[]> {
  const n = Math.max(1, Math.min(10, Math.floor(limit)));

  if (!PERSISTENT) {
    const { _memAccounts } = await import("./accounts.js");
    const twByDevice = new Map<string, string>();
    for (const a of _memAccounts) if (a.provider === "twitter" && a.handle) twByDevice.set(a.canonicalDevice, a.handle.replace(/^@+/, ""));
    const nameOf = (deviceId: string) => twByDevice.get(deviceId) ?? memHandle.get(deviceId) ?? null;

    const bySlug = new Map<string, MemCall[]>();
    for (const c of memCalls) {
      if (!c.closedAt || (c.exitPct !== 0 && c.exitPct !== 100)) continue;
      bySlug.set(c.slug, [...(bySlug.get(c.slug) ?? []), c]);
    }
    const out: SettledMarket[] = [];
    for (const [slug, calls] of bySlug) {
      const outcome = calls.find((c) => c.exitPct === 100)?.side ?? memCommunity.get(slug)?.resolvedOutcome ?? null;
      if (outcome !== "yes" && outcome !== "no") continue; // outcome unknowable — say nothing
      const settledAt = calls.reduce((a, c) => (c.closedAt! > a ? c.closedAt! : a), calls[0].closedAt!);
      // One row per device: a device with several winning calls on the same
      // market is one person who was right, named once, at their best price.
      const best = new Map<string, MemCall>();
      for (const c of calls) {
        // See EXCLUDED_LEADERBOARD_HANDLE — the brand's own account is never
        // named as a winner here, even a real one.
        if (c.exitPct !== 100 || !c.deviceId || isExcludedHandle(nameOf(c.deviceId))) continue;
        const prev = best.get(c.deviceId);
        if (!prev || c.entryPct < prev.entryPct) best.set(c.deviceId, c);
      }
      const winners = [...best.values()].sort((a, b) => a.entryPct - b.entryPct);
      out.push({
        slug,
        question: calls[0].question ?? slug,
        outcome, settledAt,
        callers: new Set(calls.map((c) => c.deviceId).filter(Boolean)).size,
        winners: winners.slice(0, SETTLED_WINNERS_SHOWN).map((c) => ({ handle: nameOf(c.deviceId), side: c.side, pct: c.entryPct })),
        winnerTotal: winners.length,
      });
    }
    return out.sort((a, b) => (a.settledAt < b.settledAt ? 1 : a.settledAt > b.settledAt ? -1 : 0)).slice(0, n);
  }

  await ensureSchema();
  const { rows: markets } = await db().query<{
    slug: string; question: string; settled_at: Date; callers: string;
    derived_outcome: "yes" | "no" | null; resolved_outcome: "yes" | "no" | null;
  }>(
    `SELECT mc.slug, s.question,
            max(mc.closed_at)                                        AS settled_at,
            count(DISTINCT mc.device_id)::text                       AS callers,
            max(CASE WHEN mc.exit_pct = 100 THEN mc.side END)        AS derived_outcome,
            cm.resolved_outcome
       FROM market_call mc
       JOIN market_slug s ON s.slug = mc.slug
       LEFT JOIN community_market cm ON cm.slug = mc.slug
      WHERE mc.closed_at IS NOT NULL AND mc.exit_pct IN (0, 100)
      GROUP BY mc.slug, s.question, cm.resolved_outcome
      ORDER BY max(mc.closed_at) DESC
      LIMIT $1`,
    [n],
  );
  const usable = markets
    .map((m) => ({ ...m, outcome: m.derived_outcome ?? m.resolved_outcome }))
    .filter((m): m is typeof m & { outcome: "yes" | "no" } => m.outcome === "yes" || m.outcome === "no");
  if (!usable.length) return [];

  // One row per (market, device) at their best price — see the mem note above.
  const { rows: wins } = await db().query<{ slug: string; side: "yes" | "no"; pct: number; handle: string | null }>(
    `SELECT mc.slug, mc.side, min(mc.pct_at) AS pct, COALESCE(tw.handle, db.handle) AS handle
       FROM market_call mc
       LEFT JOIN device_balance db ON db.device_id = mc.device_id
       LEFT JOIN LATERAL (
         SELECT a.handle FROM account a
          WHERE a.canonical_device = mc.device_id AND a.provider = 'twitter' AND a.handle IS NOT NULL
          ORDER BY a.created_at LIMIT 1
       ) tw ON true
      WHERE mc.slug = ANY($1) AND mc.closed_at IS NOT NULL AND mc.exit_pct = 100
        AND mc.device_id IS NOT NULL AND mc.pct_at IS NOT NULL
      GROUP BY mc.slug, mc.device_id, mc.side, tw.handle, db.handle
      ORDER BY min(mc.pct_at) ASC`,
    [usable.map((m) => m.slug)],
  );
  const winnersBySlug = new Map<string, SettledWinner[]>();
  for (const w of wins) {
    // See EXCLUDED_LEADERBOARD_HANDLE — same rule as the mem branch above.
    if (isExcludedHandle(w.handle)) continue;
    const list = winnersBySlug.get(w.slug) ?? [];
    list.push({ handle: w.handle ? w.handle.replace(/^@+/, "") : null, side: w.side, pct: Number(w.pct) });
    winnersBySlug.set(w.slug, list);
  }
  return usable.map((m) => {
    const winners = winnersBySlug.get(m.slug) ?? [];
    return {
      slug: m.slug, question: m.question, outcome: m.outcome,
      settledAt: m.settled_at.toISOString(),
      callers: Number(m.callers),
      winners: winners.slice(0, SETTLED_WINNERS_SHOWN),
      winnerTotal: winners.length,
    };
  });
}

export interface HomeActivity {
  /** OPEN community markets. Deliberately not venue markets: those come from a
   *  live external fetch, so including them would make the home page's counters
   *  depend on venue uptime, and they aren't markets this product created. Home
   *  only ever shows community markets, so this counts exactly what it shows. */
  marketsOpen: number;
  /** Calls placed in the rolling last 24h, by any identified device. */
  callsToday: number;
  /** Predictions paid out to winners in the rolling last 24h — settlement
   *  proceeds only, so it means "earned by being right", not "handed out by
   *  the faucet". */
  predictionsWonToday: number;
}

const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The home page's live-activity counters. Three cheap aggregates over rows we
 * already keep — one round trip on Postgres, no per-row data crossing the wire
 * (deliberately NOT metricsSummary(), which pulls every call, notice and page
 * view into memory to compute an admin dashboard and would grow unbounded on a
 * public page). Zeroes are returned honestly; the client drops any counter that
 * is zero and hides the strip when none survive.
 */
export async function homeActivity(): Promise<HomeActivity> {
  if (!PERSISTENT) {
    const cutoff = Date.now() - ACTIVITY_WINDOW_MS;
    return {
      marketsOpen: [...memCommunity.values()].filter((m) => !m.resolvedOutcome).length,
      callsToday: memCalls.filter((c) => c.deviceId && Date.parse(c.at) >= cutoff).length,
      predictionsWonToday: memCalls.reduce(
        (a, c) => a + (c.closedAt && Date.parse(c.closedAt) >= cutoff && c.proceeds ? c.proceeds : 0), 0),
    };
  }
  await ensureSchema();
  const { rows } = await db().query<{ markets_open: number; calls_today: number; predictions_won_today: number }>(
    `SELECT
       (SELECT count(*)::int FROM community_market WHERE resolved_outcome IS NULL) AS markets_open,
       (SELECT count(*)::int FROM market_call
          WHERE device_id IS NOT NULL AND at >= now() - interval '24 hours')      AS calls_today,
       (SELECT coalesce(sum(proceeds), 0)::int FROM market_call
          WHERE proceeds > 0 AND closed_at >= now() - interval '24 hours')        AS predictions_won_today`,
  );
  const r = rows[0];
  return {
    marketsOpen: Number(r?.markets_open ?? 0),
    callsToday: Number(r?.calls_today ?? 0),
    predictionsWonToday: Number(r?.predictions_won_today ?? 0),
  };
}

/* ------------------------------------------------------------- identity ------
 * Badges and season rank. The product shows the user exactly TWO numbers:
 * their spendable Oddie Points, and their Oddie Score. Contribution/standing is
 * NOT a third number — it is expressed as earned badges (identity markers) and
 * a leaderboard RANK ("top 8%"), never as a raw "season points" figure.
 *
 * Every badge here is derived from data we ALREADY store — no new columns, no
 * new tracking. Founding = order of wallet creation (device_balance.created_at);
 * streak tiers = the accuracy record's bestStreak; category top-% = the season
 * standings, which are just the resolved-pick history re-ranked per category.
 */
export interface Badge {
  id: string;
  kind: "founding" | "streak" | "category" | "rank";
  label: string;      // the screenshot-friendly line, e.g. "Top 3% · Crypto"
  emoji: string;      // UI only; the PNG card renders text (resvg has no emoji font)
  detail?: string;    // small subtitle under the label
  /** Category badges only — the real percentile and its category, kept
   *  structured (not just baked into `label`) so reputationFor can pick the
   *  best one for the flex line without parsing display strings. */
  pctile?: number;
  category?: string;
}
export interface SeasonRank {
  rank: number;
  total: number;
  /** Null when the ranked field is too small for a percentile to mean
   *  anything — see MIN_RANKED_FOR_PERCENTILE. The rank itself is always
   *  real; only the percentile is withheld. */
  topPct: number | null;
}

/**
 * A percentile needs a field. rank/total is a fine formula and a terrible
 * statement about a small one: the very first ranked caller is "#1 of 1",
 * which the formula renders as "top 100%" — an insult to the person in first
 * place — and in a field of four, finishing first would read as "top 25%" and
 * hand out a Sharp Caller tier for beating three people.
 *
 * Both failures matter more now that rank IS the status: a tier that a
 * four-person field can mint is worth nothing, and a status system that
 * congratulates you with "top 100%" is worse than none. Below this many
 * ranked callers the percentile is simply not published, and the tier falls
 * back to the score-based "Proven Caller", which needs no field to be true.
 */
const MIN_RANKED_FOR_PERCENTILE = 20;

// The first N devices to ever hold a wallet wear the Founding Caller badge. A
// rank cutoff (not a date) so it stays correct without knowing the launch day —
// bump this if the founding cohort should be wider/narrower.
const FOUNDING_MAX_RANK = 1000;
const STREAK_TIERS = [25, 10, 5];   // the highest tier a bestStreak reaches wins
const CATEGORY_TOP_PCT = 10;        // "top X% in {category}"
const MIN_CATEGORY_FOR_BADGE = 5;   // resolved picks in a category before it can badge

interface StandingRow { deviceId: string; correct: boolean; category: string; pct: number }
interface Standings {
  overall: { deviceId: string; score: number }[];                 // ranked by calibration, best first
  catRank: Map<string, { deviceId: string; pct: number }[]>;      // per category, best first
}

/** Pure: every device's resolved settled picks → an overall ranking (by the same
 *  calibration the Oddie Score shows) plus a per-category ranking. Only devices
 *  past the accuracy threshold are ranked, so a lucky one-pick run can't chart. */
function computeStandings(rows: StandingRow[]): Standings {
  const byDev = new Map<string, { edges: number[]; cats: Map<string, { r: number; c: number }> }>();
  for (const r of rows) {
    let d = byDev.get(r.deviceId);
    if (!d) { d = { edges: [], cats: new Map() }; byDev.set(r.deviceId, d); }
    d.edges.push((r.correct ? 1 : 0) - r.pct);
    let c = d.cats.get(r.category);
    if (!c) { c = { r: 0, c: 0 }; d.cats.set(r.category, c); }
    c.r++; if (r.correct) c.c++;
  }
  const overall = [...byDev.entries()]
    .filter(([, d]) => d.edges.length >= MIN_RESOLVED_FOR_ACCURACY)
    .map(([deviceId, d]) => ({ deviceId, score: d.edges.reduce((a, b) => a + b, 0) / d.edges.length }))
    .sort((a, b) => b.score - a.score);

  const cats = new Set<string>();
  for (const d of byDev.values()) for (const k of d.cats.keys()) cats.add(k);
  const catRank = new Map<string, { deviceId: string; pct: number }[]>();
  for (const cat of cats) {
    const list = [...byDev.entries()]
      .map(([deviceId, d]) => ({ deviceId, c: d.cats.get(cat) }))
      .filter((x): x is { deviceId: string; c: { r: number; c: number } } => !!x.c && x.c.r >= MIN_CATEGORY_FOR_BADGE)
      .map((x) => ({ deviceId: x.deviceId, pct: x.c.c / x.c.r }))
      .sort((a, b) => b.pct - a.pct);
    if (list.length) catRank.set(cat, list);
  }
  return { overall, catRank };
}

// The standings are the same for everyone and cheap to reuse, so cache them for
// a minute rather than re-scanning the whole history on every profile view.
let standingsCache: { at: number; val: Standings } | null = null;
const STANDINGS_TTL_MS = 60_000;

/** Test-only: a rank-movement test needs the standings to reflect a call it
 *  JUST placed, not whatever was cached up to a minute ago. */
export function _resetStandingsCache(): void { standingsCache = null; }

/**
 * Every device that has earned anything on the loudness ladder, best first.
 *
 * The standings used to be built entirely from resolved play positions, which
 * means that after the pivot NOBODY NEW COULD EVER BE RANKED: the table was
 * frozen at whoever happened to hold positions before the play economy was
 * removed, while the landing page promised "be loud, climb the board". The
 * board was unclimbable.
 *
 * It ranks by the same number the score reports, from the same two sources:
 * markets surfaced, and the growth ledger.
 */
async function loudnessRanking(): Promise<{ deviceId: string; score: number }[]> {
  const devices = new Set<string>();
  const handles = new Set<string>();
  const note = (d: string | null, h: string | null): void => {
    if (d) devices.add(d);
    else if (h) handles.add(h.replace(/^@+/, "").toLowerCase());
  };

  // Both halves of the ladder, not just the ledger. Tagging a market is the act
  // the whole product asks for and it is the score's biggest rung, so a device
  // that has only ever done that has to be a candidate.
  //
  // Handle-only rows count too. Points and surfaced markets are credited by
  // handle when the tagger has no device yet, and are resolved to a device the
  // moment one claims that handle. scoreActivityFor already reads them that way,
  // so a candidate list built from device_id alone would show somebody a score
  // on their profile and no row at all on the board.
  if (!PERSISTENT) {
    for (const r of memSeasonLog) note(r.deviceId, r.handle);
    for (const [, sf] of memSurfacer) note(sf.deviceId, sf.handle);
  } else {
    await ensureSchema();
    const [pts, made] = await Promise.all([
      db().query<{ device_id: string | null; handle: string | null }>(
        `SELECT DISTINCT device_id, handle FROM season_points_log`),
      db().query<{ device_id: string | null; handle: string | null }>(
        `SELECT DISTINCT device_id, handle FROM market_surfacer`),
    ]);
    for (const r of [...pts.rows, ...made.rows]) note(r.device_id, r.handle);
  }
  for (const h of handles) {
    const d = await deviceForTwitterHandle(h).catch(() => null);
    if (d) devices.add(d);
  }

  const out: { deviceId: string; score: number }[] = [];
  for (const deviceId of devices) {
    // scoreActivityFor, not a private sum: it is the exact read the profile
    // uses, so the board and the profile cannot quote two different numbers for
    // one person.
    const a = await scoreActivityFor(deviceId).catch(() => null);
    if (!a) continue;
    const score = oddieScoreFrom({
      marketsCreated: a.marketsCreated,
      contributionPoints: a.contributionPoints,
      resolvedCalls: 0,
      meanEdge: null,
      loudMultiplier: a.loudMultiplier,
    });
    if (score > 0) out.push({ deviceId, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

async function seasonStandings(): Promise<Standings> {
  const now = Date.now();
  if (standingsCache && now - standingsCache.at < STANDINGS_TTL_MS) return standingsCache.val;
  const prob = (pctAt: number) => clamp(pctAt / 100, 0.01, 0.99);
  let rows: StandingRow[];
  if (!PERSISTENT) {
    rows = memCalls
      .filter((c) => c.closedAt && (c.exitPct === 100 || c.exitPct === 0) && c.entryPct != null)
      .map((c) => ({ deviceId: c.deviceId, correct: c.exitPct === 100, category: memCommunity.get(c.slug)?.category ?? categorizeText(c.question), pct: prob(c.entryPct) }));
  } else {
    await ensureSchema();
    const { rows: qr } = await db().query<{ device_id: string; exit_pct: number; pct_at: number; question: string; comm_cat: string | null }>(
      `SELECT mc.device_id, mc.exit_pct, mc.pct_at, s.question, cm.category AS comm_cat
         FROM market_call mc
         JOIN market_slug s ON s.slug = mc.slug
         LEFT JOIN community_market cm ON cm.slug = mc.slug
        WHERE mc.device_id IS NOT NULL AND mc.closed_at IS NOT NULL
          AND mc.exit_pct IN (0, 100) AND mc.pct_at IS NOT NULL`,
    );
    rows = qr.map((r) => ({ deviceId: r.device_id, correct: r.exit_pct === 100, category: r.comm_cat ?? categorizeText(r.question), pct: prob(r.pct_at) }));
  }
  // catRank stays on resolved picks: it is a per-category ACCURACY ranking and
  // it is honest about what it measures. `overall` is the one that decides a
  // rank number, so it moves to the ladder the score is actually made of.
  const val = computeStandings(rows);
  val.overall = await loudnessRanking();
  standingsCache = { at: now, val };
  return val;
}

/** This device's season standing as a percentile ("top 8%"), or null while it is
 *  still provisional (under the resolved-pick threshold). Ranks by the very same
 *  calibration the Oddie Score reports, so the rank and the score never disagree. */
export async function seasonRankFor(rawDeviceId: string): Promise<SeasonRank | null> {
  const deviceId = await resolveDevice(rawDeviceId);
  const { overall } = await seasonStandings();
  const total = overall.length;
  const i = overall.findIndex((r) => r.deviceId === deviceId);
  if (i < 0 || total === 0) return null;
  const rank = i + 1;
  const topPct = total >= MIN_RANKED_FOR_PERCENTILE
    ? Math.max(1, Math.ceil((rank / total) * 100))
    : null;
  return { rank, total, topPct };
}

const memLastSeenRank = new Map<string, number>();

export interface RankMovement { direction: "up" | "down"; spots: number; rank: number }

/**
 * "You moved up 2 spots -> #14" — fired ONCE per actual rank change, the
 * moment it's next observed on a Profile or Leaderboard view (the only two
 * call sites; deliberately NOT wired into /api/me's background balance-pill
 * refresh, or every poll would consume it before the user ever saw a
 * leaderboard or profile screen). Reads the device's last-seen rank, compares
 * it to the current one, and overwrites the stored value in the same call —
 * so calling this IS "marking it seen", the same one-shot contract
 * markCelebrationsSeen uses for the celebration queue, just consumed by the
 * read itself instead of a separate endpoint.
 *
 * Unranked/provisional devices (seasonRankFor -> null) return null and leave
 * the stored value untouched: there is nothing to compare, and touching it
 * would make the FIRST time they become ranked look like "moved up from
 * nowhere" instead of correctly showing nothing until the rank AFTER that
 * one moves again.
 */
export async function rankMovementFor(rawDeviceId: string): Promise<RankMovement | null> {
  const deviceId = await resolveDevice(rawDeviceId);
  const current = await seasonRankFor(deviceId);
  if (!current) return null;

  let previous: number | null;
  if (!PERSISTENT) {
    previous = memLastSeenRank.get(deviceId) ?? null;
    memLastSeenRank.set(deviceId, current.rank);
  } else {
    await ensureSchema();
    await db().query(`INSERT INTO device_balance (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [deviceId]);
    const { rows } = await db().query<{ last_seen_rank: number | null }>(
      `SELECT last_seen_rank FROM device_balance WHERE device_id = $1`, [deviceId]);
    previous = rows[0]?.last_seen_rank ?? null;
    await db().query(`UPDATE device_balance SET last_seen_rank = $1 WHERE device_id = $2`, [current.rank, deviceId]);
  }

  if (previous == null || previous === current.rank) return null;
  return previous > current.rank
    ? { direction: "up", spots: previous - current.rank, rank: current.rank }     // lower rank number = better
    : { direction: "down", spots: current.rank - previous, rank: current.rank };
}

const memTagTeachingSeen = new Set<string>();

/**
 * The shared "show this exactly once, ever, per device" primitive behind every
 * one-shot onboarding beat. The read IS the mark-seen — same contract as
 * rankMovementFor above — so a client only ever needs to call once and trust
 * the boolean it gets back, with no separate "mark seen" round trip and no way
 * to show it twice from a retry, a double-render, or two racing tabs.
 *
 * `column` is a caller-supplied literal, never user input — it is interpolated
 * into the SQL because Postgres cannot parameterise an identifier. Every call
 * site below passes a hardcoded column name.
 */
async function claimOnceFlag(rawDeviceId: string, column: string, memSeen: Set<string>): Promise<boolean> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) {
    if (memSeen.has(deviceId)) return false;
    memSeen.add(deviceId);
    return true;
  }
  await ensureSchema();
  await db().query(`INSERT INTO device_balance (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [deviceId]);
  // Only the request that actually flips it NULL -> now() gets a row back —
  // that's what makes this atomic under a real race, not just single-threaded
  // mem-mode: two concurrent requests can't both win.
  const { rows } = await db().query(
    `UPDATE device_balance SET ${column} = now()
       WHERE device_id = $1 AND ${column} IS NULL
       RETURNING 1`,
    [deviceId],
  );
  return rows.length > 0;
}

/**
 * Stage 2 of new-user onboarding: "now the real move — tag @oddiefun on X."
 * Shown once, ever, right after a device's first-ever call locks.
 */
export async function claimTagTeachingMoment(rawDeviceId: string): Promise<boolean> {
  return claimOnceFlag(rawDeviceId, "tag_teaching_seen_at", memTagTeachingSeen);
}

/**
 * The first-visit guided tour (3-step in-page spotlight). Claimed by the
 * client on a cold Home render when the device is ALSO newUser — this flag
 * alone decides "already toured", the newUser check decides "worth touring
 * at all", and both must pass. Once claimed the tour never fires again, even
 * if the device somehow reads as new later.
 */
// claimGuidedTour lived here (one-shot over tour_seen_at). Removed with the
// guided tour; the tour_seen_at column stays — dropping columns over a
// removed feature is churn, and existing rows are harmless history.

/** Is this device inside the founding cohort (one of the first wallets)? */
async function isFounding(deviceId: string): Promise<boolean> {
  if (!PERSISTENT) return false; // no creation order in mem; founding is a prod concept
  await ensureSchema();
  const { rows } = await db().query<{ rnk: string }>(
    `SELECT (SELECT count(*) FROM device_balance b2 WHERE b2.created_at <= b.created_at) AS rnk
       FROM device_balance b WHERE b.device_id = $1`, [deviceId]);
  return rows[0] ? Number(rows[0].rnk) <= FOUNDING_MAX_RANK : false;
}

/** The badges a device has earned, most identity-defining first. `acc` is passed
 *  in (the caller already has it) so this adds at most two cheap lookups. */
/**
 * THE SHELF. Fourteen stamps, and every one of them awardable today.
 *
 * badgesFor could award three kinds and TWO WERE UNEARNABLE: `streak` reads
 * acc.bestStreak and `category` reads catRank, both computed from resolved rows
 * in market_call, which nothing writes any more. The client drew a fourth slot
 * ("rank") that badgesFor never produced at all. So the shelf read "1 of 4"
 * forever, and the only thing anybody could earn was being early.
 *
 * The rule for this table is one sentence: a stamp exists only if a live query
 * returns it. Each entry names the field it reads, and none of them touch
 * market_call. `tradersReached` is deliberately absent for exactly that reason.
 *
 * FOIL marks the four where real SOL moved. It is the only visual tier, and it
 * is auditable rather than decorative.
 */
export interface Achievement {
  id: string;
  name: string;
  /** How you get it, one short line, shown under the shelf on tap. */
  how: string;
  earned: boolean;
  /** Real SOL moved. Renders lime instead of quiet. */
  foil: boolean;
}

/** What the chain knows about the markets a device tagged. Null when it could
 *  not be read, which reads as "not yet" rather than throwing a shelf away. */
export interface ChainFacts { pooledLamports: number; earnedLamports: number; claimed: boolean; resolved: number }

const ONE_SOL = 1_000_000_000;

/**
 * Every market that was ever minted on chain, with the id its PDA is derived
 * from. The input to scripts/mainnet-backfill.ts.
 *
 * market_id is a bigint, so pg hands it back as a STRING and it stays one all
 * the way to the mint call. Reading it as a number here would be the same
 * unchecked lie that has bitten this file before.
 */
export async function mintedMarketsForBackfill(): Promise<{
  rows: { slug: string; marketId: string; question: string; onchainPubkey: string; resolvedOutcome: string | null }[];
  /** Community markets that were never minted. Not this script's problem, but a
   *  denominator the operator needs: they answer not-minted before the move and
   *  they answer not-minted after it, and that is not a regression. */
  neverMinted: number;
}> {
  if (!PERSISTENT) return { rows: [], neverMinted: 0 };
  await ensureSchema();
  const { rows } = await db().query<{
    slug: string; market_id: string; question: string; onchain_pubkey: string; resolved_outcome: string | null;
  }>(
    `SELECT cm.slug, cm.market_id::text AS market_id, s.question, cm.onchain_pubkey, cm.resolved_outcome
       FROM community_market cm
       JOIN market_slug s ON s.slug = cm.slug
      WHERE cm.onchain_pubkey IS NOT NULL
      ORDER BY cm.market_id`,
  );
  const { rows: n } = await db().query<{ n: string }>(
    `SELECT COUNT(*)::bigint AS n FROM community_market WHERE onchain_pubkey IS NULL`,
  );
  return {
    rows: rows.map((r) => ({
      slug: r.slug, marketId: r.market_id, question: r.question,
      onchainPubkey: r.onchain_pubkey, resolvedOutcome: r.resolved_outcome,
    })),
    neverMinted: Number(n[0]?.n ?? 0),
  };
}

export async function achievementsFor(
  rawDeviceId: string,
  acc: AccuracyRecord,
  rank: SeasonRank | null,
  chain: ChainFacts | null,
): Promise<Achievement[]> {
  const deviceId = await resolveDevice(rawDeviceId);
  const [founding, loud, cats, weeklyWins] = await Promise.all([
    isFounding(deviceId).catch(() => false),
    loudStatusFor(deviceId).catch(() => ({ clearedIn30d: 0, weeklyWinIn30d: false, multiplier: 1 })),
    categoriesTaggedBy(deviceId).catch(() => 0),
    loudWinsFor(deviceId).catch(() => 0),
  ]);
  const made = acc.marketsCreated;
  const pooled = chain?.pooledLamports ?? 0;
  const earned = chain?.earnedLamports ?? 0;

  const S = (id: string, name: string, how: string, earnedFlag: boolean, foil = false): Achievement =>
    ({ id, name, how, earned: earnedFlag, foil });

  // Ordered the way they are realistically earned, so the sheet fills roughly
  // left to right and the first gap is always the nearest thing to go and get.
  return [
    S("first_tag",  "First Tag",    "Tag @oddiefun on X and a market opens.",              made >= 1),
    S("ranked",     "On the Board", "Earn any oddies and you hold a place in the season.",  rank != null),
    S("first_pool", "First Pool",   "Somebody stakes real SOL in a market you started.",    pooled > 0, true),
    S("cleared",    "Cleared",      "Get one post about oddie approved.",                   loud.clearedIn30d >= 1),
    S("resolved",   "Verdict In",   "A market you tagged reaches its outcome.",             (chain?.resolved ?? 0) >= 1),
    S("first_fee",  "First Fee",    "Your 2% becomes real SOL at a resolve.",               earned > 0, true),
    S("range",      "Three Ways",   "Tag markets across three different topics.",           cats >= 3),
    S("collected",  "Collected",    "Claim a creator fee into your own wallet.",            !!chain?.claimed, true),
    S("ten_tags",   "Ten Up",       "Put ten markets on the board.",                        made >= 10),
    S("triple",     "Triple Clear", "Three approved posts inside thirty days.",             loud.clearedIn30d >= 3),
    S("big_pool",   "Full Sol",     "A whole SOL riding on markets you started.",           pooled >= ONE_SOL, true),
    S("top_ten",    "Top Ten",      "Reach the top 10% of the season.",                     rank?.topPct != null && rank.topPct <= 10),
    // NOT "Loudest": that is the name of the TIER for the top 5% of the board
    // (callerTier in economy.ts), and both are worn on the same screen. One
    // word cannot mean two different achievements in one product, so the stamp
    // is named after what you actually did.
    S("loudest",    "Week Won",     "Win a week's Loudest.",                                weeklyWins >= 1 || loud.weeklyWinIn30d),
    S("founding",   "Day One",      "Be one of the first thousand here.",                   founding),
  ];
}

/** Distinct topics across the markets a device tagged. Reads market_surfacer
 *  joined to the market rows, never market_call. */
async function categoriesTaggedBy(deviceId: string): Promise<number> {
  if (!PERSISTENT) {
    const cats = new Set<string>();
    for (const [slug, sf] of memSurfacer) {
      if (sf.deviceId !== deviceId) continue;
      const c = memCommunity.get(slug)?.category;
      if (c) cats.add(c);
    }
    return cats.size;
  }
  await ensureSchema();
  const { rows } = await db().query<{ n: string }>(
    `SELECT COUNT(DISTINCT cm.category)::bigint AS n
       FROM market_surfacer ms JOIN community_market cm ON cm.slug = ms.slug
      WHERE ms.device_id = $1 AND cm.category IS NOT NULL`, [deviceId]);
  return Number(rows[0]?.n ?? 0);
}

/** Weekly Loudest wins, ever. The ledger keeps them, so the badge outlives the
 *  30-day window the multiplier uses. */
async function loudWinsFor(deviceId: string): Promise<number> {
  if (!PERSISTENT) return memSeasonLog.filter((r) => r.deviceId === deviceId && r.event === "loud").length;
  await ensureSchema();
  const { rows } = await db().query<{ n: string }>(
    `SELECT COUNT(*)::bigint AS n FROM season_points_log WHERE device_id = $1 AND event = 'loud'`, [deviceId]);
  return Number(rows[0]?.n ?? 0);
}

export async function badgesFor(rawDeviceId: string, acc: AccuracyRecord): Promise<Badge[]> {
  const deviceId = await resolveDevice(rawDeviceId);
  const badges: Badge[] = [];

  if (await isFounding(deviceId).catch(() => false)) {
    badges.push({ id: "founding", kind: "founding", label: "Founding Caller", emoji: "🏛️", detail: "one of the first on oddie" });
  }

  const tier = STREAK_TIERS.find((t) => acc.bestStreak >= t);
  if (tier) badges.push({ id: `streak-${tier}`, kind: "streak", label: `${tier}-Call Streak`, emoji: "🔥", detail: `${tier} correct in a row` });

  // Category top-% — for every category this device is deep enough in, its rank
  // among everyone deep enough in that category. Best category first, capped.
  const { catRank } = await seasonStandings();
  const cat: Badge[] = [];
  for (const [category, list] of catRank) {
    const i = list.findIndex((r) => r.deviceId === deviceId);
    if (i < 0) continue;
    const pctile = Math.ceil(((i + 1) / list.length) * 100);
    // The REAL percentile, not the CATEGORY_TOP_PCT cutoff. This used to read
    // "Top 10% · Crypto" for everyone who qualified, including someone
    // actually sitting in the top 2% — understating the best records, which
    // is the exact opposite of what a status badge is for. The cutoff still
    // decides WHETHER you badge; it no longer decides what the badge claims.
    if (pctile <= CATEGORY_TOP_PCT) cat.push({ id: `cat-${category}`, kind: "category", label: `Top ${pctile}% · ${category}`, emoji: "🎯", detail: `${Math.round(list[i].pct * 100)}% accuracy`, pctile, category });
  }
  cat.sort((a, b) => (a.pctile ?? 100) - (b.pctile ?? 100)); // best standing first
  badges.push(...cat.slice(0, 3));

  return badges;
}

/**
 * Everything that makes a record STATUS rather than a statistic, in one read:
 * the numbers, the season standing, the earned tier, and the one-line brag.
 *
 * Exists so the profile page, the public profile API, the share PNG and the
 * leaderboard all describe a person identically — before this, each assembled
 * its own subset and they could disagree about what someone was.
 */
export interface CallerReputation {
  handle: string;
  accuracy: AccuracyRecord;
  rank: SeasonRank | null;
  tier: CallerTier | null;
  badges: Badge[];
  /** Best category standing, for "top 3% in Crypto". Null if none qualifies. */
  topCategory: { category: string; pctile: number; accuracyPct: number } | null;
  /** The screenshot line, pre-assembled so every surface shows the same brag. */
  flexLine: string;
}

/**
 * The one-line public brag: "78% accuracy across 40 calls · top 3% in Crypto".
 * Built from whatever is actually true — the category clause is dropped when
 * no category qualifies, and a provisional record says so plainly instead of
 * quoting a percentage that isn't yet meaningful. Never renders a claim the
 * data doesn't support; an unimpressive record gets an honest short line.
 */
/**
 * The one line this product asks people to screenshot.
 *
 * It used to read "64% accuracy across 20 calls". Nothing resolves calls any
 * more, so for everyone who arrived after the pivot it read "building a track
 * record" no matter how many markets they had put up, and once hasEnough moved
 * to the ladder it read "NaN% accuracy across 0 calls" and offered that to X.
 *
 * It says what the ladder measures: what you brought, and who turned up for it.
 * topCategory is still accepted so call sites keep compiling, and ignored,
 * because per-category standing is accuracy over the same dead rows.
 */
export function flexLine(acc: AccuracyRecord, _topCategory: { category: string; pctile: number } | null): string {
  const made = acc.marketsCreated;
  if (made > 0) {
    const parts = [`${made} market${made === 1 ? "" : "s"} tagged`];
    // NOT tradersReached: see the field's own comment. It is permanently 0, so
    // the clause could never appear and the brag would have been silently
    // shorter than intended forever.
    if (acc.loudMultiplier > 1) parts.push(`${acc.loudMultiplier}x loud`);
    return parts.join(" · ");
  }
  if ((acc.oddieScore ?? 0) > 0) return `${acc.oddieScore} oddies earned`;
  return "not on the board yet";
}

/** One read that every reputation surface shares. */
export async function reputationFor(rawDeviceId: string): Promise<CallerReputation> {
  const deviceId = await resolveDevice(rawDeviceId);
  // displayHandleFor, not ensureHandle: this is a READ path (a profile view, a
  // share card render), and ensureHandle would mint a handle as a side effect
  // of merely looking at someone.
  const [accuracy, hd, rank] = await Promise.all([
    accuracyFor(deviceId), displayHandleFor(deviceId), seasonRankFor(deviceId),
  ]);
  const badges = await badgesFor(deviceId, accuracy);
  const best = badges
    .filter((b) => b.kind === "category" && b.pctile != null && b.category)
    .sort((a, b) => (a.pctile ?? 100) - (b.pctile ?? 100))[0];
  const topCategory = best
    ? { category: best.category!, pctile: best.pctile!, accuracyPct: parseInt(best.detail ?? "0", 10) || 0 }
    : null;
  const tier = callerTier({
    // marketsCreated is load-bearing: the entry badge is judged on it, so
    // omitting it here would silently retire that tier and nobody below the
    // ranked cutoff would ever earn anything.
    hasEnough: accuracy.hasEnough, oddieScore: accuracy.oddieScore,
    marketsCreated: accuracy.marketsCreated, topPct: rank ? rank.topPct : null,
  });
  return { handle: hd ?? "caller", accuracy, rank, tier, badges, topCategory, flexLine: flexLine(accuracy, topCategory) };
}

/**
 * A device's category engagement — every position it has ever taken (open OR
 * resolved), counted by category. The signal for personalizing "For you": a
 * player with a Sports-heavy history should see Sports lead. Counts ALL picks
 * (not just resolved) so a new signed-in user's open positions shape the feed
 * immediately. Empty for a device that has never played (a cold visitor).
 */
export async function categoryHistoryFor(rawDeviceId: string): Promise<{ category: string; count: number }[]> {
  const deviceId = await resolveDevice(rawDeviceId);
  const counts = new Map<string, number>();
  const bump = (cat: string) => counts.set(cat, (counts.get(cat) ?? 0) + 1);
  if (!PERSISTENT) {
    for (const c of memCalls) {
      if (c.deviceId !== deviceId) continue;
      bump(memCommunity.get(c.slug)?.category ?? categorizeText(c.question));
    }
  } else {
    await ensureSchema();
    const { rows } = await db().query<{ question: string; comm_cat: string | null }>(
      `SELECT s.question, cm.category AS comm_cat
         FROM market_call mc
         JOIN market_slug s ON s.slug = mc.slug
         LEFT JOIN community_market cm ON cm.slug = mc.slug
        WHERE mc.device_id = $1`,
      [deviceId],
    );
    for (const r of rows) bump(r.comm_cat ?? categorizeText(r.question));
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

/* --------------------------------------------------------------- settlement --
 * The venue resolved; pay everyone holding the market, exactly once.
 *
 * Selling and settling are the same act at different prices (the comment on
 * sellPosition promised this day would come): settlement writes the same three
 * columns with the side's terminal price — 100 if the side won, 0 if it lost —
 * so holders and scalpers land on the same reputation metric by construction.
 *
 * THE GUARD IS ROW STATE, NEVER A TIMESTAMP VALUE. `WHERE closed_at IS NULL` is
 * a fact about the row; a timestamp equality is a fact about microseconds, and
 * NOTES/lessons.md #1 is the scar from learning the difference. A second sweep,
 * a concurrent sweep, a sweep after a crash — all find zero open rows and
 * credit nothing, which is the whole idempotency story in one predicate.
 */

export interface Settled {
  callId: number;
  deviceId: string | null;
  side: "yes" | "no";
  stake: number;
  entryPct: number;
  exitPct: number;
  proceeds: number;
  edge: number;
}

export async function settleMarket(slug: string, outcome: "yes" | "no"): Promise<Settled[]> {
  if (!PERSISTENT) {
    const rec = mem.get(slug);
    const crowd = (await crowdSplits([slug]))[slug];
    const out: Settled[] = [];
    for (const c of memCalls) {
      if (c.slug !== slug || c.closedAt) continue; // closedAt set = state guard, mem edition
      const exitPct = c.side === outcome ? 100 : 0;
      // The bonus IS the entire return (see economy.winBonus) — the 1 prediction
      // spent to make the call was already deducted at call time and is not
      // separately refunded here.
      const proceeds = c.side === outcome ? winBonus(c.entryPct) : 0;
      c.closedAt = new Date().toISOString();
      c.exitPct = exitPct;
      c.proceeds = proceeds;
      const w = memBalance.get(c.deviceId) ?? { tokens: STARTING_PREDICTIONS, toppedUpAt: Date.now() };
      memBalance.set(c.deviceId, { ...w, tokens: w.tokens + proceeds });
      pushNoticeMem(c.deviceId, slug, rec?.market.question ?? slug, outcome, c.side, c.entryPct, proceeds, c.id, crowd);
      out.push({ callId: c.id, deviceId: c.deviceId, side: c.side, stake: c.tokens, entryPct: c.entryPct, exitPct, proceeds, edge: edgePts(c.entryPct, exitPct) });
    }
    void awardCleanResolve(slug); // +50 to the surfacer: clean resolution
    // AWAITED, matching the pg branch where this is part of the settlement
    // transaction. It used to be fire-and-forget, which happened to work only
    // because the old code path reached memBalance within a microtask of
    // settleMarket returning. Re-resolving the surfacer's handle adds a real
    // async boundary (a dynamic import), so the credit started landing AFTER
    // callers had already read the balance — a race that made a correct fee
    // look like an unpaid one. Determinism here is worth more than the tick.
    await creditCreatorFeePlayMem(slug, rec?.market.question ?? slug, out.reduce((a, r) => a + r.stake, 0));
    return out;
  }

  await ensureSchema();
  const q = await db().query<{ question: string }>(`SELECT question FROM market_slug WHERE slug = $1`, [slug]);
  const question = q.rows[0]?.question ?? slug;
  const crowd = (await crowdSplits([slug]))[slug];

  const client = await db().connect();
  try {
    await client.query("BEGIN");
    // One statement closes every open position on the market. The proceeds
    // arithmetic mirrors economy.winBonus exactly — GREATEST/LEAST against the
    // same 1/10 literals as BONUS_FLOOR/BONUS_CAP there — because Postgres can't
    // call the JS function directly. Change the two together.
    const closed = await client.query<{
      id: number; device_id: string | null; side: "yes" | "no"; tokens: number; pct_at: number; exit_pct: number; proceeds: number;
    }>(
      `UPDATE market_call SET
         closed_at = now(),
         exit_pct  = CASE WHEN side = $2 THEN 100 ELSE 0 END,
         proceeds  = CASE WHEN side = $2 THEN GREATEST(1, LEAST(10, ROUND(100.0 / pct_at)))::integer ELSE 0 END
       WHERE slug = $1 AND closed_at IS NULL AND pct_at IS NOT NULL
       RETURNING id, device_id, side, tokens, pct_at, exit_pct, proceeds`,
      [slug, outcome],
    );

    for (const r of closed.rows) {
      if (!r.device_id) continue; // a pre-device-id row: stamped closed, nobody to pay
      if (r.proceeds > 0) {
        await client.query(`UPDATE device_balance SET tokens = tokens + $1 WHERE device_id = $2`, [r.proceeds, r.device_id]);
      }
      const won = r.side === outcome;
      await client.query(
        `INSERT INTO notice (device_id, kind, body, delta, slug, call_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [r.device_id, won ? "settle_win" : "settle_loss", noticeBody(question, outcome, r.side, r.pct_at, r.proceeds, crowd), won ? r.proceeds : null, slug, r.id],
      );
    }

    // Creator fee: additive bonus off the total pool (both sides), credited
    // atomically in this same transaction — see economy.ts for why this is a
    // grant rather than a deduction. A market with no identifiable creator
    // (surfacerFor is per-slug, populated at ingest — see recordSurfacer)
    // simply pays no fee; there's no one to credit it to.
    const totalPoolPlay = closed.rows.reduce((a, r) => a + r.tokens, 0);
    const creatorFeePlayAmount = creatorFeePlay(totalPoolPlay);
    let creatorFeeCredited: { deviceId: string; handle: string | null } | null = null;
    if (creatorFeePlayAmount > 0) {
      const surfacer = await surfacerFor(slug);
      // Re-resolve the handle when no device was known at record time.
      //
      // This is the normal case, not the edge case. A market is tagged into
      // existence by someone on X who has no Oddie account yet — that is the
      // entire funnel — so recordSurfacer writes the handle and a null device,
      // and the device only comes into being when they sign in later.
      // awardSeasonPoints has always re-resolved here; the fee did not, so the
      // the creator fee went silently unpaid for precisely the people it exists to recruit,
      // on the markets they brought in themselves.
      const payee = surfacer?.deviceId
        ?? (surfacer?.handle ? await deviceForTwitterHandle(surfacer.handle).catch(() => null) : null);
      if (payee) {
        await client.query(`INSERT INTO device_balance (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [payee]);
        await client.query(`UPDATE device_balance SET tokens = tokens + $1 WHERE device_id = $2`, [creatorFeePlayAmount, payee]);
        await client.query(
          `INSERT INTO notice (device_id, kind, body, delta, slug, call_id) VALUES ($1,$2,$3,$4,$5,$6)`,
          [payee, "creator_fee", `You earned ${creatorFeePlayAmount} prediction${creatorFeePlayAmount === 1 ? "" : "s"} — creator fee for "${question}" resolving.`, creatorFeePlayAmount, slug, null],
        );
        creatorFeeCredited = { deviceId: payee, handle: surfacer?.handle ?? null };
      }
    }

    await client.query("COMMIT");

    void awardCleanResolve(slug); // +50 to the surfacer: clean resolution (post-commit, best-effort)
    if (creatorFeeCredited) {
      void logFee({
        slug, marketKind: "play", feeKind: "creator",
        recipientDeviceId: creatorFeeCredited.deviceId, recipientHandle: creatorFeeCredited.handle,
        rateBps: CREATOR_FEE_BPS_PLAY, basisAmount: totalPoolPlay, feeAmount: creatorFeePlayAmount, enforced: true,
      }); // audit log write, post-commit best-effort — same pattern as awardCleanResolve above
    }
    return closed.rows.map((r) => ({
      callId: r.id, deviceId: r.device_id, side: r.side, stake: r.tokens,
      entryPct: r.pct_at, exitPct: r.exit_pct, proceeds: r.proceeds, edge: edgePts(r.pct_at, r.exit_pct),
    }));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// --- Community markets (Layer 1 store) --------------------------------------
// The admin-created markets. Base row lives in market_slug; the extra state
// (forced category, manual resolution, on-chain proof) lives in community_market
// (persistent) or memCommunity (in-memory dev/test).

export type CommunityMarket = Market & {
  marketId: number;
  category: string;
  onchainPubkey: string | null;
  onchainSig: string | null;
  resolutionCriteria: string | null;
  resolvability: string | null;
  /** The rate this market is (or will be) minted with. Carried on the list
   *  so the feed shows the fee actually charged, without a second lookup
   *  that can be empty or fail. */
  creatorFeeBps: number;
};

interface CommunityMeta {
  slug: string;
  marketId: number;
  category: string;
  resolvedOutcome: "yes" | "no" | null;
  onchainPubkey: string | null;
  onchainSig: string | null;
  resolutionCriteria: string | null;
  resolvability: string | null;
  /** Set when the market was taken off the board. See the DDL note. */
  retiredAt?: string | null;
  /** The rate this market will be minted at. See the DDL note on the column. */
  creatorFeeBps?: number;
}
const memCommunity = new Map<string, CommunityMeta>();

// In-memory mirrors of market_surfacer and season_points_log (the mem backend
// tests run against). Same shape as the tables above.
interface MemSurfacer { handle: string | null; deviceId: string | null; sourceUrl: string | null; sourceKey?: string | null; createdAt: string; sourceText?: string | null; sourceAuthor?: string | null }
const memSurfacer = new Map<string, MemSurfacer>();
interface MemSeasonRow { deviceId: string | null; handle: string | null; event: string; amount: number; slug: string | null; dedupKey: string; createdAt: string }
const memSeasonLog: MemSeasonRow[] = [];

// In-memory mirror of loud_post. Same shape as the table.
interface MemLoudPost {
  id: number; deviceId: string; tweetId: string; url: string;
  status: "pending" | "approved" | "rejected"; week: string;
  note: string | null; createdAt: string; decidedAt: string | null;
}
const memLoudPosts: MemLoudPost[] = [];
let memLoudPostId = 0;

// In-memory mirror of market_fee_log — same shape as the table, same
// "creator + protocol fee ledger" role, for the mem backend tests run against.
interface MemFeeRow {
  slug: string; marketKind: "play" | "real"; feeKind: "creator" | "protocol";
  recipientDeviceId: string | null; recipientHandle: string | null;
  rateBps: number; basisAmount: number; feeAmount: number; enforced: boolean; createdAt: string;
}
const memFeeLog: MemFeeRow[] = [];

export interface FeeLogRow {
  slug: string; marketKind: "play" | "real"; feeKind: "creator" | "protocol";
  recipientDeviceId: string | null; recipientHandle: string | null;
  rateBps: number; basisAmount: number; feeAmount: number; enforced: boolean; createdAt: string;
}
interface FeeLogInput {
  slug: string; marketKind: "play" | "real"; feeKind: "creator" | "protocol";
  recipientDeviceId?: string | null; recipientHandle?: string | null;
  rateBps: number; basisAmount: number; feeAmount: number; enforced: boolean;
}
/** The one write path for every fee event, real or merely proposed — settleMarket
 *  (play, enforced) and the real-money resolve route (real, NOT enforced — see
 *  economy.ts) both funnel through this so market_fee_log is a complete ledger. */
async function logFee(input: FeeLogInput): Promise<void> {
  const recipientDeviceId = input.recipientDeviceId ?? null;
  const recipientHandle = input.recipientHandle ?? null;
  if (!PERSISTENT) {
    memFeeLog.push({ ...input, recipientDeviceId, recipientHandle, createdAt: new Date().toISOString() });
    return;
  }
  await ensureSchema();
  await db().query(
    `INSERT INTO market_fee_log (slug, market_kind, fee_kind, recipient_device_id, recipient_handle, rate_bps, basis_amount, fee_amount, enforced)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.slug, input.marketKind, input.feeKind, recipientDeviceId, recipientHandle, input.rateBps, input.basisAmount, input.feeAmount, input.enforced],
  );
}
/**
 * The real-money creator fee, as it was actually taken.
 *
 * This was `logRealFee` and it logged a hypothetical: the deployed
 * program had no fee instruction, so the rate was a proposal and every row
 * carried `enforced: false`. oddie_chain changed that. resolve_market fixes
 * creator_fee_lamports out of the pool before any winner is paid, so by the
 * time this runs the money is already deducted and the rows are a record, not
 * a plan. Hence the rename: a function called "intent" writing enforced rows
 * is the drift that makes a log untrustworthy.
 *
 * `enforced: true` means DEDUCTED, not COLLECTED. The program holds the fee in
 * the vault until the creator signs claim_creator_fee for it, and a creator
 * who never connects a wallet never claims. Anything rendering these rows has
 * to say "yours to claim" rather than "paid to you" until the claim lands.
 *
 * The protocol branch is live too now, on the same terms: deducted by
 * resolve_market, held in the vault, and pulled by claim_protocol_fee. Both
 * halves of the 4% are real, and both are recorded here as deducted rather
 * than as collected.
 */
export async function logRealFee(
  slug: string,
  totalVaultLamports: number,
  /**
   * The rate the PROGRAM actually fixed on this market, read from the chain by
   * the caller. Not every market charges the full rate any more: one with no
   * creator to pay is minted at 0, and recomputing from the constant booked a
   * 2% creator fee against a market the chain deducted nothing for -- a ledger
   * that disagrees with the vault. Defaults to the constant for callers that
   * have no state to hand, which is the correct reading for every market minted
   * before rates could differ.
   */
  creatorFeeBps: number = CREATOR_FEE_BPS_REAL,
): Promise<void> {
  try {
    if (totalVaultLamports <= 0) return;
    const surfacer = await surfacerFor(slug);
    const creatorFeeAmount = Math.floor((totalVaultLamports * creatorFeeBps) / 10000);
    const protocolFeeAmount = Math.floor((totalVaultLamports * PROTOCOL_FEE_BPS_REAL) / 10000);
    if (creatorFeeAmount > 0) {
      await logFee({
        slug, marketKind: "real", feeKind: "creator",
        recipientDeviceId: surfacer?.deviceId ?? null, recipientHandle: surfacer?.handle ?? null,
        rateBps: creatorFeeBps, basisAmount: totalVaultLamports, feeAmount: creatorFeeAmount, enforced: true,
      });
    }
    if (protocolFeeAmount > 0) {
      await logFee({
        slug, marketKind: "real", feeKind: "protocol",
        recipientDeviceId: null, recipientHandle: null,
        rateBps: PROTOCOL_FEE_BPS_REAL, basisAmount: totalVaultLamports, feeAmount: protocolFeeAmount, enforced: true,
      });
    }
  } catch (e) { console.error("[fees] real-money fee logging failed:", (e as Error).message); }
}

/**
 * What the TAGGER actually earned on each of these markets — the receipt
 * behind the "a cut goes to whoever tagged this" promise on a market card.
 *
 * Play rows only, and the reason changed. It used to be that a `real` row was
 * an unenforced hypothetical. Now a real row IS deducted on-chain, but the
 * lamports sit in the vault until the creator signs claim_creator_fee, so it
 * is money owed rather than money received, and this function answers "what
 * arrived". Mixing the two would put "earned" on a card next to a balance
 * that never moved. A real market's owed-and-unclaimed fee belongs in its own
 * read, against the chain, not in this one. Returns
 * only slugs that actually paid, so a caller can treat "absent" as "nothing
 * paid yet" without distinguishing zero from missing.
 */
export async function creatorFeesPaidFor(slugs: string[]): Promise<Record<string, { amount: number; handle: string | null }>> {
  const out: Record<string, { amount: number; handle: string | null }> = {};
  if (!slugs.length) return out;
  const wanted = new Set(slugs);
  if (!PERSISTENT) {
    for (const r of memFeeLog) {
      if (r.marketKind !== "play" || r.feeKind !== "creator" || !r.enforced) continue;
      if (!wanted.has(r.slug) || r.feeAmount <= 0) continue;
      const cur = out[r.slug];
      out[r.slug] = { amount: (cur?.amount ?? 0) + r.feeAmount, handle: cur?.handle ?? r.recipientHandle };
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; amount: string; handle: string | null }>(
    `SELECT slug, SUM(fee_amount)::bigint AS amount, MIN(recipient_handle) AS handle
       FROM market_fee_log
      WHERE slug = ANY($1) AND market_kind = 'play' AND fee_kind = 'creator'
        AND enforced = true AND fee_amount > 0
      GROUP BY slug`, [slugs]);
  for (const r of rows) out[r.slug] = { amount: Number(r.amount), handle: r.handle };
  return out;
}

/**
 * The CREATOR half of a user's identity, as distinct from the caller half.
 *
 * Two different things are worth being known for here and they must not be
 * collapsed into one number: `accuracyFor`/`reputationFor` say how good your
 * CALLS are, this says how good your MARKETS are. Someone can be a mediocre
 * caller and an excellent market-maker, and the product should be able to say
 * so — which it cannot while "reputation" only ever means prediction accuracy.
 */
export interface CreatorStats {
  /** Play-token creator fees actually received (enforced rows only). */
  earnings: number;
  /** Markets this device tagged into existence. */
  marketsCreated: number;
  /** Distinct people who have taken a position on those markets. */
  tradersReached: number;
}

export async function creatorStatsFor(rawDeviceId: string): Promise<CreatorStats> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) {
    const mine = [...memSurfacer.entries()].filter(([, s]) => s.deviceId === deviceId).map(([slug]) => slug);
    const earnings = memFeeLog
      .filter((r) => r.recipientDeviceId === deviceId && r.marketKind === "play" && r.feeKind === "creator" && r.enforced)
      .reduce((a, r) => a + r.feeAmount, 0);
    const traders = new Set(memCalls.filter((c) => mine.includes(c.slug)).map((c) => c.deviceId));
    return { earnings, marketsCreated: mine.length, tradersReached: traders.size };
  }
  await ensureSchema();
  const [fees, made, traders] = await Promise.all([
    db().query<{ sum: string | null }>(
      `SELECT COALESCE(SUM(fee_amount),0)::bigint AS sum FROM market_fee_log
        WHERE recipient_device_id = $1 AND market_kind='play' AND fee_kind='creator' AND enforced = true`, [deviceId]),
    db().query<{ n: string }>(`SELECT COUNT(*)::bigint AS n FROM market_surfacer WHERE device_id = $1`, [deviceId]),
    db().query<{ n: string }>(
      `SELECT COUNT(DISTINCT mc.device_id)::bigint AS n FROM market_call mc
         JOIN market_surfacer ms ON ms.slug = mc.slug
        WHERE ms.device_id = $1 AND mc.device_id IS NOT NULL`, [deviceId]),
  ]);
  return {
    earnings: Number(fees.rows[0]?.sum ?? 0),
    marketsCreated: Number(made.rows[0]?.n ?? 0),
    tradersReached: Number(traders.rows[0]?.n ?? 0),
  };
}

/**
 * The CREATOR leaderboard — who is good at MAKING markets, ranked by what the
 * product's economics actually pay for: creator fees earned, then markets
 * created as the tiebreak (and the only signal before any market resolves).
 *
 * The caller boards answer "who predicts well"; this answers "whose markets do
 * people trade". Both are status, they are different skills, and the second
 * one is the growth loop — so it gets a board of its own instead of being a
 * footnote on someone's profile.
 *
 * Only ENFORCED play-token creator fees count as earnings — logged real-money
 * intents are not money anyone received (see logRealFee) and putting
 * them on a public board would be inventing income. Creators with zero fees
 * but real markets still chart (ranked below every earner): early on, the
 * board would otherwise be empty, and "made 3 markets nobody traded yet" is
 * an honest row.
 */
export interface CreatorLeaderRow {
  deviceId: string;
  handle: string;
  earnings: number;        // play-token creator fees actually received
  marketsCreated: number;
}

export async function leaderboardCreators(limit = 20): Promise<CreatorLeaderRow[]> {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));

  // deviceId -> {earnings, created}
  const agg = new Map<string, { earnings: number; created: number }>();
  const bump = (id: string, e: number, c: number) => {
    const cur = agg.get(id) ?? { earnings: 0, created: 0 };
    agg.set(id, { earnings: cur.earnings + e, created: cur.created + c });
  };

  if (!PERSISTENT) {
    for (const [, s] of memSurfacer) if (s.deviceId) bump(s.deviceId, 0, 1);
    for (const r of memFeeLog) {
      if (r.marketKind !== "play" || r.feeKind !== "creator" || !r.enforced || !r.recipientDeviceId) continue;
      bump(r.recipientDeviceId, r.feeAmount, 0);
    }
  } else {
    await ensureSchema();
    const [made, fees] = await Promise.all([
      db().query<{ device_id: string; n: string }>(
        `SELECT device_id, COUNT(*)::bigint n FROM market_surfacer
          WHERE device_id IS NOT NULL GROUP BY device_id`),
      db().query<{ device_id: string; sum: string }>(
        `SELECT recipient_device_id AS device_id, SUM(fee_amount)::bigint sum
           FROM market_fee_log
          WHERE market_kind='play' AND fee_kind='creator' AND enforced = true
            AND recipient_device_id IS NOT NULL
          GROUP BY recipient_device_id`),
    ]);
    for (const r of made.rows) bump(r.device_id, 0, Number(r.n));
    for (const r of fees.rows) bump(r.device_id, Number(r.sum), 0);
  }

  // Same rule as every other public board: the brand's own account never
  // competes against its users.
  const excludedId = await excludedLeaderboardDeviceId();

  const ranked = [...agg.entries()]
    .filter(([id, v]) => id !== excludedId && (v.earnings > 0 || v.created > 0))
    .sort(([, a], [, b]) => b.earnings - a.earnings || b.created - a.created)
    .slice(0, n);

  // Handles only for the rows that made the cut — this board is small.
  return Promise.all(ranked.map(async ([deviceId, v]) => ({
    deviceId,
    handle: ((await displayHandleFor(deviceId).catch(() => null)) ?? `#${deviceId.slice(0, 4)}`).replace(/^@+/, ""),
    earnings: v.earnings,
    marketsCreated: v.created,
  })));
}

/**
 * The creator's own dashboard: every market THIS device tagged, with the
 * numbers that tell them how each one is doing. This is "My Markets" — the
 * page that answers "did making that market pay off?", which nothing else in
 * the product answered per-market.
 */
export interface MyMarketRow {
  slug: string;
  question: string;
  closesAt: string | null;
  resolvedOutcome: "yes" | "no" | null;
  poolTokens: number;
  callers: number;
  feesEarned: number;
}

export async function marketsSurfacedBy(rawDeviceId: string, limit = 50): Promise<MyMarketRow[]> {
  const deviceId = await resolveDevice(rawDeviceId);
  const n = Math.max(1, Math.min(200, Math.floor(limit)));

  let base: Array<{ slug: string; question: string; closesAt: string | null; resolvedOutcome: "yes" | "no" | null }>;
  if (!PERSISTENT) {
    base = [...memSurfacer.entries()]
      .filter(([, s]) => s.deviceId === deviceId)
      .map(([slug]) => {
        const rec = mem.get(slug);
        const meta = memCommunity.get(slug);
        return {
          slug,
          question: rec?.market.question ?? slug,
          closesAt: rec?.market.closesAt ?? null,
          resolvedOutcome: meta?.resolvedOutcome ?? null,
        };
      })
      .slice(-n).reverse(); // newest tag first
  } else {
    await ensureSchema();
    const { rows } = await db().query<{ slug: string; question: string; closes_at: Date | null; resolved_outcome: "yes" | "no" | null }>(
      `SELECT ms.slug, s.question, s.closes_at, cm.resolved_outcome
         FROM market_surfacer ms
         JOIN market_slug s ON s.slug = ms.slug
         LEFT JOIN community_market cm ON cm.slug = ms.slug
        WHERE ms.device_id = $1
        ORDER BY ms.created_at DESC LIMIT $2`, [deviceId, n]);
    base = rows.map((r) => ({
      slug: r.slug, question: r.question,
      closesAt: r.closes_at ? r.closes_at.toISOString() : null,
      resolvedOutcome: r.resolved_outcome,
    }));
  }
  if (!base.length) return [];

  const slugs = base.map((b) => b.slug);
  const [pools, players, fees] = await Promise.all([
    communityPoolSizes(slugs).catch(() => ({} as Record<string, number>)),
    communityPlayerCounts(slugs).catch(() => ({} as Record<string, number>)),
    creatorFeesPaidFor(slugs).catch(() => ({} as Record<string, { amount: number; handle: string | null }>)),
  ]);
  return base.map((b) => ({
    ...b,
    poolTokens: pools[b.slug] ?? 0,
    callers: players[b.slug] ?? 0,
    feesEarned: fees[b.slug]?.amount ?? 0,
  }));
}

/** Recent fee events, newest first — the admin audit view over market_fee_log. */
export async function feeLog(limit = 100): Promise<FeeLogRow[]> {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  if (!PERSISTENT) return [...memFeeLog].reverse().slice(0, n);
  await ensureSchema();
  const { rows } = await db().query<{
    slug: string; market_kind: "play" | "real"; fee_kind: "creator" | "protocol";
    recipient_device_id: string | null; recipient_handle: string | null;
    rate_bps: number; basis_amount: string; fee_amount: string; enforced: boolean; created_at: Date;
  }>(`SELECT slug, market_kind, fee_kind, recipient_device_id, recipient_handle, rate_bps, basis_amount, fee_amount, enforced, created_at
        FROM market_fee_log ORDER BY id DESC LIMIT $1`, [n]);
  return rows.map((r) => ({
    slug: r.slug, marketKind: r.market_kind, feeKind: r.fee_kind,
    recipientDeviceId: r.recipient_device_id, recipientHandle: r.recipient_handle,
    rateBps: r.rate_bps, basisAmount: Number(r.basis_amount), feeAmount: Number(r.fee_amount),
    enforced: r.enforced, createdAt: r.created_at.toISOString(),
  }));
}

/** Create a community market (base slug + community row). Returns its slug and
 *  the numeric id used BOTH as the market's venueId and its on-chain market_id. */
export async function createCommunityMarket(input: {
  question: string;
  closeTime: number; // unix seconds
  category?: string;
  yesPct?: number; // starting odds; default 50
  resolutionCriteria?: string | null; // the "Resolves by: …" rules bettors see
  resolvability?: string | null; // gate grade: clean | fuzzy | unresolvable
  // Supplied by callers that must mint on-chain BEFORE they are willing to
  // publish a row, since the same id has to address both. Defaults to the
  // clock, which is what every other caller wants.
  marketId?: number;
  /** Decided by the caller from the source, and stored, so the mint never has
   *  to re-derive it from a row that may not exist yet. Defaults to the full
   *  rate, which is what every caller that has a creator wants. */
  creatorFeeBps?: number;
}): Promise<{ slug: string; marketId: number; market: Market }> {
  const marketId = input.marketId ?? Date.now(); // unique-per-ms; also the on-chain market_id (u64)
  const yesPct = Math.max(1, Math.min(99, Math.round(input.yesPct ?? 50)));
  const category = input.category?.trim() || "Community";
  const resolutionCriteria = input.resolutionCriteria?.trim() || null;
  const resolvability = input.resolvability?.trim() || null;
  const creatorFeeBps = Number.isInteger(input.creatorFeeBps) ? input.creatorFeeBps! : CREATOR_FEE_BPS_REAL;
  const market: Market = {
    venue: "community",
    venueId: String(marketId),
    question: input.question,
    yesPct,
    closesAt: new Date(input.closeTime * 1000).toISOString(),
    volumeUsd: 0, // honest: community markets have no real volume
    venueUrl: "",
    tags: [],
  };
  const rec = await createSlug(market);

  if (!PERSISTENT) {
    memCommunity.set(rec.slug, {
      slug: rec.slug, marketId, category, resolvedOutcome: null, onchainPubkey: null, onchainSig: null,
      resolutionCriteria, resolvability, creatorFeeBps,
    });
    return { slug: rec.slug, marketId, market };
  }
  await ensureSchema();
  await db().query(
    `INSERT INTO community_market (slug, market_id, category, resolution_criteria, resolvability, creator_fee_bps)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (slug) DO NOTHING`,
    [rec.slug, marketId, category, resolutionCriteria, resolvability, creatorFeeBps],
  );
  return { slug: rec.slug, marketId, market };
}

/* --------------------------------------------------------- Season Points -----
 * Backend-only CONTRIBUTION score. It is never shown as a standalone number
 * (per the two-concept model); it exists to feed future reward eligibility and
 * to let us tune real contribution against behaviour. It does NOT drive the
 * season rank — that stays the calibrated Oddie Score.
 *
 * Everything routes through one idempotent award() and one ledger table, so the
 * total is always SUM(amount) and no event can ever pay twice.
 */
export const SEASON_POINTS = {
  surface: 50,        // a tagged claim cleared the gate and became a live market
  three_players: 100, // that market reached 3 distinct participants
  first_timer: 100,   // a brand-new player took their first-ever call on it
  clean_resolve: 50,  // it resolved cleanly (no manual override)
  // Posting a call to X. Deduped per (device, call), so it pays for putting a
  // DIFFERENT position in front of people, not for pressing the button twice.
  // This is the one event a player can trigger directly and deliberately, which
  // is exactly the point: the cheapest way to raise your score should be to say
  // something on X.
  shared: 40,
  // The crowd ladder, continuing three_players: the market you surfaced keeps
  // paying as it fills. Steps are GEOMETRIC on purpose (face oddies 200 → 500
  // → 1500 → 5000) — "a bigger market is disproportionately better" — but the
  // curve lives in tier JUMPS, never in a per-call exponent: between tiers a
  // marginal (sybil) call earns the surfacer exactly nothing, and each rung is
  // a shareable moment ("my market just hit 25 players").
  ten_players: 250,
  twentyfive_players: 750,
  hundred_players: 2500,
  // A weekly Loudest Callers pick — the operator's judgment on the week's best
  // posts about oddie, awarded by hand from /tool. Priced above first_timer
  // because it is competitive (a handful of winners a week, not an action
  // anyone can repeat), and deduped per (person, ISO week) so a resubmitted
  // list cannot double-pay.
  loud: 150,
  // A submitted post link that passed review. Between shared and loud on
  // purpose — the ladder, in oddies face value: pressed share (+80,
  // optimistic), the post really exists and holds up (+150, verified), among
  // the week's best (+300, picked). Deduped per tweet, so one post pays once
  // no matter who resubmits it.
  loud_post: 75,
} as const;
export type SeasonEvent = keyof typeof SEASON_POINTS;

/**
 * What each ledger event is WORTH in oddies — the only unit any user-facing
 * surface may name. SEASON_POINTS above are internal ledger amounts (kept
 * as-is so historical season_points_log rows stay comparable); the score
 * doubles them in (SCORE_WEIGHTS.contribution, flat-added), so face value =
 * ledger × 2. Every "+N" the UI promises must come from THIS table.
 */
export const ODDIES_PER = Object.fromEntries(
  (Object.keys(SEASON_POINTS) as SeasonEvent[]).map((k) => [k, SEASON_POINTS[k] * SCORE_WEIGHTS.contribution]),
) as Record<SeasonEvent, number>;

/** Pull the tweet author's handle out of a status URL (x.com / twitter.com).
 *  Lowercased, no "@". Null when the URL isn't a recognisable tweet permalink —
 *  an operator-created market with no identifiable contributor earns nothing. */
export function handleFromSourceUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  // PARSED, NOT PATTERN-MATCHED. The regex this replaces looked for
  // "//x.com/<handle>/status/" anywhere in the string, so any URL that merely
  // CONTAINED one matched: https://evil.example.com/#https://x.com/victim/status/1
  // credited "victim". That is not a cosmetic bug. This handle decides who
  // receives the creator fee and who is written on chain as the market's
  // creator, so a caller who could choose the source URL could choose whose
  // name went on somebody else's market.
  let u: URL;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  if (!["x.com", "twitter.com", "fixupx.com", "vxtwitter.com"].includes(host)) return null;
  // The handle must be the FIRST path segment and be followed by /status/, so a
  // fragment or a query string cannot contribute either.
  const m = /^\/([A-Za-z0-9_]{1,15})\/status\/\d+/.exec(u.pathname);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Is this a source we accept at all — a different question from who it pays.
 *
 * These two were the same function, and that is exactly the bug. On X they
 * coincide: the handle in the URL is both the provenance and the payee. On
 * Telegram they come apart. A t.me link is a real, checkable source for the
 * card, but there is no handle in it and therefore nobody to pay. Asking
 * `handleFromSourceUrl` whether a source is acceptable answered "no" for every
 * Telegram market ever submitted, so the bot could not open a single one.
 *
 * `handleFromSourceUrl` stays exactly as it is — it decides who receives money
 * and is deliberately narrow. This decides whether we will show the market at
 * all, and is allowed to be wider.
 */
export type SourceKind = "x" | "telegram";
export function sourceUrlKind(url: string | null | undefined): SourceKind | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  // A trailing slash is the same link. Stripped before matching because the
  // Telegram pattern is $-anchored, and without this "t.me/group/123/" -- which
  // Telegram itself produces -- was refused outright as an unknown source.
  const path = u.pathname.replace(/\/+$/, "");
  if (["x.com", "twitter.com", "fixupx.com", "vxtwitter.com"].includes(host)) {
    // Still has to be a real status permalink, not just the right host.
    //
    // The handle-less forms are included on purpose. mentionLoop.ts:107 emits
    // `x.com/i/web/status/<id>` whenever it could not resolve the author, and
    // the previous shape rejected exactly those, which switched off
    // one-post-one-market for the bot's own primary path: existingMarket found
    // nothing, so the same tweet could open a market on every pass.
    // handleFromSourceUrl still returns null for them, which is correct -- no
    // handle means no payee -- so they mint at 0 bps, which is also correct.
    return /^\/(?:i\/web\/status|i\/status|[A-Za-z0-9_]{1,15}\/status)\/\d+/.test(path) ? "x" : null;
  }
  // t.me/<group>/<id> for a public group, t.me/c/<internal>/<id> for a private
  // one. Both identify exactly one message, which is all provenance needs.
  if (host === "t.me") {
    return /^\/(c\/\d+|[A-Za-z0-9_]{4,32})\/\d+$/.test(path) ? "telegram" : null;
  }
  return null;
}

/**
 * The identity of the post a market came from, for the one-post-one-market rule.
 *
 * Not the URL itself: x.com, twitter.com, fixupx.com and vxtwitter.com are four
 * spellings of the same tweet, so the status id is the identity there. A
 * Telegram message has no such id in the URL, so the normalised path is — which
 * is why this returns a KEY rather than a number, and why the old `/status/`
 * regex silently disabled the whole rule for Telegram: no match, no dedupe, a
 * fresh market for every retry.
 */
export function sourcePostKey(url: string | null | undefined): string | null {
  const kind = sourceUrlKind(url);
  if (!kind) return null;
  const u = new URL(String(url));
  if (kind === "x") {
    const id = /\/status\/(\d+)/.exec(u.pathname)?.[1];
    // Digits, normalised: "0000123" and "123" are the same tweet.
    return id ? `x:${BigInt(id).toString()}` : null;
  }
  // NORMALISED, not just lowercased. The caller writes this URL, and the raw
  // path let one Telegram message produce unlimited distinct keys -- pad the id
  // with leading zeros and the one-post-one-market rule sees a new post every
  // time, so a retry loop mints a market per attempt.
  //
  // Residual, and deliberate: a group's public form (t.me/<name>/<id>) and its
  // private form (t.me/c/<internal>/<id>) are two keys for one message. They
  // cannot be reconciled from the URL alone, a group only ever emits one of
  // them at a time, and the per-caller idempotency ledger covers the retry
  // case, so this is a note rather than a hole.
  const seg = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const id = BigInt(seg[seg.length - 1]!).toString();
  const chat = seg.slice(0, -1).join("/").toLowerCase();
  return `tg:/${chat}/${id}`;
}


/** Resolve a twitter handle to a canonical device, or null if that handle has
 *  no Oddie account yet. Checks the linked-account table first (the authoritative
 *  twitter→device map), then a device that simply set this as its handle. */
async function deviceForTwitterHandle(handle: string | null): Promise<string | null> {
  if (!handle) return null;
  const h = handle.replace(/^@+/, "").toLowerCase();
  if (!PERSISTENT) {
    // Mirror the persistent order: a LINKED twitter account wins over a merely
    // chosen handle. (memHandle holds chosen handles; _memAccounts the linked ones.)
    const { _memAccounts } = await import("./accounts.js");
    const acct = _memAccounts.find((a) => a.provider === "twitter" && a.handle && a.handle.replace(/^@+/, "").toLowerCase() === h);
    if (acct) return acct.canonicalDevice;
    for (const [dev, hh] of memHandle) if (hh.replace(/^@+/, "").toLowerCase() === h) return dev;
    return null;
  }
  await ensureSchema();
  // ltrim(handle,'@') is load-bearing: `h` above has had its "@" stripped, but
  // a LINKED X handle is stored WITH the "@" it came from the provider with
  // (that is why leaderboard() strips one before display — see the note there).
  // Comparing a stripped needle against an unstripped haystack matched nothing,
  // so every X-linked account was invisible to this lookup in Postgres while
  // the in-memory path — which strips both sides — worked fine. That divergence
  // is why the mem-only test suite passed while production silently 404'd every
  // /@handle profile, dropped surfacer attribution, and let the excluded
  // @oddiefun account straight back onto the leaderboard.
  const { rows } = await db().query<{ device_id: string }>(
    `SELECT canonical_device AS device_id FROM account
       WHERE provider='twitter' AND lower(ltrim(handle,'@'))=$1 ORDER BY created_at LIMIT 1`, [h]);
  if (rows[0]) return rows[0].device_id;
  // device_balance.handle is a CHOSEN handle, which validateHandle restricts to
  // [a-z0-9_] — it can never carry an "@" — so this side is left as a plain
  // lower(handle) to keep using the device_balance_handle_key functional index.
  const { rows: r2 } = await db().query<{ device_id: string }>(
    `SELECT device_id FROM device_balance WHERE lower(handle)=$1 LIMIT 1`, [h]);
  return r2[0]?.device_id ?? null;
}

/**
 * The brand's own X account (@oddiefun) — used by the team to dogfood the
 * product and, per public/tool.html, to post settlement replies by hand from
 * the real account. Real activity, not a bot and not fabricated (21 closed
 * positions, avgEdge -5.7%, net +234 tokens as of the investigation that
 * added this exclusion — ordinary trading, not a rigged score) — but a
 * device answering to this handle must never appear as if the brand is
 * competing against its own users on a public standings/social surface.
 *
 * Keyed by HANDLE, not device id, per the product call: resolved to whichever
 * device currently answers to it (X-linked wins over chosen, same as
 * deviceForTwitterHandle everywhere else) so a re-link or a handle change
 * can't quietly let it back in. Cached briefly — every leaderboard/settled
 * read would otherwise cost an extra lookup for a value that changes rarely.
 */
const EXCLUDED_LEADERBOARD_HANDLE = "oddiefun";
let excludedHandleCache: { at: number; deviceId: string | null } | null = null;
const EXCLUDED_HANDLE_CACHE_MS = 60_000;
async function excludedLeaderboardDeviceId(): Promise<string | null> {
  const now = Date.now();
  if (excludedHandleCache && now - excludedHandleCache.at < EXCLUDED_HANDLE_CACHE_MS) return excludedHandleCache.deviceId;
  const deviceId = await deviceForTwitterHandle(EXCLUDED_LEADERBOARD_HANDLE).catch(() => null);
  excludedHandleCache = { at: now, deviceId };
  return deviceId;
}
/** Test-only: a test that changes which device answers to "oddiefun" mid-run
 *  (chosen handle in one block, X-linked in the next) needs the exclusion to
 *  reflect that immediately, not up to 60s stale. */
export function _resetExcludedHandleCache(): void { excludedHandleCache = null; }
/** Text-form check for the same exclusion, for the one call site
 *  (recentlySettled's named winners) where a resolved handle is already in
 *  hand and a device id isn't — avoids widening that query just to filter. */
const isExcludedHandle = (h: string | null | undefined): boolean =>
  !!h && h.replace(/^@+/, "").toLowerCase() === EXCLUDED_LEADERBOARD_HANDLE;

/** Record who surfaced a market — once per slug (the first writer wins). Safe to
 *  call repeatedly (every reply generation does). Resolves the handle→device at
 *  write time as a convenience; awards resolve again in case they sign up later. */
export async function recordSurfacer(slug: string, input: { handle?: string | null; deviceId?: string | null; sourceUrl?: string | null }): Promise<void> {
  const handle = (input.handle ?? handleFromSourceUrl(input.sourceUrl))?.replace(/^@+/, "").toLowerCase() ?? null;
  const sourceUrl = input.sourceUrl ?? null;
  const deviceId = input.deviceId ?? (await deviceForTwitterHandle(handle).catch(() => null));
  // A Telegram market has no handle and no device, and it still needs this row:
  // it is where the source URL lives, and the source URL is what the
  // one-post-one-market rule reads. Returning early on "no contributor" meant
  // every Telegram market was created with no provenance AND no dedupe.
  const sourceKey = sourcePostKey(sourceUrl);
  if (!handle && !deviceId && !sourceKey) return; // genuinely nothing to record
  // The source post's text, cached at record time so a market can still show
  // the claim it came from after the post is deleted. Awaited rather than
  // fired off, because this is the one moment we're guaranteed to be holding
  // the URL — but it can never fail the write: fetchSourcePost returns null on
  // every error path, and a null simply means the card shows no preview.
  // X only: fetchSourcePost speaks X's oEmbed, so handing it a t.me link is a
  // guaranteed-null round trip on every Telegram market.
  const post = sourceUrlKind(sourceUrl) === "x" ? await fetchSourcePost(sourceUrl!).catch(() => null) : null;
  if (!PERSISTENT) {
    if (!memSurfacer.has(slug)) memSurfacer.set(slug, {
      handle, deviceId, sourceUrl, sourceKey, createdAt: new Date().toISOString(),
      sourceText: post?.text ?? null, sourceAuthor: post?.authorName ?? null,
    });
    return;
  }
  await ensureSchema();
  await db().query(
    `INSERT INTO market_surfacer (slug, handle, device_id, source_url, source_key, source_text, source_author)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (slug) DO UPDATE SET source_key = EXCLUDED.source_key
       WHERE market_surfacer.source_key IS NULL AND EXCLUDED.source_key IS NOT NULL`,
    [slug, handle, deviceId, sourceUrl, sourceKey, post?.text ?? null, post?.authorName ?? null],
  );
}

/**
 * Fill in source-post text for markets recorded BEFORE we started fetching it.
 *
 * recordSurfacer now caches the post at write time, but every market created
 * before that shipped has a source_url and no text — so the card feature that
 * shows the claim a market came from renders nothing for the entire existing
 * catalogue. This walks those rows and fills them.
 *
 * Deliberately conservative, because it makes N external requests:
 *  - only rows that have a URL and are missing text are touched
 *  - bounded by `limit` per run, so it can be run repeatedly and watched
 *  - sequential with a pause between calls, rather than hammering oEmbed
 *  - a row that fails is LEFT ALONE, not written as empty — a later run
 *    retries it, and a permanently-dead post simply never gets a preview
 *
 * Returns what it did so a caller can report honestly rather than guess.
 */
export async function backfillSourcePosts(
  limit = 25,
  opts: { apply?: boolean; pauseMs?: number } = {},
): Promise<{ candidates: number; fetched: number; written: number; failed: number }> {
  const apply = opts.apply ?? false;
  const pauseMs = opts.pauseMs ?? 250;
  const n = Math.max(1, Math.min(500, Math.floor(limit)));

  let targets: Array<{ slug: string; url: string }>;
  if (!PERSISTENT) {
    targets = [...memSurfacer.entries()]
      .filter(([, s]) => s.sourceUrl && !s.sourceText)
      .slice(0, n)
      .map(([slug, s]) => ({ slug, url: s.sourceUrl! }));
  } else {
    await ensureSchema();
    const { rows } = await db().query<{ slug: string; source_url: string }>(
      `SELECT slug, source_url FROM market_surfacer
        WHERE source_url IS NOT NULL AND source_text IS NULL
        ORDER BY created_at DESC LIMIT $1`, [n]);
    targets = rows.map((r) => ({ slug: r.slug, url: r.source_url }));
  }

  let fetched = 0, written = 0, failed = 0;
  for (const t of targets) {
    const post = await fetchSourcePost(t.url).catch(() => null);
    if (!post) { failed++; }
    else {
      fetched++;
      if (apply) {
        if (!PERSISTENT) {
          const cur = memSurfacer.get(t.slug);
          if (cur) memSurfacer.set(t.slug, { ...cur, sourceText: post.text, sourceAuthor: post.authorName });
        } else {
          await db().query(
            `UPDATE market_surfacer SET source_text = $2, source_author = $3
              WHERE slug = $1 AND source_text IS NULL`,
            [t.slug, post.text, post.authorName],
          );
        }
        written++;
      }
    }
    if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return { candidates: targets.length, fetched, written, failed };
}

/**
 * Every on-chain market this device tagged, so their creator fee can be
 * pointed at a wallet the moment they connect one.
 *
 * A market is minted the second the argument is tagged, and the tagger almost
 * never has a wallet then, so it goes on-chain with the program's unnamed
 * creator sentinel. Nothing about that repairs itself: the fee accrues at
 * resolve to an address with no private key and sits in the vault forever
 * unless something goes back and names them. This is the query that finds
 * what to go back to.
 *
 * Deliberately NOT filtered to "still unnamed", because that fact lives on
 * chain and this file has no chain dependency and should not grow one. The
 * caller reads each market and skips the ones already named; naming twice is
 * refused by the program anyway, so the worst case is a wasted lookup rather
 * than a wrong write. Ordered newest first so a cap bites the oldest markets,
 * which are the ones most likely to be named already.
 */
export async function onchainMarketsSurfacedBy(rawDeviceId: string, limit = 50): Promise<Array<{ slug: string; onchainPubkey: string }>> {
  const deviceId = await resolveDevice(rawDeviceId);
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  if (!PERSISTENT) {
    const out: Array<{ slug: string; onchainPubkey: string }> = [];
    for (const [slug, s] of memSurfacer) {
      if (s.deviceId !== deviceId) continue;
      const pk = memCommunity.get(slug)?.onchainPubkey;
      if (pk) out.push({ slug, onchainPubkey: pk });
    }
    return out.slice(0, n);
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; onchain_pubkey: string }>(
    `SELECT ms.slug, cm.onchain_pubkey
       FROM market_surfacer ms
       JOIN community_market cm ON cm.slug = ms.slug
      WHERE ms.device_id = $1 AND cm.onchain_pubkey IS NOT NULL
      ORDER BY ms.created_at DESC LIMIT $2`, [deviceId, n]);
  return rows.map((r) => ({ slug: r.slug, onchainPubkey: r.onchain_pubkey }));
}

export interface Surfacer { handle: string | null; deviceId: string | null }
export async function surfacerFor(slug: string): Promise<Surfacer | null> {
  if (!PERSISTENT) { const s = memSurfacer.get(slug); return s ? { handle: s.handle, deviceId: s.deviceId } : null; }
  await ensureSchema();
  const { rows } = await db().query<{ handle: string | null; device_id: string | null }>(
    `SELECT handle, device_id FROM market_surfacer WHERE slug=$1`, [slug]);
  return rows[0] ? { handle: rows[0].handle, deviceId: rows[0].device_id } : null;
}

export interface SurfacerInfo {
  handle: string | null;
  sourceUrl: string | null;
  /** The source post's own text, cached at record time — see xOembed.ts. Null
   *  when the post wasn't public, was deleted, or the fetch failed; the card
   *  then shows no preview rather than an empty quote box. */
  sourceText: string | null;
  /** The author's display name ("Hoops Analyst"), distinct from the @handle. */
  sourceAuthor: string | null;
}
/** Batch surfacer info for a set of markets — the tweet author a claim came
 *  from (for "challenge the other side") and the tweet's own URL (for the
 *  permalink page's source-tweet card). One query for a whole feed; both
 *  fields null where a market has no identifiable source. */
export async function surfacersFor(slugs: string[]): Promise<Record<string, SurfacerInfo>> {
  const out: Record<string, SurfacerInfo> = {};
  if (slugs.length === 0) return out;
  if (!PERSISTENT) {
    for (const slug of slugs) {
      const s = memSurfacer.get(slug);
      out[slug] = { handle: s?.handle ?? null, sourceUrl: s?.sourceUrl ?? null, sourceText: s?.sourceText ?? null, sourceAuthor: s?.sourceAuthor ?? null };
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; handle: string | null; source_url: string | null; source_text: string | null; source_author: string | null }>(
    `SELECT slug, handle, source_url, source_text, source_author FROM market_surfacer WHERE slug = ANY($1)`, [slugs]);
  for (const r of rows) out[r.slug] = { handle: r.handle, sourceUrl: r.source_url, sourceText: r.source_text, sourceAuthor: r.source_author };
  for (const s of slugs) out[s] ??= { handle: null, sourceUrl: null, sourceText: null, sourceAuthor: null };
  return out;
}

/**
 * Which of these slugs have a surfacer at all — i.e. which markets are on
 * Oddie because a person tagged them. Distinct from surfacersFor, which
 * describes the tagger and cannot tell "no row" apart from "a row with an
 * anonymous tagger and no source URL". The feed's tagged/untagged partition
 * needs that distinction exactly, so it gets its own membership query.
 */
export async function surfacedSlugs(slugs: string[]): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  if (!PERSISTENT) return new Set(slugs.filter((s) => memSurfacer.has(s)));
  await ensureSchema();
  const { rows } = await db().query<{ slug: string }>(
    `SELECT slug FROM market_surfacer WHERE slug = ANY($1)`, [slugs]);
  return new Set(rows.map((r) => r.slug));
}

/** How far a market's line has moved since the last stored reading, per slug.
 *
 *  Only for markets whose stored yes_pct is the live one — that is, venue
 *  markets. A community market's displayed percentage is computed at read time
 *  by crowdPct from the calls on it, while its market_slug row keeps the
 *  opening line forever, so a delta taken from that row would be measuring a
 *  number nobody is shown. Those slugs are simply absent here and their cards
 *  carry no chip, which is the honest answer rather than a confident zero.
 *
 *  Absent too: a market seen for the first time (no previous reading yet), one
 *  that has not moved, and one whose reading has gone stale enough that "today"
 *  would be a lie — a market that stopped being refreshed keeps its last
 *  reading indefinitely, and a day-old label on a week-old number is worse than
 *  no label. MAX_AGE_H is deliberately a little over the 20h roll window so a
 *  live market is never briefly chipless while waiting to roll. */
export async function pctDeltasFor(slugs: string[]): Promise<Record<string, number>> {
  const MAX_AGE_H = 30;
  if (slugs.length === 0) return {};
  if (!PERSISTENT) return {}; // mem keeps no reading history; see createSlug
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; delta: number }>(
    `SELECT slug, (yes_pct - prev_pct) AS delta
       FROM market_slug
      WHERE slug = ANY($1)
        AND venue <> 'community'
        AND prev_pct IS NOT NULL
        AND prev_pct_at > now() - ($2 || ' hours')::interval
        AND yes_pct <> prev_pct`,
    [slugs, String(MAX_AGE_H)],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.slug] = Number(r.delta);
  return out;
}

/** The one idempotent write. Credits `slug`'s surfacer (resolving handle→device
 *  freshly, so a contributor who signed up AFTER surfacing still gets the row
 *  attributed to their device). No surfacer, or an amount already logged under
 *  the dedup key, is a silent no-op. Best-effort: never throws into the caller.
 *  Returns whether a new award landed. */
async function awardSeasonPoints(
  event: SeasonEvent, slug: string, dedupKey: string,
  /** Credit THIS device instead of the market's surfacer. Sharing is the one
   *  event where the earner is the person who acted, not the person whose
   *  market it is — and it must work for a market somebody else surfaced,
   *  which is most of them. */
  creditDevice?: string,
): Promise<boolean> {
  try {
    let handle: string | null = null;
    let deviceId: string | null = creditDevice ?? null;
    if (!deviceId) {
      const surfacer = await surfacerFor(slug);
      if (!surfacer) return false; // nobody to credit
      handle = surfacer.handle;
      deviceId = surfacer.deviceId ?? (await deviceForTwitterHandle(handle).catch(() => null));
    }
    const amount = SEASON_POINTS[event];
    if (!handle && !deviceId) return false;
    if (!PERSISTENT) {
      if (memSeasonLog.some((r) => r.dedupKey === dedupKey)) return false;
      memSeasonLog.push({ deviceId, handle, event, amount, slug, dedupKey, createdAt: new Date().toISOString() });
      return true;
    }
    await ensureSchema();
    const { rowCount } = await db().query(
      `INSERT INTO season_points_log (device_id, handle, event, amount, slug, dedup_key)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedup_key) DO NOTHING`,
      [deviceId, handle, event, amount, slug, dedupKey],
    );
    return (rowCount ?? 0) > 0;
  } catch { return false; }
}

// The four earning events. Each is idempotent by construction (its dedup key),
// so callers can fire them freely without tracking whether they already have.

/** +50: a tagged claim cleared the gate and became a live market. Once per market. */
export async function awardSurface(slug: string): Promise<boolean> {
  return awardSeasonPoints("surface", slug, `surface:${slug}`);
}
/** +40: this device put one of its calls on X. Deduped per (device, call), so
 *  it pays once for each position shared, not once per press of the button.
 *  Unlike the other four this one credits the SHARER rather than the market's
 *  surfacer — it is their post. */
export async function awardShare(slug: string, deviceId: string, callId: number): Promise<boolean> {
  return awardSeasonPoints("shared", slug, `shared:${callId}`, deviceId);
}
/** +100: `slug` just reached 3 distinct participants. Once per market. */
export async function awardThreePlayers(slug: string): Promise<boolean> {
  return awardSeasonPoints("three_players", slug, `three_players:${slug}`);
}
/** +100: a brand-new player took their first-ever call on `slug`. Keyed by the
 *  new player, so a surfacer is paid once per distinct newcomer they bring in.
 *  A surfacer taking their OWN first call earns nothing — that isn't bringing
 *  anyone in. */
export async function awardFirstTimer(slug: string, newDeviceId: string): Promise<boolean> {
  const s = await surfacerFor(slug).catch(() => null);
  if (s?.deviceId && s.deviceId === newDeviceId) return false;
  return awardSeasonPoints("first_timer", slug, `first_timer:${newDeviceId}`);
}
/** +50: `slug` resolved cleanly (no manual override — the only kind today). Once. */
export async function awardCleanResolve(slug: string): Promise<boolean> {
  return awardSeasonPoints("clean_resolve", slug, `clean_resolve:${slug}`);
}

/** The ISO-8601 week a date falls in, as "2026-W33" — the loud award's dedup
 *  unit. UTC throughout, so the week does not flip with the server's timezone. */
export function isoWeekOf(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // to this week's Thursday
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}

/** +150: a weekly Loudest Callers pick. The operator chooses the week's best
 *  posts about oddie by hand (X search, human judgment) and names the authors;
 *  this credits each one directly — like `shared`, the earner is the person
 *  who posted, and there is no market to attribute, so the slug is the
 *  synthetic `loud-<week>`. One award per (person, week) via the dedup key,
 *  which makes resubmitting a list safe. */
export async function awardLoud(
  rawHandle: string, week: string,
): Promise<{ ok: true } | { ok: false; reason: "no_account" | "already" }> {
  const handle = rawHandle.replace(/^@+/, "").trim().toLowerCase();
  const deviceId = handle ? await deviceForHandle(handle) : null;
  if (!deviceId) return { ok: false, reason: "no_account" };
  const ok = await awardSeasonPoints("loud", `loud-${week}`, `loud:${week}:${handle}`, deviceId);
  return ok ? { ok } : { ok: false, reason: "already" };
}

/* ---------------------------------------------------------- loud posts --
 * Phase 1 of the loudness flywheel: instead of the operator hunting X for
 * posts, players bring their own link. Submitting requires a linked X
 * account; the credit only lands after review — the operator's eyeballs
 * today, an X API read (author + content) once API credits exist. Both
 * paths settle through decideLoudPost, so switching to the API changes
 * nothing else.
 */

/** An x.com / twitter.com status URL → its parts. Accepts www./mobile. hosts
 *  and the old /statuses/ form; refuses everything else. */
export function parseTweetUrl(raw: string): { handle: string; tweetId: string } | null {
  const m = String(raw).trim().match(
    /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})\b/,
  );
  return m ? { handle: m[1], tweetId: m[2] } : null;
}

/** The device's LINKED X handle (@-less), or null. The chosen display handle
 *  deliberately does not count — a loud post must come from a real account. */
async function linkedXHandleFor(deviceId: string): Promise<string | null> {
  if (!PERSISTENT) {
    const { _memAccounts } = await import("./accounts.js");
    const a = _memAccounts.find((x) => x.canonicalDevice === deviceId && x.provider === "twitter" && x.handle);
    return a?.handle?.replace(/^@+/, "") ?? null;
  }
  await ensureSchema();
  const { rows } = await db().query<{ handle: string | null }>(
    `SELECT handle FROM account
      WHERE canonical_device = $1 AND provider = 'twitter' AND handle IS NOT NULL
      ORDER BY created_at LIMIT 1`, [deviceId]);
  return rows[0]?.handle?.replace(/^@+/, "") ?? null;
}

/** Submissions per device per rolling 24h. High enough for a real poster,
 *  low enough that the review queue cannot be flooded from one account. */
export const LOUD_DAILY_CAP = 5;

export interface LoudPostRow {
  id: number; url: string; status: "pending" | "approved" | "rejected";
  week: string; note: string | null; createdAt: string;
}

export type LoudSubmit =
  | { ok: true; status: "pending" }
  | { ok: false; reason: "no_x_account" | "bad_url" | "not_your_account" | "already_submitted" | "daily_cap" };

export async function submitLoudPost(rawDeviceId: string, url: string, now = new Date()): Promise<LoudSubmit> {
  const deviceId = await resolveDevice(rawDeviceId);
  const parsed = parseTweetUrl(url);
  if (!parsed) return { ok: false, reason: "bad_url" };
  const linked = await linkedXHandleFor(deviceId);
  if (!linked) return { ok: false, reason: "no_x_account" };
  // Authorship, checked for free: the handle in a canonical status URL is the
  // author's. X ignores that segment when resolving, so a crafted URL can lie —
  // review is what actually settles authorship; this refuses the honest-mistake
  // case (pasting someone else's post) without spending a read.
  if (parsed.handle.toLowerCase() !== linked.toLowerCase()) return { ok: false, reason: "not_your_account" };
  const week = isoWeekOf(now);
  const canonical = `https://x.com/${parsed.handle}/status/${parsed.tweetId}`;

  if (!PERSISTENT) {
    if (memLoudPosts.some((p) => p.tweetId === parsed.tweetId)) return { ok: false, reason: "already_submitted" };
    const since = now.getTime() - 86_400_000;
    if (memLoudPosts.filter((p) => p.deviceId === deviceId && Date.parse(p.createdAt) > since).length >= LOUD_DAILY_CAP)
      return { ok: false, reason: "daily_cap" };
    memLoudPosts.push({
      id: ++memLoudPostId, deviceId, tweetId: parsed.tweetId, url: canonical,
      status: "pending", week, note: null, createdAt: now.toISOString(), decidedAt: null,
    });
    return { ok: true, status: "pending" };
  }
  await ensureSchema();
  const { rows: cap } = await db().query<{ n: string }>(
    `SELECT count(*) AS n FROM loud_post WHERE device_id = $1 AND created_at > now() - interval '24 hours'`, [deviceId]);
  if (Number(cap[0].n) >= LOUD_DAILY_CAP) return { ok: false, reason: "daily_cap" };
  const { rowCount } = await db().query(
    `INSERT INTO loud_post (device_id, tweet_id, url, week) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tweet_id) DO NOTHING`, [deviceId, parsed.tweetId, canonical, week]);
  return (rowCount ?? 0) > 0 ? { ok: true, status: "pending" } : { ok: false, reason: "already_submitted" };
}

/** A device's own submissions, newest first — the "where's my credit" view. */
export async function loudPostsFor(rawDeviceId: string, limit = 20): Promise<LoudPostRow[]> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) {
    return memLoudPosts.filter((p) => p.deviceId === deviceId).slice(-limit).reverse()
      .map((p) => ({ id: p.id, url: p.url, status: p.status, week: p.week, note: p.note, createdAt: p.createdAt }));
  }
  await ensureSchema();
  const { rows } = await db().query<{ id: string; url: string; status: LoudPostRow["status"]; week: string; note: string | null; created_at: Date }>(
    `SELECT id, url, status, week, note, created_at FROM loud_post
      WHERE device_id = $1 ORDER BY id DESC LIMIT $2`, [deviceId, Math.max(1, Math.min(50, limit))]);
  return rows.map((r) => ({ id: Number(r.id), url: r.url, status: r.status, week: r.week, note: r.note, createdAt: r.created_at.toISOString() }));
}

export interface LoudQueueRow { id: number; url: string; handle: string | null; week: string; createdAt: string }

/** Pending submissions, oldest first — the operator's review queue. */
export async function loudQueue(limit = 50): Promise<LoudQueueRow[]> {
  if (!PERSISTENT) {
    const out: LoudQueueRow[] = [];
    for (const p of memLoudPosts.filter((x) => x.status === "pending").slice(0, limit)) {
      out.push({ id: p.id, url: p.url, handle: await linkedXHandleFor(p.deviceId), week: p.week, createdAt: p.createdAt });
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{ id: string; url: string; handle: string | null; week: string; created_at: Date }>(
    `SELECT lp.id, lp.url, lp.week, lp.created_at,
            (SELECT a.handle FROM account a
              WHERE a.canonical_device = lp.device_id AND a.provider = 'twitter' AND a.handle IS NOT NULL
              ORDER BY a.created_at LIMIT 1) AS handle
       FROM loud_post lp WHERE lp.status = 'pending' ORDER BY lp.id LIMIT $1`, [limit]);
  return rows.map((r) => ({
    id: Number(r.id), url: r.url, handle: r.handle ? r.handle.replace(/^@+/, "") : null,
    week: r.week, createdAt: r.created_at.toISOString(),
  }));
}

export type LoudDecision =
  | { ok: true; status: "approved" | "rejected" }
  | { ok: false; reason: "not_found" | "already_decided" };

/** Settle one submission, once — a decided row never flips, so approve cannot
 *  double-pay (the award's tweet-keyed dedup backs that up anyway). The
 *  operator calls this from /tool today; the API verifier will call the same
 *  function when credits exist. */
export async function decideLoudPost(id: number, approve: boolean, note?: string | null): Promise<LoudDecision> {
  const status = approve ? ("approved" as const) : ("rejected" as const);
  let deviceId: string, tweetId: string;
  if (!PERSISTENT) {
    const p = memLoudPosts.find((x) => x.id === id);
    if (!p) return { ok: false, reason: "not_found" };
    if (p.status !== "pending") return { ok: false, reason: "already_decided" };
    p.status = status; p.note = note ?? null; p.decidedAt = new Date().toISOString();
    deviceId = p.deviceId; tweetId = p.tweetId;
  } else {
    await ensureSchema();
    const { rows } = await db().query<{ device_id: string; tweet_id: string }>(
      `UPDATE loud_post SET status = $2, note = $3, decided_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING device_id, tweet_id`, [id, status, note ?? null]);
    if (!rows.length) {
      const { rows: exists } = await db().query(`SELECT 1 FROM loud_post WHERE id = $1`, [id]);
      return exists.length ? { ok: false, reason: "already_decided" } : { ok: false, reason: "not_found" };
    }
    deviceId = rows[0].device_id; tweetId = rows[0].tweet_id;
  }
  if (approve) await awardSeasonPoints("loud_post", "loud-post", `loud_post:${tweetId}`, deviceId);
  return { ok: true, status };
}

/** The loud multiplier's inputs and answer for one device: cleared posts and
 *  weekly-Loudest wins in the trailing 30 days. Feeds scoreActivityFor (so
 *  every score read applies it) and /api/loud/mine (so the sheet can SAY it). */
export async function loudStatusFor(rawDeviceId: string): Promise<{ clearedIn30d: number; weeklyWinIn30d: boolean; multiplier: number }> {
  const deviceId = await resolveDevice(rawDeviceId);
  const since = Date.now() - 30 * 86_400_000;
  let clearedIn30d = 0, weeklyWinIn30d = false;
  if (!PERSISTENT) {
    clearedIn30d = memLoudPosts.filter((p) => p.deviceId === deviceId && p.status === "approved"
      && p.decidedAt && Date.parse(p.decidedAt) > since).length;
    weeklyWinIn30d = memSeasonLog.some((r) => r.deviceId === deviceId && r.event === "loud" && Date.parse(r.createdAt) > since);
  } else {
    await ensureSchema();
    const [posts, wins] = await Promise.all([
      db().query<{ n: string }>(
        `SELECT count(*) AS n FROM loud_post
          WHERE device_id = $1 AND status = 'approved' AND decided_at > now() - interval '30 days'`, [deviceId]),
      db().query<{ n: string }>(
        `SELECT count(*) AS n FROM season_points_log
          WHERE device_id = $1 AND event = 'loud' AND created_at > now() - interval '30 days'`, [deviceId]),
    ]);
    clearedIn30d = Number(posts.rows[0].n);
    weeklyWinIn30d = Number(wins.rows[0].n) > 0;
  }
  return { clearedIn30d, weeklyWinIn30d, multiplier: loudMultiplierOf(clearedIn30d, weeklyWinIn30d) };
}

export interface LoudWinner { handle: string; week: string }

/** The most recent weekly Loudest Callers picks, newest first, one entry per
 *  person — the feed's public proof that the program is real and pays real
 *  people. Handle resolution mirrors the profile's: the linked X account
 *  first, the chosen display handle as fallback; a winner with neither is
 *  skipped rather than shown as a device id. */
export async function loudWinners(limit = 5): Promise<LoudWinner[]> {
  const weekOf = (slug: string | null) => (slug ?? "").replace(/^loud-/, "");
  const out: LoudWinner[] = [];
  const seen = new Set<string>();
  if (!PERSISTENT) {
    for (const r of [...memSeasonLog].reverse()) {
      if (r.event !== "loud" || !r.deviceId) continue;
      const handle = (await linkedXHandleFor(r.deviceId)) ?? memHandle.get(r.deviceId)?.replace(/^@+/, "") ?? null;
      if (!handle || seen.has(handle.toLowerCase())) continue;
      seen.add(handle.toLowerCase());
      out.push({ handle, week: weekOf(r.slug) });
      if (out.length >= limit) break;
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{ handle: string | null; slug: string | null }>(
    `SELECT COALESCE(
        (SELECT a.handle FROM account a
          WHERE a.canonical_device = spl.device_id AND a.provider = 'twitter' AND a.handle IS NOT NULL
          ORDER BY a.created_at LIMIT 1),
        (SELECT b.handle FROM device_balance b WHERE b.device_id = spl.device_id)
      ) AS handle, spl.slug
       FROM season_points_log spl
      WHERE spl.event = 'loud' AND spl.device_id IS NOT NULL
      ORDER BY spl.id DESC LIMIT 40`);
  for (const r of rows) {
    const handle = r.handle?.replace(/^@+/, "");
    if (!handle || seen.has(handle.toLowerCase())) continue;
    seen.add(handle.toLowerCase());
    out.push({ handle, week: weekOf(r.slug) });
    if (out.length >= limit) break;
  }
  return out;
}

/** The two placeCall-driven awards, fired best-effort after a call lands: the
 *  3-distinct-participants milestone and the newcomer's first-ever call. Both
 *  credit the market's surfacer; both are idempotent, so firing on every call is
 *  safe. Never throws — participation must never break placing a call. */
async function awardParticipation(slug: string, deviceId: string, firstEver: boolean, distinct: number): Promise<void> {
  try {
    if (distinct === 3) await awardThreePlayers(slug);
    // The crowd ladder's upper rungs. Same shape as three_players — credited
    // to the surfacer, once per (rung, market) — and equality is safe because
    // `distinct` grows by exactly one when a new player's first call lands.
    const rung = distinct === 10 ? "ten_players" : distinct === 25 ? "twentyfive_players" : distinct === 100 ? "hundred_players" : null;
    if (rung) await awardSeasonPoints(rung, slug, `${rung}:${slug}`);
    if (firstEver) await awardFirstTimer(slug, deviceId);
  } catch { /* best-effort */ }
}

/** A device's Season Points total. Sums rows credited to the device, PLUS any
 *  handle-only rows for the device's linked twitter handles that were logged
 *  before it had an account — so surfacing done pre-signup still counts. */
export async function seasonPointsFor(rawDeviceId: string): Promise<number> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) {
    // The device's handles: its chosen one plus any linked twitter handles — so
    // handle-only rows logged before signup still count (mirrors the SQL below).
    const { _memAccounts } = await import("./accounts.js");
    const handles = new Set<string>();
    const chosen = memHandle.get(deviceId)?.replace(/^@+/, "").toLowerCase();
    if (chosen) handles.add(chosen);
    for (const a of _memAccounts) if (a.provider === "twitter" && a.canonicalDevice === deviceId && a.handle) handles.add(a.handle.replace(/^@+/, "").toLowerCase());
    return memSeasonLog.reduce((sum, r) =>
      sum + (r.deviceId === deviceId || (r.deviceId === null && r.handle !== null && handles.has(r.handle)) ? r.amount : 0), 0);
  }
  await ensureSchema();
  const { rows } = await db().query<{ total: string | null }>(
    `SELECT COALESCE(SUM(amount),0) AS total FROM season_points_log spl
      WHERE spl.device_id = $1
         OR (spl.device_id IS NULL AND spl.handle IN (
              -- Same "@" asymmetry as deviceForTwitterHandle, and the same fix:
              -- season_points_log.handle is written already stripped and lowered
              -- (see recordSurfacer), so an unstripped "@handle" from account
              -- could never match it, and points attributed by handle to an
              -- X-linked user were silently never credited to them.
              SELECT lower(ltrim(handle,'@')) FROM account WHERE provider='twitter' AND canonical_device=$1 AND handle IS NOT NULL
              UNION SELECT lower(ltrim(handle,'@')) FROM device_balance WHERE device_id=$1 AND handle IS NOT NULL))`,
    [deviceId]);
  return Number(rows[0]?.total ?? 0);
}

export interface SeasonPointsRow { deviceId: string | null; handle: string | null; event: string; amount: number; slug: string | null; createdAt: string }
/** The audit trail, newest first — for tuning the values against real behaviour. */
export async function seasonPointsLog(limit = 100): Promise<SeasonPointsRow[]> {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  if (!PERSISTENT) {
    return [...memSeasonLog].reverse().slice(0, n).map((r) => ({ deviceId: r.deviceId, handle: r.handle, event: r.event, amount: r.amount, slug: r.slug, createdAt: r.createdAt }));
  }
  await ensureSchema();
  const { rows } = await db().query<{ device_id: string | null; handle: string | null; event: string; amount: number; slug: string | null; created_at: Date }>(
    `SELECT device_id, handle, event, amount, slug, created_at FROM season_points_log ORDER BY id DESC LIMIT $1`, [n]);
  return rows.map((r) => ({ deviceId: r.device_id, handle: r.handle, event: r.event, amount: r.amount, slug: r.slug, createdAt: r.created_at.toISOString() }));
}

/* --------------------------------------------------------- users view -------
 * One row per device the product has ever touched, with everything an operator
 * needs to see who's here and what they've done. Admin-only, small-volume — it
 * calls accuracyFor / seasonPointsFor per device rather than hand-rolling one
 * giant join, trading a few extra reads for correctness and reuse.
 */
export interface UserActivity {
  deviceId: string;
  handle: string | null;      // twitter-linked handle if any, else the chosen one, else null
  linked: boolean;            // the handle came from a linked twitter account
  firstSeen: string;          // ISO — created_at (persistent) or first call (mem)
  tokens: number;             // current Oddie Points balance
  totalCalls: number;         // positions ever taken
  resolved: number;
  accuracyPct: number | null;
  oddieScore: number | null;
  surfaced: number;           // markets this user surfaced (market_surfacer)
  seasonPoints: number;       // backend contribution total
  founding: boolean;
  isTest: boolean;            // a known test/probe device, not real traffic
  lastActivity: string;       // ISO — last call, else firstSeen (the sort key)
}

// Known test/probe devices that live in the PROD database — kept in sync with
// scripts/cleanup-test-rows.ts, plus the probe families deploys create. Used
// only to CLASSIFY rows in the admin users view (never to delete): worst case a
// device is filtered out of the default "real users" list but still counted in
// the total and visible under "show all". Real device ids are UUIDs or random
// strings, so these literal/prefix matches can't collide with a genuine user.
const KNOWN_TEST_DEVICE_IDS = new Set<string>([
  "ed238db0-a84c-491b-ab2e-273c585e929a", // poppin.so-origin session
  "ddb3938c-8243-46cf-abe7-7aef4b0e416e", // paper-trading session, production
  "6292e497-81e2-4241-9654-c534dc696f66", // analytics session, production
  "race-test-device-0001",
  "deploy-probe-0001", "deploy-probe-0002", "deploy-probe-0003",
  "rewrite-probe-01", "rewrite-probe-02",
]);
const TEST_DEVICE_PATTERN = /^(deploy-probe-|rewrite-probe-|race-test-|test-device-)/i;
export function isTestDevice(deviceId: string): boolean {
  return KNOWN_TEST_DEVICE_IDS.has(deviceId) || TEST_DEVICE_PATTERN.test(deviceId);
}

export async function usersActivity(): Promise<UserActivity[]> {
  interface Base { deviceId: string; createdAt: string; tokens: number; chosen: string | null; totalCalls: number; lastAt: string | null }
  let base: Base[];
  const twMap = new Map<string, string>(); // device -> linked twitter handle (lowercased, no @)
  let surfacers: { deviceId: string | null; handle: string | null }[];

  if (!PERSISTENT) {
    const devices = new Set<string>([...memBalance.keys(), ...memCalls.map((c) => c.deviceId)]);
    base = [...devices].map((deviceId) => {
      const times = memCalls.filter((c) => c.deviceId === deviceId).map((c) => c.at).sort();
      return {
        deviceId,
        createdAt: times[0] ?? new Date().toISOString(), // mem has no signup row; first call stands in
        tokens: memBalance.get(deviceId)?.tokens ?? STARTING_PREDICTIONS,
        chosen: memHandle.get(deviceId) ?? null,
        totalCalls: times.length,
        lastAt: times.length ? times[times.length - 1] : null,
      };
    });
    const { _memAccounts } = await import("./accounts.js");
    for (const a of _memAccounts) if (a.provider === "twitter" && a.handle) twMap.set(a.canonicalDevice, a.handle.replace(/^@+/, "").toLowerCase());
    surfacers = [...memSurfacer.values()].map((s) => ({ deviceId: s.deviceId, handle: s.handle }));
  } else {
    await ensureSchema();
    const { rows } = await db().query<{ device_id: string; created_at: Date; tokens: number; chosen: string | null; total_calls: string; last_at: Date | null }>(
      `SELECT db.device_id, db.created_at, db.tokens, db.handle AS chosen,
              COALESCE(cc.n, 0) AS total_calls, cc.last_at
         FROM device_balance db
         LEFT JOIN (SELECT device_id, count(*) n, max(at) last_at
                      FROM market_call WHERE device_id IS NOT NULL GROUP BY device_id) cc
           ON cc.device_id = db.device_id`);
    base = rows.map((r) => ({
      deviceId: r.device_id, createdAt: r.created_at.toISOString(), tokens: r.tokens, chosen: r.chosen,
      totalCalls: Number(r.total_calls), lastAt: r.last_at ? r.last_at.toISOString() : null,
    }));
    const tw = await db().query<{ canonical_device: string; handle: string }>(
      `SELECT canonical_device, handle FROM account WHERE provider='twitter' AND handle IS NOT NULL`);
    for (const a of tw.rows) twMap.set(a.canonical_device, a.handle.replace(/^@+/, "").toLowerCase());
    const sf = await db().query<{ device_id: string | null; handle: string | null }>(`SELECT device_id, handle FROM market_surfacer`);
    surfacers = sf.rows.map((s) => ({ deviceId: s.device_id, handle: s.handle }));
  }

  // Founding = the first FOUNDING_MAX_RANK devices by created_at (same rule as isFounding).
  const founding = new Set([...base].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)).slice(0, FOUNDING_MAX_RANK).map((b) => b.deviceId));

  const out: UserActivity[] = [];
  for (const b of base) {
    const tw = twMap.get(b.deviceId) ?? null;
    const [acc, sp] = await Promise.all([accuracyFor(b.deviceId), seasonPointsFor(b.deviceId)]);
    const surfaced = surfacers.filter((s) => s.deviceId === b.deviceId || (s.deviceId == null && tw != null && s.handle === tw)).length;
    out.push({
      deviceId: b.deviceId, handle: tw ?? b.chosen ?? null, linked: tw != null, firstSeen: b.createdAt,
      tokens: b.tokens, totalCalls: b.totalCalls, resolved: acc.resolved, accuracyPct: acc.accuracyPct,
      oddieScore: acc.oddieScore, surfaced, seasonPoints: sp, founding: founding.has(b.deviceId),
      isTest: isTestDevice(b.deviceId),
      lastActivity: b.lastAt ?? b.createdAt,
    });
  }
  out.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : 0)); // most recent first
  return out;
}

/** Append one extraction-engine event for later prompt tuning. `kind` is
 *  'extract' (what the engine returned for a pasted argument) or 'publish' (the
 *  operator's final, possibly-edited values at create time). Best-effort: a log
 *  failure must never block extraction or market creation. */
const memExtractionLog: { kind: string; input: string; output: unknown; createdAt: string }[] = [];
export async function logExtraction(kind: "extract" | "match" | "publish", input: string, output: unknown): Promise<void> {
  try {
    if (!PERSISTENT) {
      memExtractionLog.push({ kind, input, output, createdAt: new Date().toISOString() });
      return;
    }
    await ensureSchema();
    await db().query(`INSERT INTO extraction_log (kind, input, output) VALUES ($1,$2,$3)`, [
      kind, input, JSON.stringify(output),
    ]);
  } catch (e) {
    console.error("[extract-log] write failed (non-fatal):", (e as Error).message);
  }
}

// --- Tweet mode: generated-reply log ----------------------------------------
export interface TweetReplyLogEntry {
  sourceUrl: string | null;
  marketId: string | null;
  matchType: "venue" | "closest" | "new";
  slug: string | null;
  permalink: string | null;
  replyText: string;
}
export interface TweetReplyLogItem extends TweetReplyLogEntry {
  id: number;
  createdAt: string;
}
const memTweetLog: TweetReplyLogItem[] = [];
let memTweetId = 0;

/** Record one generated reply. Returns the stored row so the caller can echo the
 *  id/timestamp. Best-effort — a log failure must not fail reply generation. */
export async function logTweetReply(entry: TweetReplyLogEntry): Promise<TweetReplyLogItem | null> {
  const createdAt = new Date().toISOString();
  try {
    if (!PERSISTENT) {
      const row = { ...entry, id: ++memTweetId, createdAt };
      memTweetLog.unshift(row);
      return row;
    }
    await ensureSchema();
    const { rows } = await db().query<{ id: string; created_at: Date }>(
      `INSERT INTO tweet_reply_log (source_url, market_id, match_type, slug, permalink, reply_text)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [entry.sourceUrl, entry.marketId, entry.matchType, entry.slug, entry.permalink, entry.replyText],
    );
    return { ...entry, id: Number(rows[0].id), createdAt: rows[0].created_at.toISOString() };
  } catch (e) {
    console.error("[tweet-log] write failed (non-fatal):", (e as Error).message);
    return null;
  }
}

/** Recent generated replies, newest first — the /tool list view. */
export async function listTweetReplies(limit = 50): Promise<TweetReplyLogItem[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  if (!PERSISTENT) return memTweetLog.slice(0, n);
  await ensureSchema();
  const { rows } = await db().query<{
    id: string; source_url: string | null; market_id: string | null; match_type: string;
    slug: string | null; permalink: string | null; reply_text: string; created_at: Date;
  }>(`SELECT id, source_url, market_id, match_type, slug, permalink, reply_text, created_at
        FROM tweet_reply_log ORDER BY id DESC LIMIT $1`, [n]);
  return rows.map((r) => ({
    id: Number(r.id), sourceUrl: r.source_url, marketId: r.market_id,
    matchType: r.match_type as TweetReplyLogEntry["matchType"], slug: r.slug,
    permalink: r.permalink, replyText: r.reply_text, createdAt: r.created_at.toISOString(),
  }));
}

// --- Internal wedge metrics -------------------------------------------------
// Read-only instrumentation over the data we already log. Small data, internal
// tool → fetch the raw rows and compute in JS rather than six bespoke queries.

interface MemView { slug: string; deviceId: string | null; at: number }
const memPageView: MemView[] = [];

/** Log a permalink landing. device_id is resolved so a view joins to the pick
 *  that may follow it (click→pick). Best-effort — never blocks the page. */
export async function logPageView(slug: string, rawDeviceId: string | null): Promise<void> {
  try {
    const deviceId = rawDeviceId ? await resolveDevice(rawDeviceId) : null;
    if (!PERSISTENT) { memPageView.push({ slug, deviceId, at: Date.now() }); return; }
    await ensureSchema();
    await db().query(`INSERT INTO page_view (slug, device_id) VALUES ($1,$2)`, [slug, deviceId]);
  } catch (e) {
    console.error("[pageview] write failed (non-fatal):", (e as Error).message);
  }
}

export interface MetricsSummary {
  generatedAt: string;
  replies: { total: number; uniqueTaggers: number; repeatTaggers: number; repeatTaggerRate: number | null; unattributed: number };
  clickToPick: { views: number; attributableViews: number; converted: number; rate: number | null };
  secondPick: { pickers: number; withSecond: number; rate: number | null; windowMin: number };
  postResolution: { notified: number; returned: number; rate: number | null; windowDays: number };
  matchBreakdown: { venue: number; closest: number; new: number; total: number };
  uncontested: { resolvedCommunity: number; note: string };
}

/** Parse the tagger's handle from a source tweet URL (x.com/<handle>/status/…). */
function taggerHandle(url: string | null): string | null {
  if (!url) return null;
  const m = /(?:x|twitter)\.com\/([^/?#]+)/i.exec(url);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return ["i", "intent", "home", "search", "hashtag", "explore"].includes(h) ? null : h;
}

interface MetricsData {
  replies: { sourceUrl: string | null; matchType: string }[];
  calls: { deviceId: string; slug: string; at: number }[];
  notices: { deviceId: string; at: number }[]; // settlements only
  views: { deviceId: string | null; slug: string; at: number }[];
  resolvedCommunity: number;
}

function computeMetrics(d: MetricsData): MetricsSummary {
  const pct = (num: number, den: number) => (den > 0 ? Math.round((1000 * num) / den) / 10 : null);

  // 1. Repeat tagger: of distinct identifiable taggers, how many had >1 claim processed.
  const perHandle = new Map<string, number>();
  let unattributed = 0;
  for (const r of d.replies) {
    const h = taggerHandle(r.sourceUrl);
    if (!h) { unattributed++; continue; }
    perHandle.set(h, (perHandle.get(h) ?? 0) + 1);
  }
  const uniqueTaggers = perHandle.size;
  const repeatTaggers = [...perHandle.values()].filter((n) => n > 1).length;

  // 2. Click-to-pick: distinct (device,slug) permalink views where that device later called that market.
  const pickSet = new Set(d.calls.map((c) => `${c.deviceId}|${c.slug}`));
  const viewPairs = new Set<string>();
  for (const v of d.views) if (v.deviceId) viewPairs.add(`${v.deviceId}|${v.slug}`);
  let converted = 0;
  for (const key of viewPairs) if (pickSet.has(key)) converted++;

  // 3. Second pick within 30 min: of pickers, how many placed two calls ≤30 min apart.
  const WIN = 30 * 60_000;
  const byDevice = new Map<string, number[]>();
  for (const c of d.calls) { const a = byDevice.get(c.deviceId) ?? []; a.push(c.at); byDevice.set(c.deviceId, a); }
  let withSecond = 0;
  for (const times of byDevice.values()) {
    times.sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] <= WIN) { withSecond++; break; }
  }
  const pickers = byDevice.size;

  // 4. Post-resolution return: of notified devices, how many placed a new call within 7 days after a settle notice.
  const DAYS7 = 7 * 24 * 3_600_000;
  const notifyTimes = new Map<string, number[]>();
  for (const n of d.notices) { const a = notifyTimes.get(n.deviceId) ?? []; a.push(n.at); notifyTimes.set(n.deviceId, a); }
  let returned = 0;
  for (const [dev, times] of notifyTimes) {
    const cs = byDevice.get(dev) ?? [];
    if (times.some((t) => cs.some((ct) => ct > t && ct <= t + DAYS7))) returned++;
  }
  const notified = notifyTimes.size;

  // 5. Match-type breakdown of processed claims (from the reply log).
  const mb = { venue: 0, closest: 0, new: 0 };
  for (const r of d.replies) if (r.matchType === "venue" || r.matchType === "closest" || r.matchType === "new") mb[r.matchType]++;

  return {
    generatedAt: new Date().toISOString(),
    replies: { total: d.replies.length, uniqueTaggers, repeatTaggers, repeatTaggerRate: pct(repeatTaggers, uniqueTaggers), unattributed },
    clickToPick: { views: d.views.length, attributableViews: viewPairs.size, converted, rate: pct(converted, viewPairs.size) },
    secondPick: { pickers, withSecond, rate: pct(withSecond, pickers), windowMin: 30 },
    postResolution: { notified, returned, rate: pct(returned, notified), windowDays: 7 },
    matchBreakdown: { ...mb, total: mb.venue + mb.closest + mb.new },
    // 6. Uncontested resolutions: no dispute/flag mechanism exists yet → N/A by design.
    uncontested: { resolvedCommunity: d.resolvedCommunity, note: "N/A — no dispute/flag mechanism yet" },
  };
}

export async function metricsSummary(): Promise<MetricsSummary> {
  if (!PERSISTENT) {
    const settle = new Set(["settle_win", "settle_loss"]);
    return computeMetrics({
      replies: memTweetLog.map((t) => ({ sourceUrl: t.sourceUrl, matchType: t.matchType })),
      calls: memCalls.filter((c) => c.deviceId).map((c) => ({ deviceId: c.deviceId, slug: c.slug, at: Date.parse(c.at) })),
      notices: memNotices.filter((n) => settle.has(n.kind)).map((n) => ({ deviceId: n.deviceId, at: Date.parse(n.at) })),
      views: memPageView.map((v) => ({ deviceId: v.deviceId, slug: v.slug, at: v.at })),
      resolvedCommunity: [...memCommunity.values()].filter((m) => m.resolvedOutcome).length,
    });
  }
  await ensureSchema();
  // NB: `at` is a reserved SQL keyword — quote the column and alias to `at_ms`.
  const ms = (col: string) => `extract(epoch from "${col}") * 1000`;
  const [replies, calls, notices, views, rc] = await Promise.all([
    db().query<{ source_url: string | null; match_type: string }>(`SELECT source_url, match_type FROM tweet_reply_log`),
    db().query<{ device_id: string; slug: string; at_ms: number }>(`SELECT device_id, slug, ${ms("at")} AS at_ms FROM market_call WHERE device_id IS NOT NULL`),
    db().query<{ device_id: string; at_ms: number }>(`SELECT device_id, ${ms("created_at")} AS at_ms FROM notice WHERE kind IN ('settle_win','settle_loss')`),
    db().query<{ device_id: string | null; slug: string; at_ms: number }>(`SELECT device_id, slug, ${ms("at")} AS at_ms FROM page_view`),
    db().query<{ n: number }>(`SELECT count(*)::int n FROM community_market WHERE resolved_outcome IS NOT NULL`),
  ]);
  return computeMetrics({
    replies: replies.rows.map((r) => ({ sourceUrl: r.source_url, matchType: r.match_type })),
    calls: calls.rows.map((r) => ({ deviceId: r.device_id, slug: r.slug, at: Number(r.at_ms) })),
    notices: notices.rows.map((r) => ({ deviceId: r.device_id, at: Number(r.at_ms) })),
    views: views.rows.map((r) => ({ deviceId: r.device_id, slug: r.slug, at: Number(r.at_ms) })),
    resolvedCommunity: rc.rows[0]?.n ?? 0,
  });
}

/** Record the devnet proof after a successful on-chain mint. */
export async function setCommunityOnchain(slug: string, pubkey: string, sig: string): Promise<void> {
  if (!PERSISTENT) {
    const m = memCommunity.get(slug);
    if (m) { m.onchainPubkey = pubkey; m.onchainSig = sig; }
    return;
  }
  await ensureSchema();
  await db().query(`UPDATE community_market SET onchain_pubkey=$2, onchain_sig=$3 WHERE slug=$1`, [slug, pubkey, sig]);
}

/* ------------------------------------------------------ featured markets -----
 * The home page's "Live right now" slots — an ordered list of admin-picked
 * slugs. The resolution logic (explicit picks, topped up with the most recent
 * active community markets when there are fewer than the page wants to show)
 * lives in server.ts, where the live market data already is; this is just the
 * raw stored list.
 */
let memFeaturedSlugs: string[] = [];
const MAX_FEATURED = 8; // a sane cap — the home page only ever shows 3-4 of these

/** Replace the whole featured list, in the given order. An empty array clears
 *  it (home then falls back entirely to recently-active markets). Dedup'd and
 *  capped so a fat-fingered admin can't feature the whole catalog. */
export async function setFeaturedMarkets(slugs: string[]): Promise<void> {
  const clean = [...new Set(slugs.map((s) => s.trim()).filter(Boolean))].slice(0, MAX_FEATURED);
  if (!PERSISTENT) { memFeaturedSlugs = clean; return; }
  await ensureSchema();
  await db().query(`DELETE FROM featured_markets`);
  if (clean.length) {
    const values = clean.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(",");
    const params = clean.flatMap((slug, i) => [slug, i]);
    await db().query(`INSERT INTO featured_markets (slug, rank) VALUES ${values}`, params);
  }
}

/** The raw ordered picks, or [] if none were ever set (or the list was cleared). */
export async function getFeaturedSlugs(): Promise<string[]> {
  if (!PERSISTENT) return memFeaturedSlugs;
  await ensureSchema();
  const { rows } = await db().query<{ slug: string }>(`SELECT slug FROM featured_markets ORDER BY rank ASC`);
  return rows.map((r) => r.slug);
}

/**
 * Parimutuel price from a pool of OPEN stake: the side's share of the total.
 * Same formula the payout side already lives by — winBonus is exactly
 * round(100/entryPct), so a pool-derived entryPct here is a live tote-board
 * number by construction, not a new concept bolted next to the old one.
 *
 * Clamped to 1–99 so a market never goes literally unquotable (sidePctOf
 * treats exactly 0 or 100 as "settled, not a quote") just because only one
 * side has taken a position yet — an early lopsided pool should read as
 * "very likely", not vanish. Null on an empty pool: the caller's job, not
 * this function's, to decide the fallback (the market's stored opening
 * price) — this is pure arithmetic with no opinion about markets that have
 * no stake yet.
 *
 * Pool-agnostic on purpose: takes two numbers, not a currency. The same
 * formula extends cleanly to a real-money pool later (lamports in, lamports
 * out) — nothing here assumes "prediction" as a unit.
 */
export function poolPct(chosenPool: number, oppositePool: number): number | null {
  const total = chosenPool + oppositePool;
  if (total <= 0) return null;
  return Math.max(1, Math.min(99, Math.round((chosenPool / total) * 100)));
}

/**
 * How heavily the opening price is weighted before the crowd outvotes it,
 * expressed in people. Matched to MARKET_FORMING_MIN so the anchor has been
 * fully outweighed at roughly the moment a market stops reading "forming".
 */
export const PRICE_ANCHOR_WEIGHT = 5;

/**
 * A community market's live price, from PEOPLE rather than money.
 *
 * It used to come from staked tokens, which worked while a call cost one and
 * broke the moment calling became free: every call now stakes zero, so the
 * pool is always empty and the price would sit frozen at whatever the market
 * opened on. Counting bodies is the honest replacement — nothing else is being
 * risked, so nothing else is available to weigh.
 *
 * The naive ratio is unusable at the start: the first caller alone would print
 * 100%, and the second would be quoted a price invented by one tap. So the
 * OPENING price is carried as a prior worth PRICE_ANCHOR_WEIGHT people and the
 * crowd moves it from there:
 *
 *     price = (anchor × k + yes) / (k + yes + no)
 *
 * With a 50% open and k=5 that runs 50 → 58 (1 yes) → 63 (7y/3n) → 69 (70y/30n),
 * converging on the crowd's true split while the operator's guess fades out.
 *
 * The known weakness, stated rather than hidden: a price made of opinions
 * herds. In a money market a contrarian is paid to correct it; here the only
 * counterweight is that oddies pay more for being right against the crowd,
 * which is real but not as strong. Venue markets are untouched and keep
 * carrying prices that real money made.
 */
export function crowdPct(anchorPct: number, yesPeople: number, noPeople: number): number {
  const k = PRICE_ANCHOR_WEIGHT;
  const anchor = Math.max(1, Math.min(99, anchorPct)) / 100;
  const p = (anchor * k + Math.max(0, yesPeople)) / (k + Math.max(0, yesPeople) + Math.max(0, noPeople));
  return Math.max(1, Math.min(99, Math.round(p * 100)));
}

/** Open (unresolved) community markets, Market-shaped + meta. Used for the feed
 *  AND to price plays (livePctOf needs the market in the "live" set).
 *
 *  yesPct here is LIVE, not the stored opening price: as predictions land on
 *  one side, its pool grows and poolPct compresses that side's price toward
 *  100 (and its multiplier toward 1×) while the other side's price falls (and
 *  its multiplier grows) — the classic tote-board feel. Only OPEN stake
 *  counts (closed_at IS NULL): a position that already exited, early-sold or
 *  settled, is no longer money at risk and shouldn't move a live price. The
 *  market's stored yes_pct is untouched in the database either way — it
 *  stays the admin's true opening line, and is exactly what this falls back
 *  to for a market nobody has staked into yet. */
export async function openCommunityMarkets(): Promise<CommunityMarket[]> {
  if (!PERSISTENT) {
    const out: CommunityMarket[] = [];
    for (const meta of memCommunity.values()) {
      if (meta.resolvedOutcome || meta.retiredAt) continue;
      const rec = mem.get(meta.slug);
      if (!rec) continue;
      // DISTINCT devices per side, not staked tokens: a free call stakes
      // nothing, so people are the only thing left to count. Open calls only —
      // somebody who closed out has left the market and stopped voting in it.
      const yes = new Set(memCalls.filter((c) => c.slug === meta.slug && c.side === "yes" && !c.closedAt && c.deviceId).map((c) => c.deviceId)).size;
      const no = new Set(memCalls.filter((c) => c.slug === meta.slug && c.side === "no" && !c.closedAt && c.deviceId).map((c) => c.deviceId)).size;
      out.push({
        ...rec.market, yesPct: crowdPct(rec.market.yesPct, yes, no),
        marketId: meta.marketId, category: meta.category, onchainPubkey: meta.onchainPubkey, onchainSig: meta.onchainSig,
        resolutionCriteria: meta.resolutionCriteria, resolvability: meta.resolvability,
        creatorFeeBps: meta.creatorFeeBps ?? CREATOR_FEE_BPS_REAL,
      });
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{
    venue_id: string; question: string; yes_pct: number; closes_at: Date | null; volume_usd: number; venue_url: string;
    market_id: string; category: string; onchain_pubkey: string | null; onchain_sig: string | null;
    resolution_criteria: string | null; resolvability: string | null; creator_fee_bps: number | null;
    yes_pool: number; no_pool: number;
  }>(`
    SELECT s.venue_id, s.question, s.yes_pct, s.closes_at, s.volume_usd, s.venue_url,
           c.market_id, c.category, c.onchain_pubkey, c.onchain_sig, c.resolution_criteria, c.resolvability, c.creator_fee_bps,
           count(DISTINCT mc.device_id) FILTER (WHERE mc.side = 'yes' AND mc.closed_at IS NULL)::int AS yes_pool,
           count(DISTINCT mc.device_id) FILTER (WHERE mc.side = 'no'  AND mc.closed_at IS NULL)::int AS no_pool
      FROM community_market c JOIN market_slug s ON s.slug = c.slug
      LEFT JOIN market_call mc ON mc.slug = c.slug
     WHERE c.resolved_outcome IS NULL AND c.retired_at IS NULL
     GROUP BY s.venue_id, s.question, s.yes_pct, s.closes_at, s.volume_usd, s.venue_url,
              c.market_id, c.category, c.onchain_pubkey, c.onchain_sig, c.resolution_criteria, c.resolvability, c.creator_fee_bps, c.created_at
     ORDER BY c.created_at DESC`);
  return rows.map((r) => ({
    venue: "community", venueId: r.venue_id, question: r.question, yesPct: crowdPct(r.yes_pct, r.yes_pool, r.no_pool),
    closesAt: r.closes_at ? r.closes_at.toISOString() : null, volumeUsd: Number(r.volume_usd),
    venueUrl: r.venue_url, tags: [], marketId: Number(r.market_id), category: r.category,
    onchainPubkey: r.onchain_pubkey, onchainSig: r.onchain_sig,
    resolutionCriteria: r.resolution_criteria, resolvability: r.resolvability,
    creatorFeeBps: r.creator_fee_bps ?? CREATOR_FEE_BPS_REAL,
  }));
}

export interface CommunityListItem {
  slug: string; question: string; yesPct: number;
  resolvedOutcome: "yes" | "no" | null; onchainPubkey: string | null; closesAt: string | null;
  yesTokens: number; noTokens: number; yesPlayers: number; noPlayers: number;
  /** Set when the market was taken off the board. This list is the ADMIN view
   *  and deliberately still returns retired markets, so every caller that
   *  presents markets to the public has to filter on this itself. Missing that
   *  is how a retired market kept being served by the agent API after it had
   *  already left the feed. */
  retiredAt: string | null;
  /** The rate this market is (or will be) minted with, so a public list can
   *  quote the fee it actually charges per market instead of one constant for
   *  the whole response. */
  creatorFeeBps: number;
}

/** Every community market with resolution + on-chain state + pool totals, for the /tool admin panel. */
/**
 * Resolved community markets that were minted on-chain — the search space for
 * "does this wallet have winnings to collect?".
 *
 * This exists because of a deliberate architectural choice we are not going to
 * undo: the server NEVER stores a link between a device and a wallet, so it
 * cannot know who holds an on-chain position and cannot notify them. The only
 * honest way to find a winner's claim is to ask the chain, per market, for the
 * wallet the user just connected. Bounded to the most recent `limit` so that
 * scan stays a fixed number of RPC reads rather than growing with the market
 * table forever.
 */
export async function resolvedOnchainMarkets(limit = 40): Promise<Array<{ slug: string; question: string; onchainPubkey: string; resolvedOutcome: "yes" | "no" }>> {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  if (!PERSISTENT) {
    return [...memCommunity.values()]
      .filter((m) => m.resolvedOutcome && m.onchainPubkey)
      .slice(-n).reverse()
      .map((m) => ({ slug: m.slug, question: mem.get(m.slug)?.market.question ?? m.slug, onchainPubkey: m.onchainPubkey!, resolvedOutcome: m.resolvedOutcome! }));
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; question: string; onchain_pubkey: string; resolved_outcome: "yes" | "no" }>(
    `SELECT c.slug, s.question, c.onchain_pubkey, c.resolved_outcome
       FROM community_market c JOIN market_slug s ON s.slug = c.slug
      WHERE c.resolved_outcome IS NOT NULL AND c.onchain_pubkey IS NOT NULL
      ORDER BY c.market_id DESC LIMIT $1`, [n]);
  return rows.map((r) => ({ slug: r.slug, question: r.question, onchainPubkey: r.onchain_pubkey, resolvedOutcome: r.resolved_outcome }));
}

export async function adminListCommunity(): Promise<CommunityListItem[]> {
  if (!PERSISTENT) {
    return [...memCommunity.values()].map((meta) => {
      const rec = mem.get(meta.slug)!;
      const calls = memCalls.filter((c) => c.slug === meta.slug);
      const tokens = (s: "yes" | "no") => calls.filter((c) => c.side === s).reduce((a, c) => a + c.tokens, 0);
      const players = (s: "yes" | "no") => new Set(calls.filter((c) => c.side === s).map((c) => c.deviceId)).size;
      return {
        slug: meta.slug, question: rec.market.question, yesPct: rec.market.yesPct,
        resolvedOutcome: meta.resolvedOutcome, onchainPubkey: meta.onchainPubkey, closesAt: rec.market.closesAt,
        yesTokens: tokens("yes"), noTokens: tokens("no"), yesPlayers: players("yes"), noPlayers: players("no"),
        retiredAt: meta.retiredAt ?? null, creatorFeeBps: meta.creatorFeeBps ?? CREATOR_FEE_BPS_REAL,
      };
    });
  }
  await ensureSchema();
  const { rows } = await db().query<{
    slug: string; question: string; yes_pct: number; resolved_outcome: "yes" | "no" | null; onchain_pubkey: string | null; closes_at: Date | null; creator_fee_bps: number | null;
    yes_tokens: number; no_tokens: number; yes_players: number; no_players: number; retired_at: Date | null;
  }>(`
    SELECT c.slug, s.question, s.yes_pct, c.resolved_outcome, c.onchain_pubkey, s.closes_at, c.retired_at, c.creator_fee_bps,
           COALESCE(SUM(mc.tokens) FILTER (WHERE mc.side = 'yes'), 0)::int AS yes_tokens,
           COALESCE(SUM(mc.tokens) FILTER (WHERE mc.side = 'no'), 0)::int  AS no_tokens,
           COUNT(DISTINCT mc.device_id) FILTER (WHERE mc.side = 'yes')::int AS yes_players,
           COUNT(DISTINCT mc.device_id) FILTER (WHERE mc.side = 'no')::int  AS no_players
      FROM community_market c JOIN market_slug s ON s.slug = c.slug
      LEFT JOIN market_call mc ON mc.slug = c.slug
     GROUP BY c.slug, s.question, s.yes_pct, c.resolved_outcome, c.onchain_pubkey, s.closes_at, c.retired_at, c.creator_fee_bps, c.created_at
     ORDER BY c.created_at DESC`);
  return rows.map((r) => ({
    slug: r.slug, question: r.question, yesPct: r.yes_pct, resolvedOutcome: r.resolved_outcome,
    onchainPubkey: r.onchain_pubkey, closesAt: r.closes_at ? r.closes_at.toISOString() : null,
    yesTokens: r.yes_tokens, noTokens: r.no_tokens, yesPlayers: r.yes_players, noPlayers: r.no_players,
    retiredAt: r.retired_at ? r.retired_at.toISOString() : null,
    creatorFeeBps: r.creator_fee_bps ?? CREATOR_FEE_BPS_REAL,
  }));
}

export interface CommunityDetailPosition {
  deviceId: string | null; side: "yes" | "no"; tokens: number; entryPct: number | null; closed: boolean; proceeds: number | null;
}
export interface CommunityMarketDetail {
  slug: string; question: string; closesAt: string | null; yesPct: number; marketId: number;
  resolvedOutcome: "yes" | "no" | null; onchainPubkey: string | null; onchainSig: string | null;
  resolutionCriteria: string | null; resolvability: string | null;
  /** The creator fee this market is (or will be) minted with. Never null: a row
   *  written before the column existed reads as the full rate, which is what it
   *  was minted with. */
  creatorFeeBps: number;
  positions: CommunityDetailPosition[];
}

/** Full inside-the-market view for the admin panel: meta + every position. The
 *  server adds handles + payout math on top (it owns handle resolution). */
export async function communityMarketDetail(slug: string): Promise<CommunityMarketDetail | null> {
  if (!PERSISTENT) {
    const meta = memCommunity.get(slug);
    const rec = mem.get(slug);
    if (!meta || !rec) return null;
    const positions = memCalls
      .filter((c) => c.slug === slug)
      .map((c) => ({ deviceId: c.deviceId, side: c.side, tokens: c.tokens, entryPct: c.entryPct, closed: Boolean(c.closedAt), proceeds: c.proceeds }));
    return {
      slug, question: rec.market.question, closesAt: rec.market.closesAt, yesPct: rec.market.yesPct,
      marketId: meta.marketId, resolvedOutcome: meta.resolvedOutcome, onchainPubkey: meta.onchainPubkey, onchainSig: meta.onchainSig,
      resolutionCriteria: meta.resolutionCriteria, resolvability: meta.resolvability,
      creatorFeeBps: meta.creatorFeeBps ?? CREATOR_FEE_BPS_REAL, positions,
    };
  }
  await ensureSchema();
  const meta = await db().query<{ question: string; yes_pct: number; closes_at: Date | null; market_id: string; resolved_outcome: "yes" | "no" | null; onchain_pubkey: string | null; onchain_sig: string | null; resolution_criteria: string | null; resolvability: string | null; creator_fee_bps: number | null }>(`
    SELECT s.question, s.yes_pct, s.closes_at, c.market_id, c.resolved_outcome, c.onchain_pubkey, c.onchain_sig, c.resolution_criteria, c.resolvability, c.creator_fee_bps
      FROM community_market c JOIN market_slug s ON s.slug = c.slug WHERE c.slug = $1`, [slug]);
  if (!meta.rows.length) return null;
  const m = meta.rows[0];
  const pos = await db().query<{ side: "yes" | "no"; tokens: number; device_id: string | null; pct_at: number | null; closed_at: Date | null; proceeds: number | null }>(`
    SELECT side, tokens, device_id, pct_at, closed_at, proceeds FROM market_call WHERE slug = $1 ORDER BY at ASC`, [slug]);
  return {
    slug, question: m.question, closesAt: m.closes_at ? m.closes_at.toISOString() : null, yesPct: m.yes_pct,
    marketId: Number(m.market_id), resolvedOutcome: m.resolved_outcome, onchainPubkey: m.onchain_pubkey, onchainSig: m.onchain_sig,
    resolutionCriteria: m.resolution_criteria, resolvability: m.resolvability,
    creatorFeeBps: m.creator_fee_bps ?? CREATOR_FEE_BPS_REAL,
    positions: pos.rows.map((r) => ({ deviceId: r.device_id, side: r.side, tokens: r.tokens, entryPct: r.pct_at, closed: Boolean(r.closed_at), proceeds: r.proceeds })),
  };
}

/** Mark a community market resolved. Returns false if unknown or already resolved
 *  (so the caller can avoid double-settling). Actual payout is settleMarket. */
export async function markCommunityResolved(slug: string, outcome: "yes" | "no"): Promise<boolean> {
  if (!PERSISTENT) {
    const m = memCommunity.get(slug);
    if (!m || m.resolvedOutcome) return false;
    m.resolvedOutcome = outcome;
    return true;
  }
  await ensureSchema();
  const { rowCount } = await db().query(
    `UPDATE community_market SET resolved_outcome=$2 WHERE slug=$1 AND resolved_outcome IS NULL`,
    [slug, outcome],
  );
  return (rowCount ?? 0) > 0;
}

const MIN_CROWD = 10;

/** "68% of poppers were wrong." — resolution as content. Only when at least
 *  ten poppers called it: below that a percentage is noise in a costume, and
 *  the clause is omitted entirely rather than dressed down. */
function crowdClause(outcome: "yes" | "no", won: boolean, crowd?: CrowdSplit): string {
  const total = (crowd?.yes ?? 0) + (crowd?.no ?? 0);
  if (!crowd || total < MIN_CROWD) return "";
  const rightPct = Math.round((100 * crowd[outcome]) / total);
  if (won) return rightPct >= 100 ? " Every popper saw it coming." : ` ${100 - rightPct}% of poppers were wrong.`;
  return ` ${rightPct}% of poppers called it.`;
}

function noticeBody(question: string, outcome: "yes" | "no", side: "yes" | "no", entryPct: number, proceeds: number, crowd?: CrowdSplit): string {
  const won = side === outcome;
  const odds = Math.max(1, Math.min(99, Math.round(entryPct)));
  // Resolution-as-content: name the call, their odds, the outcome, and the verdict.
  return won
    ? `You called “${question}” at ${odds}% — it resolved ${outcome.toUpperCase()}. You were right. +${proceeds} predictions.${crowdClause(outcome, true, crowd)}`
    : `You called “${question}” at ${odds}% — it resolved ${outcome.toUpperCase()}. You were wrong.${crowdClause(outcome, false, crowd)}`;
}

function pushNoticeMem(deviceId: string, slug: string, question: string, outcome: "yes" | "no", side: "yes" | "no", entryPct: number, proceeds: number, callId: number, crowd?: CrowdSplit): void {
  const won = side === outcome;
  memNotices.unshift({
    id: ++memNoticeId, deviceId, kind: won ? "settle_win" : "settle_loss",
    body: noticeBody(question, outcome, side, entryPct, proceeds, crowd),
    delta: won ? proceeds : null, slug, callId, at: new Date().toISOString(),
    oddsPct: Math.max(1, Math.min(99, Math.round(entryPct))), outcome,
    seenAt: null, count: null,
  });
}

/** Mem-backend counterpart to the pg branch's inline creator-fee crediting in
 *  settleMarket: additive bonus off the total pool, paid to the market's
 *  surfacer/creator, logged for audit. A no-op if the fee rounds to 0 tokens
 *  or the market has no identifiable creator — see economy.ts's doc comment
 *  on why this is a grant, never a deduction from anyone's payout. */
async function creditCreatorFeePlayMem(slug: string, question: string, totalPoolTokens: number): Promise<void> {
  const feeAmount = creatorFeePlay(totalPoolTokens);
  if (feeAmount <= 0) return;
  const surfacer = await surfacerFor(slug);
  // Same re-resolution as the pg branch: the tagger usually has no account when
  // the market is recorded, so a null device here is the common case and not a
  // reason to skip the fee. Kept in step deliberately — this is the branch the
  // test suite exercises.
  const payee = surfacer?.deviceId
    ?? (surfacer?.handle ? await deviceForTwitterHandle(surfacer.handle).catch(() => null) : null);
  if (!payee) return;
  const w = memBalance.get(payee) ?? { tokens: STARTING_PREDICTIONS, toppedUpAt: Date.now() };
  memBalance.set(payee, { ...w, tokens: w.tokens + feeAmount });
  memNotices.unshift({
    id: ++memNoticeId, deviceId: payee, kind: "creator_fee",
    body: `You earned ${feeAmount} prediction${feeAmount === 1 ? "" : "s"} — creator fee for "${question}" resolving.`,
    delta: feeAmount, slug, callId: null, at: new Date().toISOString(),
    oddsPct: null, outcome: null, seenAt: null, count: null,
  });
  await logFee({
    slug, marketKind: "play", feeKind: "creator",
    // The device actually credited, which is the re-resolved one — the audit log
    // must name who was paid, not what the surfacer row happened to hold.
    recipientDeviceId: payee, recipientHandle: surfacer?.handle ?? null,
    rateBps: CREATOR_FEE_BPS_PLAY, basisAmount: totalPoolTokens, feeAmount, enforced: true,
  });
}

/** Linked X handle wins over the chosen one — same convention as leaderboard()/
 *  callersFor(). Null means genuinely anonymous (no linked account, never chose
 *  one): callers must show that as "anonymous caller", never as this device's
 *  random stub handle — ensureHandle()'s mint is an internal identifier, not a
 *  real identity to name someone by in a social notification. */
async function displayHandleFor(deviceId: string): Promise<string | null> {
  if (!PERSISTENT) {
    const { _memAccounts } = await import("./accounts.js");
    const tw = _memAccounts.find((a) => a.provider === "twitter" && a.canonicalDevice === deviceId && a.handle);
    return tw?.handle ? tw.handle.replace(/^@+/, "") : (memHandle.get(deviceId) ?? null);
  }
  await ensureSchema();
  // FROM a literal one-row subquery, not device_balance directly — this must
  // return a real answer even for a device with no device_balance row yet
  // (a LEFT JOIN off device_balance would return zero rows instead of null).
  const { rows } = await db().query<{ handle: string | null }>(
    `SELECT COALESCE(tw.handle, db.handle) AS handle
       FROM (SELECT $1::text AS device_id) d
       LEFT JOIN device_balance db ON db.device_id = d.device_id
       LEFT JOIN LATERAL (
         SELECT a.handle FROM account a
          WHERE a.canonical_device = d.device_id AND a.provider = 'twitter' AND a.handle IS NOT NULL
          ORDER BY a.created_at LIMIT 1
       ) tw ON true`,
    [deviceId],
  );
  return rows[0]?.handle ? rows[0].handle.replace(/^@+/, "") : null;
}

const OPPOSITE_SIDE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * "Someone took the other side" — fired best-effort after placeCall lands, for
 * every OTHER device holding an open position on the OPPOSITE side of the same
 * market. Rate-limited to one notice per (holder, market) per rolling 24h: a
 * repeat inside that window UPDATES the existing row into a batched count
 * ("3 people took the other side today") instead of inserting a second one, so
 * an active market cannot spam a position-holder. Never throws — this must
 * never break placing a call.
 */
export async function notifyOppositeSide(slug: string, question: string, callerDeviceId: string, callerSide: "yes" | "no"): Promise<void> {
  try {
    const holderSide: "yes" | "no" = callerSide === "yes" ? "no" : "yes";
    let holders: string[];
    if (!PERSISTENT) {
      holders = [...new Set(
        memCalls
          .filter((c) => c.slug === slug && !c.closedAt && c.side === holderSide && c.deviceId && c.deviceId !== callerDeviceId)
          .map((c) => c.deviceId),
      )];
    } else {
      await ensureSchema();
      const { rows } = await db().query<{ device_id: string }>(
        `SELECT DISTINCT device_id FROM market_call
          WHERE slug = $1 AND closed_at IS NULL AND side = $2 AND device_id IS NOT NULL AND device_id != $3`,
        [slug, holderSide, callerDeviceId],
      );
      holders = rows.map((r) => r.device_id);
    }
    if (!holders.length) return;

    const callerHandle = await displayHandleFor(callerDeviceId);
    const firstBody = callerHandle
      ? `@${callerHandle} just called ${callerSide.toUpperCase()} on "${question}" — you're on ${holderSide.toUpperCase()}.`
      : `anonymous caller just called ${callerSide.toUpperCase()} on "${question}" — you're on ${holderSide.toUpperCase()}.`;

    for (const holderDeviceId of holders) {
      if (!PERSISTENT) {
        const cutoff = Date.now() - OPPOSITE_SIDE_WINDOW_MS;
        const existing = memNotices.find((n) =>
          n.deviceId === holderDeviceId && n.slug === slug && n.kind === "opposite_side" && Date.parse(n.at) >= cutoff);
        if (existing) {
          const count = (existing.count ?? 1) + 1;
          existing.count = count;
          existing.body = `${count} people took the other side of "${question}" today — you're on ${holderSide.toUpperCase()}.`;
          existing.at = new Date().toISOString();
        } else {
          memNotices.unshift({
            id: ++memNoticeId, deviceId: holderDeviceId, kind: "opposite_side", body: firstBody,
            delta: null, slug, callId: null, at: new Date().toISOString(),
            oddsPct: null, outcome: null, seenAt: null, count: 1,
          });
        }
      } else {
        await ensureSchema();
        const { rows } = await db().query<{ id: number; count: number | null }>(
          `SELECT id, count FROM notice
            WHERE device_id = $1 AND slug = $2 AND kind = 'opposite_side' AND created_at >= now() - interval '24 hours'
            ORDER BY created_at DESC LIMIT 1`,
          [holderDeviceId, slug],
        );
        const existing = rows[0];
        if (existing) {
          const count = (existing.count ?? 1) + 1;
          const body = `${count} people took the other side of "${question}" today — you're on ${holderSide.toUpperCase()}.`;
          await db().query(`UPDATE notice SET body = $1, count = $2, created_at = now() WHERE id = $3`, [body, count, existing.id]);
        } else {
          await db().query(
            `INSERT INTO notice (device_id, kind, body, slug, count) VALUES ($1,'opposite_side',$2,$3,1)`,
            [holderDeviceId, firstBody, slug],
          );
        }
      }
    }
  } catch (err) {
    console.error("[notify] opposite-side failed:", (err as Error).message);
  }
}

const CLOSING_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many hours to say in "closes in {H}h" — never 0 (a market a few minutes
 *  out should still read as "closes in 1h", not "closes in 0h"). */
const hoursUntil = (closesAtMs: number, nowMs: number): number => Math.max(1, Math.round((closesAtMs - nowMs) / 3_600_000));

/**
 * "Your market closes soon" — a periodic sweep (called from server.ts on the
 * same interval-timer pattern as sweepSettlements), not a per-call hook: this
 * fires on the PASSAGE OF TIME, not on an event. For every open market closing
 * within the next 24h, every device holding an open position on it gets
 * exactly ONE notice, ever — no rolling window, no batching, because a market
 * only crosses the "24h out" line once. Returns how many notices it sent, for
 * the sweep's own logging.
 */
export async function notifyClosingSoon(): Promise<number> {
  const now = Date.now();
  let sent = 0;

  if (!PERSISTENT) {
    const openSlugsList = [...new Set(memCalls.filter((c) => !c.closedAt).map((c) => c.slug))];
    for (const slug of openSlugsList) {
      const rec = mem.get(slug);
      const closesAt = rec?.market.closesAt;
      if (!closesAt) continue;
      const closesAtMs = new Date(closesAt).getTime();
      if (!(closesAtMs > now && closesAtMs <= now + CLOSING_SOON_WINDOW_MS)) continue;
      const holders = new Set(
        memCalls.filter((c) => c.slug === slug && !c.closedAt && c.deviceId).map((c) => c.deviceId),
      );
      const body = `"${rec!.market.question}" closes in ${hoursUntil(closesAtMs, now)}h — resolution coming.`;
      for (const deviceId of holders) {
        const already = memNotices.some((n) => n.deviceId === deviceId && n.slug === slug && n.kind === "closing_soon");
        if (already) continue;
        memNotices.unshift({
          id: ++memNoticeId, deviceId, kind: "closing_soon", body,
          delta: null, slug, callId: null, at: new Date().toISOString(),
          oddsPct: null, outcome: null, seenAt: null, count: null,
        });
        sent++;
      }
    }
    return sent;
  }

  await ensureSchema();
  const { rows: closingMarkets } = await db().query<{ slug: string; question: string; closes_at: Date }>(
    `SELECT DISTINCT s.slug, s.question, s.closes_at
       FROM market_slug s
       JOIN market_call mc ON mc.slug = s.slug AND mc.closed_at IS NULL
      WHERE s.closes_at IS NOT NULL AND s.closes_at > now() AND s.closes_at <= now() + interval '24 hours'`,
  );
  for (const m of closingMarkets) {
    const body = `"${m.question}" closes in ${hoursUntil(m.closes_at.getTime(), now)}h — resolution coming.`;
    // The LEFT JOIN ... WHERE n.id IS NULL is the "not yet notified" filter in
    // one query — holders of an open position on this slug with no existing
    // closing_soon row for them.
    const { rows: unnotified } = await db().query<{ device_id: string }>(
      `SELECT DISTINCT mc.device_id
         FROM market_call mc
         LEFT JOIN notice n ON n.device_id = mc.device_id AND n.slug = mc.slug AND n.kind = 'closing_soon'
        WHERE mc.slug = $1 AND mc.closed_at IS NULL AND mc.device_id IS NOT NULL AND n.id IS NULL`,
      [m.slug],
    );
    if (!unnotified.length) continue;
    const values = unnotified.map((_, i) => `($${i * 3 + 1},'closing_soon',$${i * 3 + 2},$${i * 3 + 3})`).join(",");
    const params = unnotified.flatMap((r) => [r.device_id, body, m.slug]);
    await db().query(`INSERT INTO notice (device_id, kind, body, slug) VALUES ${values}`, params);
    sent += unnotified.length;
  }
  return sent;
}

export interface OpenCallsSummary {
  count: number;
  /** The earliest closesAt among the device's open positions with a known
   *  close time, or null if it has none (venue markets sometimes don't). */
  nextCloseAt: string | null;
}

/** The home page's "Zeigarnik hook" — how many open calls this device has, and
 *  when the soonest one resolves. One aggregate query; the client hides the
 *  whole row when count is 0, so this never fabricates a reason to come back. */
export async function openCallsSummaryFor(rawDeviceId: string): Promise<OpenCallsSummary> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) {
    const open = memCalls.filter((c) => c.deviceId === deviceId && !c.closedAt);
    if (!open.length) return { count: 0, nextCloseAt: null };
    const closeTimes = open
      .map((c) => mem.get(c.slug)?.market.closesAt)
      .filter((x): x is string => Boolean(x));
    const nextCloseAt = closeTimes.length ? closeTimes.reduce((a, b) => (a < b ? a : b)) : null;
    return { count: open.length, nextCloseAt };
  }
  await ensureSchema();
  const { rows } = await db().query<{ n: string; next_close: Date | null }>(
    `SELECT count(*)::text AS n, min(s.closes_at) AS next_close
       FROM market_call mc JOIN market_slug s ON s.slug = mc.slug
      WHERE mc.device_id = $1 AND mc.closed_at IS NULL`,
    [deviceId],
  );
  const count = Number(rows[0]?.n ?? 0);
  return { count, nextCloseAt: count && rows[0]?.next_close ? rows[0].next_close.toISOString() : null };
}

/* ------------------------------------------------------------------- crowd --
 * What the POPPERS said, per market: distinct devices per side, from the same
 * market_call rows everything else reads. This is the whole social layer —
 * no graph, no profiles, just "other people exist and they took sides".
 */

export interface CrowdSplit { yes: number; no: number }

export async function crowdSplits(slugs: string[]): Promise<Record<string, CrowdSplit>> {
  const out: Record<string, CrowdSplit> = {};
  if (slugs.length === 0) return out;
  if (!PERSISTENT) {
    for (const slug of slugs) {
      const yes = new Set<string>(), no = new Set<string>();
      for (const c of memCalls) if (c.slug === slug) (c.side === "yes" ? yes : no).add(c.deviceId);
      if (yes.size || no.size) out[slug] = { yes: yes.size, no: no.size };
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; side: "yes" | "no"; n: number }>(
    `SELECT slug, side, count(DISTINCT device_id)::int n FROM market_call
      WHERE slug = ANY($1) AND device_id IS NOT NULL GROUP BY slug, side`,
    [slugs],
  );
  for (const r of rows) {
    out[r.slug] ??= { yes: 0, no: 0 };
    out[r.slug][r.side] = r.n;
  }
  return out;
}

// A new community market shows "market forming" (a call count, not a %) until
// this many DISTINCT players have taken a position — below it, a percentage is
// noise the first few callers could skew. Distinct devices, so one user can't
// cross the line alone.
export const MARKET_FORMING_MIN = 5;

/** Distinct-player count per slug (across both sides), for the forming gate. */
/**
 * Predictions actually staked on each market — the honest analogue of an
 * exchange's "volume" for a play-token pool.
 *
 * Distinct from communityPlayerCounts below, which counts PEOPLE. The two
 * diverge as soon as anyone takes more than one position, and a card that
 * shows only headcount understates a market a handful of people are trading
 * repeatedly. Counts OPEN calls only: a sold position has left the pool, so
 * including it would report money that isn't there any more.
 *
 * Deliberately not called "volume" in dollars anywhere. These markets settle
 * in predictions, and dressing that up as currency would be the one thing on
 * the card that isn't true.
 */
export async function communityPoolSizes(slugs: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (slugs.length === 0) return out;
  if (!PERSISTENT) {
    for (const slug of slugs) {
      out[slug] = memCalls
        .filter((c) => c.slug === slug && !c.closedAt)
        .reduce((a, c) => a + c.tokens, 0);
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; n: number }>(
    `SELECT slug, COALESCE(SUM(tokens),0)::int n FROM market_call
      WHERE slug = ANY($1) AND closed_at IS NULL GROUP BY slug`,
    [slugs],
  );
  for (const r of rows) out[r.slug] = r.n;
  for (const s of slugs) out[s] ??= 0;
  return out;
}

/**
 * Calls placed on each market in the last `hours` — the "is this happening
 * NOW" signal a live feed needs and a static list doesn't have.
 *
 * Pool size and caller count both say how big a market got; neither says
 * whether it got there this morning or three weeks ago. A market with six
 * calls in the last day and one with six calls since launch read identically
 * on the card today, which is exactly the difference between a feed and a
 * directory.
 *
 * Counts calls by when they were PLACED, including ones since sold — the
 * question is how much attention the market is getting, not what's still
 * open. Zero (not absent) for a quiet market, so callers can treat it as a
 * number without a null check.
 */
export async function communityRecentCalls(slugs: string[], hours = 24): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (slugs.length === 0) return out;
  const since = Date.now() - Math.max(1, hours) * 3_600_000;
  if (!PERSISTENT) {
    for (const slug of slugs) {
      out[slug] = memCalls.filter((c) => c.slug === slug && Date.parse(c.at) >= since).length;
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; n: number }>(
    `SELECT slug, count(*)::int n FROM market_call
      WHERE slug = ANY($1) AND at >= now() - make_interval(hours => $2)
      GROUP BY slug`,
    [slugs, Math.max(1, Math.floor(hours))],
  );
  for (const r of rows) out[r.slug] = r.n;
  for (const s of slugs) out[s] ??= 0;
  return out;
}

export async function communityPlayerCounts(slugs: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (slugs.length === 0) return out;
  if (!PERSISTENT) {
    for (const slug of slugs) {
      const devices = new Set<string>();
      for (const c of memCalls) if (c.slug === slug && c.deviceId) devices.add(c.deviceId);
      out[slug] = devices.size;
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; n: number }>(
    `SELECT slug, count(DISTINCT device_id)::int n FROM market_call
      WHERE slug = ANY($1) AND device_id IS NOT NULL GROUP BY slug`,
    [slugs],
  );
  for (const r of rows) out[r.slug] = r.n;
  for (const s of slugs) out[s] ??= 0;
  return out;
}

/* ------------------------------------------------------------- share card --
 * A personal call card: "@handle called YES at 38%". Shareable only through a
 * token the OWNER minted — random, unique, never the sequential id — so the
 * set of shared calls is exactly the set of calls people chose to share.
 */

export interface ShareCall {
  token: string;
  slug: string;
  question: string;
  side: "yes" | "no";
  entryPct: number;
  volumeUsd: number;
  /** The market's venue — so the personal card can tell a real venue dollar
   *  figure apart from a community market, which never has one. */
  venue: Market["venue"];
  closesAt: string | null;
  /** null while open; the resolved side once settled at 100/0, or "sold". */
  resolved: "yes" | "no" | "sold" | null;
  handle: string;
}

const newToken = () => createHash("sha1").update(`${Math.random()}:${Date.now()}:${Math.random()}`).digest("base64url").slice(0, 12);

/** Mint (or return) the share token for a call. Owner only. */
export async function mintShareToken(callId: number, rawDeviceId: string): Promise<{ ok: true; token: string; slug: string } | { ok: false }> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) {
    const c = memCalls.find((x) => x.id === callId && x.deviceId === deviceId);
    if (!c) return { ok: false };
    c.shareToken ??= newToken();
    return { ok: true, token: c.shareToken, slug: c.slug };
  }
  await ensureSchema();
  const cur = await db().query<{ share_token: string | null; slug: string }>(
    `SELECT share_token, slug FROM market_call WHERE id = $1 AND device_id = $2`, [callId, deviceId]);
  if (cur.rows.length === 0) return { ok: false };
  if (cur.rows[0].share_token) return { ok: true, token: cur.rows[0].share_token, slug: cur.rows[0].slug };
  for (let i = 0; i < 6; i++) {
    try {
      const t = newToken();
      const upd = await db().query<{ share_token: string }>(
        `UPDATE market_call SET share_token = $1 WHERE id = $2 AND share_token IS NULL RETURNING share_token`, [t, callId]);
      if (upd.rows.length === 1) return { ok: true, token: upd.rows[0].share_token, slug: cur.rows[0].slug };
      const again = await db().query<{ share_token: string | null }>(`SELECT share_token FROM market_call WHERE id = $1`, [callId]);
      if (again.rows[0]?.share_token) return { ok: true, token: again.rows[0].share_token, slug: cur.rows[0].slug };
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
    }
  }
  return { ok: false };
}

/** Everything the personal card needs, by token. Null = no such share. */
export async function getShareCall(token: string): Promise<ShareCall | null> {
  if (!token || token.length > 24) return null;
  if (!PERSISTENT) {
    const c = memCalls.find((x) => x.shareToken === token);
    if (!c) return null;
    const rec = mem.get(c.slug);
    return {
      token, slug: c.slug, question: c.question, side: c.side, entryPct: c.entryPct,
      volumeUsd: rec?.market.volumeUsd ?? 0,
      venue: rec?.market.venue ?? "community", closesAt: rec?.market.closesAt ?? null,
      resolved: c.exitPct === null ? null : c.exitPct === 100 ? c.side : c.exitPct === 0 ? (c.side === "yes" ? "no" : "yes") : "sold",
      handle: (memHandle.get(c.deviceId) ?? `#${c.deviceId.slice(0, 4)}`).replace(/^@+/, ""),
    };
  }
  await ensureSchema();
  const { rows } = await db().query<{
    slug: string; question: string; side: "yes" | "no"; pct_at: number | null; exit_pct: number | null;
    venue: Market["venue"]; closes_at: Date | null;
    volume_usd: number; device_id: string; handle: string | null; acct_handle: string | null;
  }>(
    `SELECT mc.slug, ms.question, mc.side, mc.pct_at, mc.exit_pct, ms.venue, ms.closes_at, ms.volume_usd, mc.device_id,
            db.handle,
            (SELECT a.handle FROM account a WHERE a.canonical_device = mc.device_id AND a.provider = 'twitter'
              AND a.handle IS NOT NULL ORDER BY a.created_at LIMIT 1) AS acct_handle
       FROM market_call mc
       JOIN market_slug ms ON ms.slug = mc.slug
       LEFT JOIN device_balance db ON db.device_id = mc.device_id
      WHERE mc.share_token = $1`, [token]);
  const r = rows[0];
  if (!r || r.pct_at === null) return null;
  return {
    token, slug: r.slug, question: r.question, side: r.side, entryPct: r.pct_at,
    volumeUsd: Number(r.volume_usd),
    venue: r.venue, closesAt: r.closes_at ? r.closes_at.toISOString() : null,
    resolved: r.exit_pct === null ? null : r.exit_pct === 100 ? r.side : r.exit_pct === 0 ? (r.side === "yes" ? "no" : "yes") : "sold",
    handle: (r.acct_handle ?? r.handle ?? `#${(r.device_id ?? "anon").slice(0, 4)}`).replace(/^@+/, ""),
  };
}

/* ---------------------------------------------------- settlement outreach --
 * Reaching people OUTSIDE the app when a position settles: the Google email
 * for the automated channel, and the X-mention worklist for the manual one.
 */

/** device -> verified Google email, for every device in the list that has one. */
export async function emailsFor(deviceIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (deviceIds.length === 0) return out;
  if (!PERSISTENT) {
    const { _memAccounts } = await import("./accounts.js");
    for (const a of _memAccounts) {
      if (a.provider === "google" && a.email && deviceIds.includes(a.canonicalDevice)) out[a.canonicalDevice] = a.email;
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{ canonical_device: string; email: string }>(
    `SELECT DISTINCT ON (canonical_device) canonical_device, email FROM account
      WHERE provider = 'google' AND email IS NOT NULL AND canonical_device = ANY($1)
      ORDER BY canonical_device, created_at`, [deviceIds]);
  for (const r of rows) out[r.canonical_device] = r.email;
  return out;
}

export interface MentionCandidate {
  callId: number;
  handle: string;            // the X handle, @-less
  side: "yes" | "no";
  entryPct: number;
  outcome: "yes" | "no";
  proceeds: number;
  question: string;
  slug: string;
  shareToken: string | null; // minted lazily by the mentions endpoint
  mentionedAt: string | null;
  /** For sent ones: did the device produce ANY event within 24h of the mention? */
  returned24h: boolean | null;
}

/** Settled positions whose owner connected X — the manual-mention worklist. */
export async function mentionCandidates(limit = 30): Promise<MentionCandidate[]> {
  if (!PERSISTENT) return []; // an operator worklist has no in-memory story
  await ensureSchema();
  const { rows } = await db().query<{
    id: number; handle: string; side: "yes" | "no"; pct_at: number; exit_pct: number; proceeds: number;
    question: string; slug: string; share_token: string | null; mentioned_at: Date | null; returned: boolean | null;
  }>(
    `SELECT mc.id, a.handle, mc.side, mc.pct_at, mc.exit_pct, mc.proceeds, ms.question, mc.slug,
            mc.share_token, mc.mentioned_at,
            CASE WHEN mc.mentioned_at IS NULL THEN NULL ELSE EXISTS(
              SELECT 1 FROM event e WHERE e.device_id = mc.device_id
                 AND e.at > mc.mentioned_at AND e.at < mc.mentioned_at + interval '24 hours') END AS returned
       FROM market_call mc
       JOIN market_slug ms ON ms.slug = mc.slug
       JOIN account a ON a.canonical_device = mc.device_id AND a.provider = 'twitter' AND a.handle IS NOT NULL
      WHERE mc.closed_at IS NOT NULL AND mc.exit_pct IN (0, 100) AND mc.pct_at IS NOT NULL
        AND mc.dismissed_at IS NULL
      ORDER BY mc.mentioned_at NULLS FIRST, mc.closed_at DESC
      LIMIT $1`, [limit]);
  return rows.map((r) => ({
    callId: r.id, handle: r.handle.replace(/^@+/, ""), side: r.side, entryPct: r.pct_at,
    outcome: r.exit_pct === 100 ? r.side : r.side === "yes" ? "no" : "yes",
    proceeds: r.proceeds, question: r.question, slug: r.slug, shareToken: r.share_token,
    mentionedAt: r.mentioned_at?.toISOString() ?? null, returned24h: r.returned,
  }));
}

/** Operator marks a mention posted. State-guarded: set once, never re-stamped. */
export async function markMentioned(callId: number): Promise<boolean> {
  if (!PERSISTENT) return false;
  await ensureSchema();
  const { rowCount } = await db().query(
    `UPDATE market_call SET mentioned_at = now() WHERE id = $1 AND mentioned_at IS NULL`, [callId]);
  return rowCount === 1;
}

/** Operator decides NOT to post this one. Guarded against BOTH directions:
 *  a row already mentioned has already had its 24h-return measured against
 *  mentioned_at, and dismissing it afterward would not undo that measurement.
 *  So this refuses to touch a row that already went out, the same way
 *  markMentioned refuses to re-stamp one that already did. */
export async function dismissMention(callId: number): Promise<boolean> {
  if (!PERSISTENT) return false;
  await ensureSchema();
  const { rowCount } = await db().query(
    `UPDATE market_call SET dismissed_at = now() WHERE id = $1 AND mentioned_at IS NULL AND dismissed_at IS NULL`, [callId]);
  return rowCount === 1;
}

/** Mint a share token WITHOUT the owner check — operator path only, for calls
 *  that already belong on the mentions worklist (X-connected, settled). */
export async function mintShareTokenForMention(callId: number): Promise<string | null> {
  if (!PERSISTENT) return null;
  await ensureSchema();
  const cur = await db().query<{ share_token: string | null }>(`SELECT share_token FROM market_call WHERE id = $1`, [callId]);
  if (cur.rows.length === 0) return null;
  if (cur.rows[0].share_token) return cur.rows[0].share_token;
  for (let i = 0; i < 6; i++) {
    try {
      const t = newToken();
      const upd = await db().query<{ share_token: string }>(
        `UPDATE market_call SET share_token = $1 WHERE id = $2 AND share_token IS NULL RETURNING share_token`, [t, callId]);
      if (upd.rows.length === 1) return upd.rows[0].share_token;
      const again = await db().query<{ share_token: string | null }>(`SELECT share_token FROM market_call WHERE id = $1`, [callId]);
      if (again.rows[0]?.share_token) return again.rows[0].share_token;
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
    }
  }
  return null;
}

/* -------------------------------------------------------- curated launch --
 * Oddie's model is viral spread, not a curated launch: anyone who signs in with
 * X or Google gets full access immediately — no allowlist, no waitlist, no "not
 * on the list" screen. The only remaining gate is the free-taste pacing for
 * signed-OUT devices (a couple of free plays, then the sign-in ask), which is
 * about when we ask, not who gets in.
 */

const memAllowlist = new Map<string, { source: string; cohort: string; invitedAt: string | null; acceptedAt: string | null }>();
const memAllowlistX = new Map<string, { source: string; invitedAt: string | null; acceptedAt: string | null; handle: string | null }>();

export type Gate =
  // `allowed` is now always true — there is no rope. identity/provider are null
  // for an anonymous visitor (they can play without signing in) and set once
  // they connect an account, purely so the UI can echo who they are.
  | { allowed: true; email: string | null; identity: string | null; provider: "google" | "twitter" | null; justAccepted: boolean }
  | { allowed: false; reason: "signed_out" | "not_allowlisted"; email: string | null; identity: string | null; provider: "google" | "twitter" | null };

export async function gateFor(rawDeviceId: string): Promise<Gate> {
  const deviceId = await resolveDevice(rawDeviceId);

  if (!PERSISTENT) {
    const { _memAccounts } = await import("./accounts.js");
    const mine = _memAccounts.filter((a) => a.canonicalDevice === deviceId);
    const g = mine.find((a) => a.provider === "google" && a.email);
    const x = mine.find((a) => a.provider === "twitter");
    // Anonymous is full access too — enter and vote, no sign-in, no waitlist.
    if (!g && !x) return { allowed: true, email: null, identity: null, provider: null, justAccepted: false };
    const gEmail = g?.email ?? null;
    // X first for the identity we echo back (the reputation thesis lives on X).
    const identity = x ? (x.handle ?? `@${x.uid}`) : gEmail!;
    const provider = x ? "twitter" as const : "google" as const;
    return { allowed: true, email: gEmail, identity, provider, justAccepted: false };
  }

  await ensureSchema();
  // Every identity this browser's stream is signed in with.
  const accts = await db().query<{ provider: "google" | "twitter"; email: string | null; provider_uid: string; handle: string | null }>(
    `SELECT provider, email, provider_uid, handle FROM account WHERE canonical_device = $1 ORDER BY created_at`, [deviceId]);
  const g = accts.rows.find((a) => a.provider === "google" && a.email);
  const x = accts.rows.find((a) => a.provider === "twitter");
  // Anonymous is full access too — enter and vote, no sign-in, no waitlist.
  if (!g && !x) return { allowed: true, email: null, identity: null, provider: null, justAccepted: false };

  const gEmail = g?.email ?? null;
  const identity = x ? (x.handle ?? `@${x.provider_uid}`) : (gEmail ?? "");
  const provider = x ? "twitter" as const : "google" as const;

  // Oddie is viral, not gated: signing in just attaches an identity/streak that
  // follows you across devices. It was never required to play, and now the
  // anonymous case above says so explicitly — no rope, no waitlist, no taste cap.
  return { allowed: true, email: gEmail, identity, provider, justAccepted: false };
}

export async function addToAllowlist(email: string, source: string, invited: boolean, xUid?: string | null, xHandle?: string | null, cohort = "default"): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false;
  const uid = xUid?.trim() || null;
  const handle = xHandle?.trim().replace(/^@+/, "") || null;
  if (!PERSISTENT) {
    if (!memAllowlist.has(e)) memAllowlist.set(e, { source, cohort, invitedAt: invited ? new Date().toISOString() : null, acceptedAt: null });
    else if (invited && !memAllowlist.get(e)!.invitedAt) memAllowlist.get(e)!.invitedAt = new Date().toISOString();
    if (uid && !memAllowlistX.has(uid)) memAllowlistX.set(uid, { source, invitedAt: invited ? new Date().toISOString() : null, acceptedAt: null, handle });
    return true;
  }
  await ensureSchema();
  try {
    await db().query(
      `INSERT INTO allowlist (email, source, invited_at, x_uid, x_handle, cohort)
       VALUES ($1, $2, CASE WHEN $3 THEN now() END, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET
         invited_at = COALESCE(allowlist.invited_at, EXCLUDED.invited_at),
         x_uid      = COALESCE(allowlist.x_uid, EXCLUDED.x_uid),
         x_handle   = COALESCE(allowlist.x_handle, EXCLUDED.x_handle),
         cohort     = EXCLUDED.cohort`,
      [e, source, invited, uid, handle, cohort]);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return true;
    throw err;
  }
}

export interface AllowRow { email: string; source: string; cohort: string; xHandle: string | null; invitedAt: string | null; acceptedAt: string | null; createdAt: string }
export async function allowlistRows(limit = 400): Promise<AllowRow[]> {
  if (!PERSISTENT) return [...memAllowlist.entries()].map(([email, r]) => ({ email, source: r.source, cohort: r.cohort, xHandle: null, invitedAt: r.invitedAt, acceptedAt: r.acceptedAt, createdAt: "" }));
  await ensureSchema();
  const { rows } = await db().query<{ email: string; source: string; cohort: string; x_handle: string | null; invited_at: Date | null; accepted_at: Date | null; created_at: Date }>(
    `SELECT email, source, cohort, x_handle, invited_at, accepted_at, created_at FROM allowlist ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows.map((r) => ({ email: r.email, source: r.source, cohort: r.cohort, xHandle: r.x_handle, invitedAt: r.invited_at?.toISOString() ?? null, acceptedAt: r.accepted_at?.toISOString() ?? null, createdAt: r.created_at.toISOString() }));
}

/** Map a device to its cohort via canonical account -> allowlist (email or x_uid).
 *  'default' when unmatched. The funnel joins on this to read a wave alone. */
export async function cohortOfDevice(rawDeviceId: string): Promise<string> {
  if (!PERSISTENT) return "default";
  const deviceId = await resolveDevice(rawDeviceId);
  const { rows } = await db().query<{ cohort: string }>(
    `SELECT al.cohort FROM account a
       JOIN allowlist al ON (al.email IS NOT NULL AND lower(al.email)=lower(a.email))
                         OR (al.x_uid IS NOT NULL AND a.provider='twitter' AND al.x_uid=a.provider_uid)
      WHERE a.canonical_device=$1 ORDER BY al.created_at LIMIT 1`, [deviceId]);
  return rows[0]?.cohort ?? "default";
}

/* --------------------------------------------------------------- scoring --
 * Three boards, three virtues: edge (skill), streak (showing up), net
 * winnings (playing AND being right). Raw call count is deliberately not a
 * board — it would crown whoever spams fastest.
 */

/** Consecutive active days (>=1 call placed). Current counts only if the run
 *  reaches today or yesterday — a streak you can still extend. */
export function computeStreak(days: string[], todayISO: string): { current: number; best: number } {
  if (days.length === 0) return { current: 0, best: 0 };
  const set = [...new Set(days)].sort();
  let best = 1, run = 1;
  for (let i = 1; i < set.length; i++) {
    const prev = new Date(set[i - 1] + "T00:00:00Z").getTime();
    const cur = new Date(set[i] + "T00:00:00Z").getTime();
    run = cur - prev === 86_400_000 ? run + 1 : 1;
    if (run > best) best = run;
  }
  const last = set[set.length - 1];
  const today = new Date(todayISO + "T00:00:00Z").getTime();
  const lastMs = new Date(last + "T00:00:00Z").getTime();
  const current = today - lastMs <= 86_400_000 ? run : 0;
  return { current, best };
}

export async function streakFor(rawDeviceId: string): Promise<{ current: number; best: number }> {
  const deviceId = await resolveDevice(rawDeviceId);
  const today = new Date().toISOString().slice(0, 10);
  if (!PERSISTENT) {
    const days = memCalls.filter((c) => c.deviceId === deviceId).map((c) => c.at.slice(0, 10));
    return computeStreak(days, today);
  }
  await ensureSchema();
  const { rows } = await db().query<{ d: string }>(
    `SELECT DISTINCT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') d FROM market_call WHERE device_id = $1`, [deviceId]);
  return computeStreak(rows.map((r) => r.d), today);
}

export interface StreakRow { deviceId: string; handle: string; current: number; best: number }
export interface WinningsRow { deviceId: string; handle: string; net: number; closed: number }

export async function leaderboardStreaks(limit = 20): Promise<StreakRow[]> {
  const today = new Date().toISOString().slice(0, 10);
  let byDev: Map<string, string[]>;
  if (!PERSISTENT) {
    byDev = new Map();
    for (const c of memCalls) byDev.set(c.deviceId, [...(byDev.get(c.deviceId) ?? []), c.at.slice(0, 10)]);
  } else {
    await ensureSchema();
    const { rows } = await db().query<{ device_id: string; days: string[] }>(
      `SELECT device_id, array_agg(DISTINCT to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD')) days
         FROM market_call WHERE device_id IS NOT NULL GROUP BY device_id`);
    byDev = new Map(rows.map((r) => [r.device_id, r.days]));
  }
  const out: StreakRow[] = [];
  for (const [deviceId, days] of byDev) {
    const s = computeStreak(days, today);
    if (s.best > 0) out.push({ deviceId, handle: "", current: s.current, best: s.best });
  }
  out.sort((a, b) => b.current - a.current || b.best - a.best);
  // See excludedLeaderboardDeviceId — filtered BEFORE the slice so a real
  // user just outside `limit` correctly backfills the excluded row's spot,
  // rather than the board quietly returning one row short.
  const excludedId = await excludedLeaderboardDeviceId();
  return withHandles(out.filter((r) => r.deviceId !== excludedId).slice(0, limit));
}

export async function leaderboardWinnings(limit = 20): Promise<WinningsRow[]> {
  let rows: { device_id: string; net: number; closed: number }[];
  if (!PERSISTENT) {
    const m = new Map<string, { net: number; closed: number }>();
    for (const c of memCalls) {
      if (!c.closedAt || c.proceeds === null) continue;
      const cur = m.get(c.deviceId) ?? { net: 0, closed: 0 };
      cur.net += c.proceeds - c.tokens; cur.closed++;
      m.set(c.deviceId, cur);
    }
    rows = [...m.entries()].map(([device_id, v]) => ({ device_id, ...v }));
  } else {
    await ensureSchema();
    const q = await db().query<{ device_id: string; net: number; closed: number }>(
      `SELECT device_id, SUM(proceeds - tokens)::int net, count(*)::int closed
         FROM market_call WHERE device_id IS NOT NULL AND closed_at IS NOT NULL AND proceeds IS NOT NULL
         GROUP BY device_id`);
    rows = q.rows;
  }
  const out = rows.map((r) => ({ deviceId: r.device_id, handle: "", net: Number(r.net), closed: r.closed }));
  out.sort((a, b) => b.net - a.net);
  // See excludedLeaderboardDeviceId — filtered before the slice, same
  // backfill reasoning as leaderboardStreaks above.
  const excludedId = await excludedLeaderboardDeviceId();
  return withHandles(out.filter((r) => r.deviceId !== excludedId).slice(0, limit));
}

/** Names for board rows: X handle, else stored handle (minted on the spot). */
async function withHandles<T extends { deviceId: string; handle: string }>(rows: T[]): Promise<T[]> {
  for (const r of rows) {
    let h: string | null = null;
    if (PERSISTENT) {
      const q = await db().query<{ h: string | null }>(
        `SELECT COALESCE((SELECT a.handle FROM account a WHERE a.canonical_device = $1 AND a.provider='twitter' AND a.handle IS NOT NULL ORDER BY a.created_at LIMIT 1),
                (SELECT handle FROM device_balance WHERE device_id = $1)) h`, [r.deviceId]);
      h = q.rows[0]?.h ?? null;
    } else h = memHandle.get(r.deviceId) ?? null;
    if (!h) h = await ensureHandle(r.deviceId).catch(() => `#${r.deviceId.slice(0, 4)}`);
    r.handle = h.replace(/^@+/, "");
  }
  return rows;
}

/** How many calls this device (canonical) has ever placed — the free-taste cap
 *  reads this. Cheap: indexed by device_id. */
export async function callCountOf(rawDeviceId: string): Promise<number> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) return memCalls.filter((c) => c.deviceId === deviceId).length;
  await ensureSchema();
  const { rows } = await db().query<{ n: number }>(`SELECT count(*)::int n FROM market_call WHERE device_id = $1`, [deviceId]);
  return rows[0].n;
}

/** Every market that still has an open position — the sweep's worklist. */
export async function openSlugs(): Promise<string[]> {
  if (!PERSISTENT) return [...new Set(memCalls.filter((c) => !c.closedAt).map((c) => c.slug))];
  await ensureSchema();
  const { rows } = await db().query<{ slug: string }>(`SELECT DISTINCT slug FROM market_call WHERE closed_at IS NULL`);
  return rows.map((r) => r.slug);
}

/* ------------------------------------------------------------- bot state -----
 * The X bot's durable memory. Deliberately a tiny KV rather than columns on a
 * config row: the two values it holds have nothing to do with each other, and
 * the alternative is a one-row table that grows a column every time the loop
 * learns to remember something else.
 *
 * In-memory fallback exists so tests and local dry-runs work, and is exactly
 * as durable as it sounds. `PERSISTENT` is what the loop checks before it is
 * allowed to post for real.
 */
const memBotState = new Map<string, string>();

export async function botStateGet(key: string): Promise<string | null> {
  if (!PERSISTENT) return memBotState.get(key) ?? null;
  await ensureSchema();
  const { rows } = await db().query<{ v: string }>(`SELECT v FROM bot_state WHERE k=$1`, [key]);
  return rows[0]?.v ?? null;
}

export async function botStateSet(key: string, value: string): Promise<void> {
  if (!PERSISTENT) { memBotState.set(key, value); return; }
  await ensureSchema();
  await db().query(
    `INSERT INTO bot_state (k, v, at) VALUES ($1,$2,now())
     ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v, at=now()`,
    [key, value],
  );
}

export type MentionOutcome = "claimed" | "replied" | "skipped" | "failed";

interface MentionRow { tweetId: string; outcome: MentionOutcome; reason: string | null; slug: string | null }
const memMentions = new Map<string, MentionRow>();

/**
 * Claim a mention for processing, exactly once, ever.
 *
 * Returns false when this tweet already has a row, whatever that row says. A
 * previous FAILURE is deliberately not retried: the failure modes here are
 * "the model returned nonsense" and "Solana was down", and a loop that retries
 * the first one forever burns money on every poll. Requeue by hand.
 */
export async function claimMention(tweetId: string, author: string | null): Promise<boolean> {
  if (!PERSISTENT) {
    if (memMentions.has(tweetId)) return false;
    memMentions.set(tweetId, { tweetId, outcome: "claimed", reason: null, slug: null });
    return true;
  }
  await ensureSchema();
  const { rowCount } = await db().query(
    `INSERT INTO x_mention (tweet_id, author, outcome) VALUES ($1,$2,'claimed')
     ON CONFLICT (tweet_id) DO NOTHING`,
    [tweetId, author],
  );
  return rowCount === 1;
}

/**
 * The id of oddie's OWN reply for a market, so a resolution can answer it.
 *
 * The bot records this at src/x/mentionLoop.ts when it posts the card, keyed by
 * the mention it answered. That means the thread where somebody made the claim
 * is reachable from the slug alone, with no new data and nobody's permission:
 * oddie replies to itself, inside their thread, from its own account.
 */
const memReplyId = new Map<string, string>();
/** Test seam: give a slug a stored thread reply, so the offline suite can drive
 *  the posted path (mem has no x_mention table). */
export function _setMemReplyId(slug: string, replyId: string): void { memReplyId.set(slug, replyId); }
export function _resetMemReplyId(): void { memReplyId.clear(); }

export async function replyIdForSlug(slug: string): Promise<string | null> {
  if (!PERSISTENT) return memReplyId.get(slug) ?? null;
  await ensureSchema();
  const { rows } = await db().query<{ reply_id: string | null }>(
    `SELECT reply_id FROM x_mention
      WHERE slug = $1 AND outcome = 'replied' AND reply_id IS NOT NULL
      ORDER BY at DESC LIMIT 1`,
    [slug],
  );
  return rows[0]?.reply_id ?? null;
}

export async function settleMention(
  tweetId: string,
  outcome: Exclude<MentionOutcome, "claimed">,
  extra: { reason?: string | null; slug?: string | null; replyId?: string | null } = {},
): Promise<void> {
  if (!PERSISTENT) {
    memMentions.set(tweetId, { tweetId, outcome, reason: extra.reason ?? null, slug: extra.slug ?? null });
    return;
  }
  await ensureSchema();
  await db().query(
    `UPDATE x_mention SET outcome=$2, reason=$3, slug=$4, reply_id=$5, at=now() WHERE tweet_id=$1`,
    [tweetId, outcome, extra.reason ?? null, extra.slug ?? null, extra.replyId ?? null],
  );
}

/** Test seam: the in-memory ledger, so a test can assert on it without a database. */
/** Test seam: the in-memory growth ledger, so a test can credit points and
 *  backdate them without going through every award path. */
export function _memSeasonCredit(deviceId: string, amount: number, daysAgo = 0): void {
  memSeasonLog.push({
    deviceId, handle: null, event: "test", amount, slug: null,
    dedupKey: `test-${deviceId}-${memSeasonLog.length}`,
    createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  });
}

export function _memMentionOutcome(tweetId: string): MentionOutcome | null {
  return memMentions.get(tweetId)?.outcome ?? null;
}

/** Test seam: forget everything the in-memory bot layer knows. */
export function _resetBotState(): void {
  memBotState.clear();
  memMentions.clear();
}

/* ------------------------------------------------------------- avatars -----
 * A real picture, arriving already cropped and resized by the browser.
 *
 * The client draws the file onto a 256x256 canvas and hands over a JPEG, so
 * everything below only has to check that what arrived is small, is a JPEG or
 * a PNG, and actually decodes as one. That keeps the server free of image
 * processing entirely: no sharp, no ImageMagick, no upload directory.
 */
const memAvatars = new Map<string, { image: Buffer; mime: string }>();

/** Hard ceiling on a stored avatar. A 256px JPEG lands around 15-25KB, so this
 *  is roughly ten times the expected size: comfortable for an odd encoder,
 *  nowhere near enough for anyone to use the table as a file host. */
export const AVATAR_MAX_BYTES = 250_000;

export interface AvatarUpload { image: Buffer; mime: string }

/**
 * Validate a data URL into bytes, or null.
 *
 * The magic bytes are checked, not just the declared type: a `data:image/jpeg`
 * header costs an attacker nothing to write, and the point of restricting the
 * type at all is that what we later serve back with an image content-type is
 * genuinely an image.
 */
export function parseAvatarDataUrl(raw: unknown): AvatarUpload | null {
  if (typeof raw !== "string") return null;
  const m = /^data:(image\/jpeg|image\/png);base64,([A-Za-z0-9+/=]+)$/.exec(raw.trim());
  if (!m) return null;
  let image: Buffer;
  try { image = Buffer.from(m[2], "base64"); } catch { return null; }
  if (!image.length || image.length > AVATAR_MAX_BYTES) return null;
  const isJpeg = image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
  const isPng = image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (m[1] === "image/jpeg" && !isJpeg) return null;
  if (m[1] === "image/png" && !isPng) return null;
  return { image, mime: m[1] };
}

export async function setDeviceAvatar(rawDeviceId: string, a: AvatarUpload): Promise<void> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) { memAvatars.set(deviceId, a); return; }
  await ensureSchema();
  await db().query(
    `INSERT INTO device_avatar (device_id, image, mime, set_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (device_id) DO UPDATE SET image=EXCLUDED.image, mime=EXCLUDED.mime, set_at=now()`,
    [deviceId, a.image, a.mime],
  );
}

export async function clearDeviceAvatar(rawDeviceId: string): Promise<void> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) { memAvatars.delete(deviceId); return; }
  await ensureSchema();
  await db().query(`DELETE FROM device_avatar WHERE device_id = $1`, [deviceId]);
}

/** The bytes, for serving. */
export async function deviceAvatarImage(rawDeviceId: string): Promise<AvatarUpload | null> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) return memAvatars.get(deviceId) ?? null;
  await ensureSchema();
  const { rows } = await db().query<{ image: Buffer; mime: string }>(
    `SELECT image, mime FROM device_avatar WHERE device_id = $1`, [deviceId]);
  return rows[0] ? { image: rows[0].image, mime: rows[0].mime } : null;
}

/** Just "is there one", plus when it changed, for cache-busting a URL without
 *  reading the bytes on every feed render. */
export async function deviceAvatarStamp(rawDeviceId: string): Promise<number | null> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) return memAvatars.has(deviceId) ? 1 : null;
  await ensureSchema();
  const { rows } = await db().query<{ at: Date }>(
    `SELECT set_at AS at FROM device_avatar WHERE device_id = $1`, [deviceId]);
  return rows[0] ? rows[0].at.getTime() : null;
}

/** Which of these handles have a picture, and how fresh, so the feed can point
 *  an <img> at it. Handles with no oddie account or no upload are simply
 *  absent and the client falls back to the generated letter avatar. */
export async function avatarStampsForHandles(handles: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const wanted = [...new Set(handles.filter(Boolean).map((h) => h.replace(/^@+/, "").toLowerCase()))];
  for (const h of wanted) {
    const dev = await deviceForTwitterHandle(h);
    if (!dev) continue;
    const stamp = await deviceAvatarStamp(dev);
    if (stamp) out[h] = stamp;
  }
  return out;
}

/** The device behind a handle, for serving that handle's picture. */
export async function deviceForHandlePublic(handle: string): Promise<string | null> {
  return deviceForTwitterHandle(handle);
}


// --- The oracle's own record -------------------------------------------------
//
// Why this exists at all: every decision the oracle reaches is a REFUSAL far
// more often than a settlement, and a refusal leaves no trace anywhere. A
// market that abstained looks exactly like a market nobody got to, so nobody
// could tell whether the thing was working, and nobody could see the same
// market being re-decided at full price on every single run.

export interface OracleAttempt {
  /** The gate that stopped it last time, or null when it has never been tried. */
  lastGate: string | null;
  lastDecidedAt: string | null;
  /** How many times the model has actually been called for this market. The
   *  retry backoff is built on this rather than on the row count, because the
   *  free code gates decide before a token is spent and must not push a market
   *  further down the backoff for costing nothing. */
  paidAttempts: number;
}

export interface OracleDecisionRow {
  id: number;
  slug: string;
  settle: "yes" | "no" | null;
  gate: string;
  reason: string;
  confidence: string | null;
  secondOpinion: string | null;
  citations: unknown[];
  verified: number;
  undated: number;
  stale: number;
  absent: number;
  unreachable: number;
  paid: boolean;
  decidedAt: string;
}

interface MemOracleRow extends OracleDecisionRow { }
const memOracleDecisions: MemOracleRow[] = [];
let memOracleId = 0;

/** The shape recordOracleDecision needs, kept structural rather than importing
 *  OracleDecision itself: the store must not depend on the oracle module, and a
 *  type-only import across that boundary is the kind of thing that becomes a
 *  runtime cycle the day somebody drops the `type` keyword. */
export interface OracleDecisionInput {
  slug: string;
  settle: "yes" | "no" | null;
  gate: string;
  reason: string;
  confidence?: string | null;
  secondOpinion?: string | null;
  citations?: unknown[];
  verified?: number;
  undated?: number;
  stale?: number;
  absent?: number;
  unreachable?: number;
  /** Whether the model was actually called. */
  paid: boolean;
}

/** Append exactly one row for one decide() call. Best-effort in the
 *  logExtraction sense: the log going down must never take a settlement with
 *  it, so every failure is swallowed after being said out loud. */
export async function recordOracleDecision(d: OracleDecisionInput): Promise<void> {
  try {
    if (!PERSISTENT) {
      memOracleDecisions.push({
        id: ++memOracleId, slug: d.slug, settle: d.settle, gate: d.gate, reason: d.reason,
        confidence: d.confidence ?? null, secondOpinion: d.secondOpinion ?? null,
        citations: d.citations ?? [],
        verified: d.verified ?? 0, undated: d.undated ?? 0, stale: d.stale ?? 0,
        absent: d.absent ?? 0, unreachable: d.unreachable ?? 0,
        paid: d.paid, decidedAt: new Date().toISOString(),
      });
      return;
    }
    await ensureSchema();
    // The citations array is stringified. Passed through raw, pg serialises an
    // array as a Postgres ARRAY literal rather than as JSON, and the insert
    // either errors or stores something absurd.
    await db().query(
      `INSERT INTO oracle_decision
         (slug, settle, gate, reason, confidence, second_opinion, citations,
          cites_verified, cites_undated, cites_stale, cites_absent, cites_unreachable, paid)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)`,
      [
        d.slug, d.settle, d.gate, d.reason, d.confidence ?? null, d.secondOpinion ?? null,
        JSON.stringify(d.citations ?? []),
        d.verified ?? 0, d.undated ?? 0, d.stale ?? 0, d.absent ?? 0, d.unreachable ?? 0, d.paid,
      ],
    );
  } catch (e) {
    console.error("[oracle-log] write failed (non-fatal):", (e as Error).message);
  }
}

/** What the retry policy needs to know about one market, in one query. */
export async function oracleAttemptFor(slug: string): Promise<OracleAttempt> {
  if (!PERSISTENT) {
    const rows = memOracleDecisions.filter((r) => r.slug === slug);
    const last = rows[rows.length - 1] ?? null;
    return {
      lastGate: last?.gate ?? null,
      lastDecidedAt: last?.decidedAt ?? null,
      paidAttempts: rows.filter((r) => r.paid).length,
    };
  }
  await ensureSchema();
  // count(*) comes back as a bigint STRING unless it is cast at the edge, and a
  // `number` annotation on it would be an unchecked lie no in-memory test could
  // ever expose.
  const { rows } = await db().query<{ gate: string | null; decided_at: Date | null; paid_attempts: number }>(
    `SELECT
       (SELECT gate       FROM oracle_decision WHERE slug = $1 ORDER BY id DESC LIMIT 1) AS gate,
       (SELECT decided_at FROM oracle_decision WHERE slug = $1 ORDER BY id DESC LIMIT 1) AS decided_at,
       (SELECT count(*)::int FROM oracle_decision WHERE slug = $1 AND paid) AS paid_attempts`,
    [slug],
  );
  const r = rows[0];
  return {
    lastGate: r?.gate ?? null,
    lastDecidedAt: r?.decided_at ? r.decided_at.toISOString() : null,
    paidAttempts: r?.paid_attempts ?? 0,
  };
}

/** The board's recent history, newest first. Ordered by id, not by decided_at:
 *  now() is TRANSACTION time, so rows written in one transaction share a
 *  timestamp and would come back in an arbitrary order. */
export async function recentOracleDecisions(limit = 50): Promise<OracleDecisionRow[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  if (!PERSISTENT) return [...memOracleDecisions].reverse().slice(0, n);
  await ensureSchema();
  const { rows } = await db().query<OracleRow>(
    `SELECT * FROM oracle_decision ORDER BY id DESC LIMIT $1`, [n],
  );
  return rows.map(rowToOracleDecision);
}

/** How often each gate fired lately. This is what OracleDecision.gate's own doc
 *  comment asks for and there is nowhere else it can be answered from. */
export async function oracleGateCounts(sinceDays = 7): Promise<Record<string, number>> {
  if (!PERSISTENT) {
    const cutoff = Date.now() - sinceDays * 86_400_000;
    const out: Record<string, number> = {};
    for (const r of memOracleDecisions) {
      if (new Date(r.decidedAt).getTime() <= cutoff) continue;
      out[r.gate] = (out[r.gate] ?? 0) + 1;
    }
    return out;
  }
  await ensureSchema();
  // The interval is built in SQL from a bound parameter, never from a JS date.
  const { rows } = await db().query<{ gate: string; n: number }>(
    `SELECT gate, count(*)::int n FROM oracle_decision
      WHERE decided_at > now() - ($1 || ' days')::interval GROUP BY gate ORDER BY n DESC`,
    [String(Math.max(1, Math.floor(sinceDays)))],
  );
  return Object.fromEntries(rows.map((r) => [r.gate, r.n]));
}

interface OracleRow {
  id: string; slug: string; settle: "yes" | "no" | null; gate: string; reason: string;
  confidence: string | null; second_opinion: string | null; citations: unknown[];
  cites_verified: number; cites_undated: number; cites_stale: number;
  cites_absent: number; cites_unreachable: number; paid: boolean; decided_at: Date;
}
/** The one place `id` stops being a string. bigserial arrives from pg as text. */
function rowToOracleDecision(r: OracleRow): OracleDecisionRow {
  return {
    id: Number(r.id), slug: r.slug, settle: r.settle, gate: r.gate, reason: r.reason,
    confidence: r.confidence, secondOpinion: r.second_opinion,
    citations: Array.isArray(r.citations) ? r.citations : [],
    verified: r.cites_verified, undated: r.cites_undated, stale: r.cites_stale,
    absent: r.cites_absent, unreachable: r.cites_unreachable,
    paid: r.paid, decidedAt: r.decided_at.toISOString(),
  };
}

/** Test seam: the in-memory log, so the offline suite can assert on what was
 *  recorded without a database. */
export function _memOracleDecisions(): OracleDecisionRow[] {
  return [...memOracleDecisions];
}
/** Test seam: backdate a market's whole history so a test can watch a backoff
 *  window mature without sleeping. */
export function _memBackdateOracle(slug: string, minutes: number): void {
  for (const r of memOracleDecisions) {
    if (r.slug === slug) r.decidedAt = new Date(Date.now() - minutes * 60_000).toISOString();
  }
}
/** Test seam: clear the log and its counter. */
export function _resetOracleDecisions(): void {
  memOracleDecisions.length = 0;
  memOracleId = 0;
}

/**
 * Is there already an OPEN market for this source post?
 *
 * The distribution model is people tagging oddie under somebody else's hot
 * take, so several people tagging the SAME take is the expected case rather
 * than an edge one. Without this, each of them minted their own market: two
 * rent deposits out of our wallet, two extraction calls, and, worse than either,
 * one question with its pool split across two pari-mutuel markets. Two thin
 * markets are not one good market, and the second one is worse than useless
 * because it makes the first look small.
 *
 * Matched on the tweet ID rather than the whole URL, because the handle in a
 * status link is decorative and its case is not stable.
 *
 * OPEN markets only. A settled market for the same post is not a duplicate: the
 * claim may have moved on, and nothing about a finished pool is split by a new
 * one.
 */
export async function openMarketForSourcePost(sourceUrl: string): Promise<{ slug: string; question: string } | null> {
  // Keyed, not pattern-matched. The old form looked for "/status/" in the raw
  // URL, so a t.me permalink produced no id, returned null here, and the
  // one-post-one-market rule was silently skipped for every Telegram market.
  const key = sourcePostKey(sourceUrl);
  if (!key) return null;
  if (!PERSISTENT) {
    for (const [slug, sur] of memSurfacer) {
      if ((sur.sourceKey ?? sourcePostKey(sur.sourceUrl)) !== key) continue;
      const meta = memCommunity.get(slug);
      if (meta?.resolvedOutcome || meta?.retiredAt) continue;
      const rec = mem.get(slug);
      if (rec) return { slug, question: rec.market.question };
    }
    return null;
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; question: string }>(
    `SELECT ms.slug, s.question
       FROM market_surfacer ms
       JOIN market_slug s      ON s.slug = ms.slug
       JOIN community_market c ON c.slug = ms.slug
      WHERE ms.source_key = $1
        AND c.resolved_outcome IS NULL AND c.retired_at IS NULL
      ORDER BY ms.created_at ASC
      LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}


// --- Entry receipts: who called it, and when the crowd disagreed -------------

export interface ChainEntry {
  slug: string;
  wallet: string;
  side: "yes" | "no";
  /** Their side's pool share at entry, 0-100. Low = contrarian. */
  entryPct: number;
  lamports: number;
  createdAt: string;
}

/** The pool depth at which an earliness claim counts for full credit. Below it
 *  the credit scales down linearly, and the reason is an attack rather than a
 *  taste:
 *
 *  entry_pct is a side's share of the pool just before you stake, so two
 *  wallets you control can manufacture a perfect one. Wallet A puts the minimum
 *  on NO in an empty market; wallet B then stakes YES at a 0% share, which is
 *  maximum earliness. You do not have to predict anything, because you are on
 *  both sides and one of you always wins. Measured against the live minimum
 *  stake, that receipt costs about a cent.
 *
 *  Scaling by depth prices it. To claim full credit you must put this much
 *  liquidity in the pool and eat the 4% fee on all of it, and if both sides are
 *  yours you eat it on both. Free becomes "4% of the depth you are claiming
 *  credit for", which is roughly what honest participation costs.
 *
 *  This is a mitigation, not a proof: a farmer with real capital can still buy
 *  credit. It stops being nearly free, which is the part that matters once
 *  rewards ride on it. */
export const FULL_CREDIT_LAMPORTS = 5_000_000_000; // 5 SOL

/**
 * What one settled call is worth. The ONE place this is computed, called by
 * both the receipts and the board, so the two can never disagree about what a
 * wallet earned.
 *
 * 100 minus the crowd's agreement at entry, on a win and nothing on a loss,
 * scaled by how deep the pool actually got. Calling YES at 30 in a real market
 * is worth 70; joining the pile at 85 is worth 15; calling YES at 0 in a pool
 * with two dust stakes in it is worth almost nothing.
 *
 * Stake SIZE still never enters it. A board you can buy with size is a PnL
 * board, and PnL boards belong to whoever started with the most money. Depth is
 * a property of the market, not of your position in it.
 */
export function receiptWeight(input: { entryPct: number; won: boolean; poolLamports: number }): number {
  if (!input.won) return 0;
  const depth = Math.min(1, Math.max(0, input.poolLamports) / FULL_CREDIT_LAMPORTS);
  return Math.round((100 - Math.max(0, Math.min(100, input.entryPct))) * depth);
}

/** A settled entry, scored. */
export interface Receipt extends ChainEntry {
  outcome: "yes" | "no";
  won: boolean;
  question: string;
  /** The pool at settlement, which is what the weight is scaled by. */
  poolLamports: number;
  weight: number;
}

const memChainEntries: ChainEntry[] = [];

/** Stamp a wallet's first stake in a market. Later top-ups are ignored, see the
 *  table comment. Best-effort: a stamp failure must never fail a stake that has
 *  already been broadcast. */
export async function recordChainEntry(e: {
  slug: string; wallet: string; side: "yes" | "no"; entryPct: number; lamports: number;
}): Promise<void> {
  const entryPct = Math.max(0, Math.min(100, Math.round(e.entryPct)));
  try {
    if (!PERSISTENT) {
      if (!memChainEntries.some((x) => x.slug === e.slug && x.wallet === e.wallet)) {
        memChainEntries.push({ ...e, entryPct, createdAt: new Date().toISOString() });
      }
      return;
    }
    await ensureSchema();
    await db().query(
      `INSERT INTO chain_entry (slug, wallet, side, entry_pct, lamports)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (slug, wallet) DO NOTHING`,
      [e.slug, e.wallet, e.side, entryPct, e.lamports],
    );
  } catch (err) {
    console.error("[entry] stamp failed (non-fatal):", (err as Error).message);
  }
}

interface ChainEntryRow { slug: string; wallet: string; side: "yes" | "no"; entry_pct: number; lamports: string; created_at: Date }
const rowToEntry = (r: ChainEntryRow): ChainEntry => ({
  slug: r.slug, wallet: r.wallet, side: r.side, entryPct: r.entry_pct,
  // bigint arrives from pg as a string; the annotation alone would be a lie.
  lamports: Number(r.lamports), createdAt: r.created_at.toISOString(),
});

export async function chainEntryFor(slug: string, wallet: string): Promise<ChainEntry | null> {
  if (!PERSISTENT) return memChainEntries.find((x) => x.slug === slug && x.wallet === wallet) ?? null;
  await ensureSchema();
  const { rows } = await db().query<ChainEntryRow>(
    `SELECT slug, wallet, side, entry_pct, lamports, created_at FROM chain_entry WHERE slug = $1 AND wallet = $2`,
    [slug, wallet],
  );
  return rows[0] ? rowToEntry(rows[0]) : null;
}

/**
 * The pool a market settled with, in lamports.
 *
 * market_fee_log already records it: basis_amount on the real-money rows is the
 * vault total the fee was taken from, written at resolve. Nothing new is
 * stored to answer this.
 *
 * The fallback sums the entry stamps, which UNDERCOUNTS because stamps record
 * only a wallet's first stake and never its top-ups. That is the right
 * direction to be wrong in: a smaller pool means less credit, so a market whose
 * fee log went missing gives its callers a conservative score rather than a
 * generous one.
 */
async function settlementPools(slugs: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (slugs.length === 0) return out;
  if (!PERSISTENT) {
    for (const slug of slugs) {
      const logged = memFeeLog
        .filter((f) => f.slug === slug && f.marketKind === "real")
        .reduce((a, f) => Math.max(a, f.basisAmount), 0);
      const stamped = memChainEntries.filter((e) => e.slug === slug).reduce((a, e) => a + e.lamports, 0);
      out.set(slug, Math.max(logged, stamped));
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; pool: string }>(
    `SELECT ce.slug,
            GREATEST(
              COALESCE((SELECT MAX(f.basis_amount) FROM market_fee_log f
                         WHERE f.slug = ce.slug AND f.market_kind = 'real'), 0),
              COALESCE(SUM(ce.lamports), 0)
            ) AS pool
       FROM chain_entry ce
      WHERE ce.slug = ANY($1::text[])
      GROUP BY ce.slug`,
    [slugs],
  );
  // bigint arrives as a string; a `number` annotation here would be a lie.
  for (const r of rows) out.set(r.slug, Number(r.pool));
  return out;
}

/**
 * SUPERSEDED, AND NOT TO BE PICKED BACK UP.
 *
 * server.ts's settledLedger() now prices every settled call from the MARKET
 * ACCOUNT (the frozen total_yes/total_no/fees the program pays against), which
 * this module cannot reach and must not try to. These two price off
 * settlementPools instead, which knows the pool but never the winning side's
 * share of it — the denominator of the payout. So they can agree with the
 * board by luck and not by construction.
 *
 * Nothing in the server calls either any more; only test-receipts.ts does.
 * They go with feed.html's retirement. Until then: do NOT wire a surface to
 * them. One person's record computed two ways is two records.
 */
/** One wallet's settled receipts, newest market first. Open markets are not
 *  receipts yet: a receipt is proof of having been right, and an open market
 *  has not said who was. */
export async function walletReceipts(wallet: string, limit = 50): Promise<Receipt[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const score = (e: ChainEntry, outcome: "yes" | "no", question: string, poolLamports: number): Receipt => {
    const won = e.side === outcome;
    return { ...e, outcome, question, won, poolLamports, weight: receiptWeight({ entryPct: e.entryPct, won, poolLamports }) };
  };
  if (!PERSISTENT) {
    const mine = memChainEntries.filter((e) => e.wallet === wallet);
    const pools = await settlementPools([...new Set(mine.map((e) => e.slug))]);
    return mine
      .map((e) => {
        const meta = memCommunity.get(e.slug);
        const rec = mem.get(e.slug);
        return meta?.resolvedOutcome && rec
          ? score(e, meta.resolvedOutcome, rec.market.question, pools.get(e.slug) ?? 0)
          : null;
      })
      .filter((r): r is Receipt => r !== null)
      .slice(0, n);
  }
  await ensureSchema();
  const { rows } = await db().query<ChainEntryRow & { resolved_outcome: "yes" | "no"; question: string }>(
    `SELECT ce.slug, ce.wallet, ce.side, ce.entry_pct, ce.lamports, ce.created_at, cm.resolved_outcome, s.question
       FROM chain_entry ce
       JOIN community_market cm ON cm.slug = ce.slug AND cm.resolved_outcome IS NOT NULL
       JOIN market_slug s ON s.slug = ce.slug
      WHERE ce.wallet = $1
      ORDER BY ce.created_at DESC
      LIMIT $2`,
    [wallet, n],
  );
  const pools = await settlementPools([...new Set(rows.map((r) => r.slug))]);
  return rows.map((r) => score(rowToEntry(r), r.resolved_outcome, r.question, pools.get(r.slug) ?? 0));
}

/**
 * Every settled call by everyone, with the market account it landed in.
 *
 * The board and a wallet's own page both need the same raw material, and they
 * need one thing this store cannot supply: what the WINNING SIDE totalled at
 * resolve, which is the denominator of the program's payout. That number lives
 * on the market account and nowhere else, so this returns the on-chain pubkey
 * and lets the caller (which is allowed to touch the chain layer; this module
 * deliberately is not) read it once for the whole board.
 */
export interface SettledCall {
  wallet: string; slug: string; question: string; onchainPubkey: string | null;
  side: "yes" | "no"; lamports: number; entryPct: number;
  outcome: "yes" | "no"; won: boolean;
}

export async function settledCalls(limit = 2000): Promise<SettledCall[]> {
  const n = Math.max(1, Math.min(5000, Math.floor(limit)));
  if (!PERSISTENT) {
    const out: SettledCall[] = [];
    for (const e of memChainEntries) {
      const meta = memCommunity.get(e.slug);
      const rec = mem.get(e.slug);
      if (!meta?.resolvedOutcome || !rec) continue;
      out.push({
        wallet: e.wallet, slug: e.slug, question: rec.market.question,
        onchainPubkey: meta.onchainPubkey ?? null,
        side: e.side, lamports: e.lamports, entryPct: e.entryPct,
        outcome: meta.resolvedOutcome, won: e.side === meta.resolvedOutcome,
      });
      if (out.length >= n) break;
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{
    wallet: string; slug: string; question: string; onchain_pubkey: string | null;
    side: "yes" | "no"; lamports: string; entry_pct: number; resolved_outcome: "yes" | "no";
  }>(
    `SELECT ce.wallet, ce.slug, s.question, cm.onchain_pubkey, ce.side, ce.lamports,
            ce.entry_pct, cm.resolved_outcome
       FROM chain_entry ce
       JOIN community_market cm ON cm.slug = ce.slug AND cm.resolved_outcome IS NOT NULL
       JOIN market_slug s ON s.slug = ce.slug
      ORDER BY ce.created_at DESC
      LIMIT $1`,
    [n],
  );
  // lamports is bigint and arrives as a STRING; annotating it `number` would be
  // a lie that only breaks against a real database.
  return rows.map((r) => ({
    wallet: r.wallet, slug: r.slug, question: r.question, onchainPubkey: r.onchain_pubkey,
    side: r.side, lamports: Number(r.lamports), entryPct: r.entry_pct,
    outcome: r.resolved_outcome, won: r.side === r.resolved_outcome,
  }));
}

export interface WalletStanding { wallet: string; wins: number; losses: number; points: number }

/**
 * SUPERSEDED, AND NOT TO BE PICKED BACK UP.
 *
 * server.ts's settledLedger() now prices every settled call from the MARKET
 * ACCOUNT (the frozen total_yes/total_no/fees the program pays against), which
 * this module cannot reach and must not try to. These two price off
 * settlementPools instead, which knows the pool but never the winning side's
 * share of it — the denominator of the payout. So they can agree with the
 * board by luck and not by construction.
 *
 * Nothing in the server calls either any more; only test-receipts.ts does.
 * They go with feed.html's retirement. Until then: do NOT wire a surface to
 * them. One person's record computed two ways is two records.
 */
/** The board, by contrarian points. Ordered by points and never by win count:
 *  win count is the bandwagon's own metric, and the whole reason this board
 *  exists is that the pool mechanics tax the people it should be crowning. */
export async function walletLeaderboard(limit = 20): Promise<WalletStanding[]> {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));

  /** Settled calls, raw. Scoring happens in ONE place (receiptWeight) for both
   *  backends and for the receipts too: a board that computes the formula in
   *  SQL and a profile that computes it in TypeScript is two formulas, and the
   *  day they disagree is the day the number stops meaning anything. */
  let calls: Array<{ wallet: string; slug: string; entryPct: number; won: boolean }>;
  if (!PERSISTENT) {
    calls = memChainEntries.flatMap((e) => {
      const out = memCommunity.get(e.slug)?.resolvedOutcome;
      return out ? [{ wallet: e.wallet, slug: e.slug, entryPct: e.entryPct, won: e.side === out }] : [];
    });
  } else {
    await ensureSchema();
    const { rows } = await db().query<{ wallet: string; slug: string; entry_pct: number; won: boolean }>(
      `SELECT ce.wallet, ce.slug, ce.entry_pct, (ce.side = cm.resolved_outcome) AS won
         FROM chain_entry ce
         JOIN community_market cm ON cm.slug = ce.slug AND cm.resolved_outcome IS NOT NULL`,
    );
    calls = rows.map((r) => ({ wallet: r.wallet, slug: r.slug, entryPct: r.entry_pct, won: r.won }));
  }

  const pools = await settlementPools([...new Set(calls.map((c) => c.slug))]);
  const by = new Map<string, WalletStanding>();
  for (const c of calls) {
    const w = by.get(c.wallet) ?? { wallet: c.wallet, wins: 0, losses: 0, points: 0 };
    if (c.won) {
      w.wins++;
      w.points += receiptWeight({ entryPct: c.entryPct, won: true, poolLamports: pools.get(c.slug) ?? 0 });
    } else {
      w.losses++;
    }
    by.set(c.wallet, w);
  }
  return [...by.values()].sort((a, b) => b.points - a.points).slice(0, n);
}

/** slug for an on-chain market account, for the submit relay's stamp. */
export async function slugForOnchainPubkey(pubkey: string): Promise<string | null> {
  if (!PERSISTENT) {
    for (const [slug, meta] of memCommunity) if (meta.onchainPubkey === pubkey) return slug;
    return null;
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string }>(
    `SELECT slug FROM community_market WHERE onchain_pubkey = $1`, [pubkey],
  );
  return rows[0]?.slug ?? null;
}

/** Test seam: clear the entry stamps. */
export function _resetChainEntries(): void { memChainEntries.length = 0; }


/**
 * Reachable email addresses for a set of WALLETS.
 *
 * The chain knows a wallet; the mailer knows an address; nothing joined them,
 * so a wallet-only staker could win and never be told. This walks the link the
 * user opted into: /api/auth/wallet/verify stores the wallet as a `phantom`
 * account row against a canonical device, and a Google sign-in stores the
 * address against that same device. A wallet with no phantom row, or a device
 * with no Google row, simply is not reachable and gets nothing.
 *
 * NO NEW LINK IS CREATED HERE. The privacy stance is that a device→wallet
 * association is never inferred from a stake; this only reads one the user
 * deliberately made by signing a challenge, and reaches the address they
 * already gave us "for settlement emails only".
 */
export async function emailsForWallets(wallets: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (wallets.length === 0) return out;
  const { _memAccounts } = await import("./accounts.js");
  if (!PERSISTENT) {
    for (const w of wallets) {
      const link = _memAccounts.find((a) => a.provider === "phantom" && a.uid === w);
      if (!link) continue;
      const google = _memAccounts.find((a) => a.provider === "google" && a.email && a.canonicalDevice === link.canonicalDevice);
      if (google?.email) out[w] = google.email;
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{ wallet: string; email: string }>(
    `SELECT DISTINCT ON (w.provider_uid) w.provider_uid AS wallet, g.email
       FROM account w
       JOIN account g
         ON g.canonical_device = w.canonical_device
        AND g.provider = 'google'
        AND g.email IS NOT NULL
      WHERE w.provider = 'phantom' AND w.provider_uid = ANY($1::text[])
      ORDER BY w.provider_uid, g.created_at`,
    [wallets],
  );
  for (const r of rows) out[r.wallet] = r.email;
  return out;
}

/** Every wallet that stamped an entry on this market, for the settlement
 *  notice. First stakes only, which is all we need: a wallet that topped up
 *  already has a stamp. */
export async function walletsInMarket(slug: string): Promise<Array<{ wallet: string; side: "yes" | "no"; entryPct: number; lamports: number }>> {
  if (!PERSISTENT) {
    return memChainEntries.filter((e) => e.slug === slug).map((e) => ({ wallet: e.wallet, side: e.side, entryPct: e.entryPct, lamports: e.lamports }));
  }
  await ensureSchema();
  const { rows } = await db().query<{ wallet: string; side: "yes" | "no"; entry_pct: number; lamports: string }>(
    `SELECT wallet, side, entry_pct, lamports FROM chain_entry WHERE slug = $1`, [slug],
  );
  // bigint arrives as a string.
  return rows.map((r) => ({ wallet: r.wallet, side: r.side, entryPct: r.entry_pct, lamports: Number(r.lamports) }));
}

/** The markets a wallet has stamped an entry on that are still OPEN. These are
 *  the candidates for its open-positions list; the authoritative amount comes
 *  from the chain, not from here, because a stamp records only a first stake. */
export async function openEntriesFor(wallet: string): Promise<Array<{ slug: string; question: string; side: "yes" | "no"; entryPct: number; closesAt: string | null; onchainPubkey: string | null }>> {
  if (!PERSISTENT) {
    return memChainEntries
      .filter((e) => e.wallet === wallet && !memCommunity.get(e.slug)?.resolvedOutcome)
      .map((e) => {
        const rec = mem.get(e.slug);
        return {
          slug: e.slug, question: rec?.market.question ?? e.slug, side: e.side, entryPct: e.entryPct,
          closesAt: rec?.market.closesAt ?? null, onchainPubkey: memCommunity.get(e.slug)?.onchainPubkey ?? null,
        };
      });
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; question: string; side: "yes" | "no"; entry_pct: number; closes_at: Date | null; onchain_pubkey: string | null }>(
    `SELECT ce.slug, s.question, ce.side, ce.entry_pct, s.closes_at, cm.onchain_pubkey
       FROM chain_entry ce
       JOIN community_market cm ON cm.slug = ce.slug AND cm.resolved_outcome IS NULL
       JOIN market_slug s ON s.slug = ce.slug
      WHERE ce.wallet = $1
      ORDER BY s.closes_at ASC NULLS LAST`,
    [wallet],
  );
  return rows.map((r) => ({
    slug: r.slug, question: r.question, side: r.side, entryPct: r.entry_pct,
    closesAt: r.closes_at ? r.closes_at.toISOString() : null, onchainPubkey: r.onchain_pubkey,
  }));
}

/**
 * Take a market off the board without destroying it.
 *
 * THE GUARD THAT NO ARGUMENT OVERRIDES: a market with anything in its vault is
 * refused. Retiring hides a market from discovery, and hiding a market somebody
 * has money in is hiding their money. The caller passes the vault total it read
 * from the chain; passing null means it could not be read, which is also a
 * refusal, because "we could not check" must never resolve to "go ahead".
 *
 * What stays reachable afterwards, deliberately: the permalink, the market
 * detail, and the market's rows in anyone's positions. What goes: the feed,
 * pricing, the agent API, and the one-post-one-market check, so a fresh tag on
 * the same post opens a fresh market instead of pointing at a dead one.
 */
export async function retireMarket(slug: string, vaultLamports: number | null): Promise<{ ok: boolean; reason?: string }> {
  if (vaultLamports === null) return { ok: false, reason: "the vault could not be read, so it was not retired" };
  if (vaultLamports > 0) return { ok: false, reason: `holds ${(vaultLamports / 1e9).toFixed(4)} SOL` };
  if (!PERSISTENT) {
    const meta = memCommunity.get(slug);
    if (!meta) return { ok: false, reason: "unknown market" };
    // Latches like the UPDATE below, so the two backends cannot disagree about
    // what a second call does.
    if (meta.retiredAt) return { ok: false, reason: "unknown market, or already retired" };
    meta.retiredAt = new Date().toISOString();
    return { ok: true };
  }
  await ensureSchema();
  // Latches: a second call on an already-retired market changes nothing and
  // reports honestly rather than moving the timestamp.
  const { rowCount } = await db().query(
    `UPDATE community_market SET retired_at = now() WHERE slug = $1 AND retired_at IS NULL`, [slug],
  );
  return (rowCount ?? 0) > 0 ? { ok: true } : { ok: false, reason: "unknown market, or already retired" };
}

/** Is this market off the board? Used by the tools that must not act on one. */
export async function isRetired(slug: string): Promise<boolean> {
  if (!PERSISTENT) return Boolean(memCommunity.get(slug)?.retiredAt);
  await ensureSchema();
  const { rows } = await db().query<{ retired_at: Date | null }>(
    `SELECT retired_at FROM community_market WHERE slug = $1`, [slug],
  );
  return Boolean(rows[0]?.retired_at);
}

// --- The bot API: idempotency and quota ------------------------------------

export interface ClaimKeyRecord {
  slug: string | null;
  refusal: string | null;
  detail: string | null;
  /** True when a cached refusal has aged out and should be re-asked. */
  expired: boolean;
}

const memClaimKeys = new Map<string, { slug: string | null; refusal: string | null; detail: string | null; expiresAt: number | null }>();

/** What this idempotency key already produced, or null if it is new. A refusal
 *  past its expiry answers null so the claim is asked again. */
export async function claimKeyLookup(key: string): Promise<ClaimKeyRecord | null> {
  if (!PERSISTENT) {
    const r = memClaimKeys.get(key);
    if (!r) return null;
    const expired = r.expiresAt !== null && Date.now() > r.expiresAt;
    return expired ? null : { slug: r.slug, refusal: r.refusal, detail: r.detail, expired: false };
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string | null; refusal: string | null; detail: string | null; expired: boolean }>(
    `SELECT slug, refusal, detail, (expires_at IS NOT NULL AND expires_at < now()) AS expired
       FROM api_claim_key WHERE key = $1`, [key],
  );
  const r = rows[0];
  if (!r) return null;
  return r.expired ? null : r;
}

/**
 * Record what a key produced. Returns what is STORED, which may not be what was
 * passed: if another request won the race, the winner's answer is returned and
 * this one is discarded. That is the point, and it is why the write is a single
 * statement rather than a check followed by an insert.
 */
export async function claimKeyRecord(
  key: string,
  value: { slug?: string | null; refusal?: string | null; detail?: string | null; cacheForSeconds?: number | null },
): Promise<ClaimKeyRecord> {
  const slug = value.slug ?? null;
  const refusal = value.refusal ?? null;
  const detail = value.detail ?? null;
  const ttl = refusal ? Math.max(60, value.cacheForSeconds ?? 86_400) : null;
  if (!PERSISTENT) {
    const existing = memClaimKeys.get(key);
    if (existing && !(existing.expiresAt !== null && Date.now() > existing.expiresAt)) {
      return { slug: existing.slug, refusal: existing.refusal, detail: existing.detail, expired: false };
    }
    memClaimKeys.set(key, { slug, refusal, detail, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
    return { slug, refusal, detail, expired: false };
  }
  await ensureSchema();
  // ON CONFLICT re-reads rather than overwrites, EXCEPT where the stored row is
  // an expired refusal: that one is genuinely stale and the fresh answer
  // replaces it.
  const { rows } = await db().query<{ slug: string | null; refusal: string | null; detail: string | null }>(
    `INSERT INTO api_claim_key (key, slug, refusal, detail, expires_at)
     VALUES ($1,$2,$3,$4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5 || ' seconds')::interval END)
     ON CONFLICT (key) DO UPDATE
       SET slug = EXCLUDED.slug, refusal = EXCLUDED.refusal, detail = EXCLUDED.detail,
           expires_at = EXCLUDED.expires_at, created_at = now()
       WHERE api_claim_key.expires_at IS NOT NULL AND api_claim_key.expires_at < now()
     RETURNING slug, refusal, detail`,
    [key, slug, refusal, detail, ttl],
  );
  // No row back means the conflict target existed and the WHERE refused the
  // update, so somebody else's answer stands. Read it.
  if (rows[0]) return { ...rows[0], expired: false };
  const settled = await claimKeyLookup(key);
  return settled ?? { slug, refusal, detail, expired: false };
}

/**
 * Take one token from a caller's bucket for one group.
 *
 * Refills continuously rather than on a schedule, so there is nothing to run
 * and no edge at the top of the hour. Returns how long to wait when empty,
 * which becomes the Retry-After header: a caller guessing at backoff either
 * wastes requests or delivers late.
 */
export async function takeQuotaToken(
  apiKey: string, scope: string, opts: { capacity: number; perHour: number },
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  // The key is hashed so it never lands in a table or a log line.
  const bucket = `${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}:${scope}`;
  const { capacity, perHour } = opts;
  const perSecond = perHour / 3600;

  if (!PERSISTENT) {
    const now = Date.now();
    const cur = memQuota.get(bucket) ?? { tokens: capacity, at: now };
    const tokens = Math.min(capacity, cur.tokens + ((now - cur.at) / 1000) * perSecond);
    if (tokens < 1) {
      memQuota.set(bucket, { tokens, at: now });
      return { ok: false, retryAfterSeconds: Math.ceil((1 - tokens) / perSecond) };
    }
    memQuota.set(bucket, { tokens: tokens - 1, at: now });
    return { ok: true };
  }
  await ensureSchema();
  // One statement, so two replicas cannot both read a full bucket and both
  // spend it. The refill is computed from the row's own timestamp inside the
  // same write that spends the token.
  const { rows } = await db().query<{ tokens: number }>(
    `INSERT INTO api_quota (bucket, tokens, updated_at) VALUES ($1, $2 - 1, now())
     ON CONFLICT (bucket) DO UPDATE
       SET tokens = LEAST($2::float8, api_quota.tokens + EXTRACT(EPOCH FROM (now() - api_quota.updated_at)) * $3::float8) - 1,
           updated_at = now()
     WHERE LEAST($2::float8, api_quota.tokens + EXTRACT(EPOCH FROM (now() - api_quota.updated_at)) * $3::float8) >= 1
     RETURNING tokens`,
    [bucket, capacity, perSecond],
  );
  if (rows[0]) return { ok: true };
  // The WHERE refused, so the bucket is below one token. Read how far below to
  // answer honestly instead of guessing.
  const { rows: cur } = await db().query<{ tokens: number }>(
    `SELECT LEAST($2::float8, tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * $3::float8) AS tokens
       FROM api_quota WHERE bucket = $1`, [bucket, capacity, perSecond],
  );
  const have = cur[0]?.tokens ?? 0;
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - have) / perSecond)) };
}

const memQuota = new Map<string, { tokens: number; at: number }>();

/** Test seam: clear the bot API's ledgers. */
export function _resetApiLedgers(): void {
  memClaimKeys.clear();
  memQuota.clear();
}

/** One caller's namespace. The bearer key is hashed so it never lands in a row
 *  or a log line, and every ledger read and write goes through here. */
export function callerScope(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

/** The hash a refusal is remembered by. Normalised first, so the same claim
 *  with different spacing or casing is the same claim. */
export function claimTextHash(text: string): string {
  return createHash("sha256").update(text.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex");
}

/**
 * Has this exact claim already been refused?
 *
 * Separate from the idempotency ledger on purpose. That one answers "what did
 * THIS key produce"; this one answers "have we already paid to learn that these
 * words cannot be settled". The second question is the one that saves money,
 * because the caller picks the key and can rotate it, but cannot change what
 * the claim says.
 */
export async function refusalForText(text: string): Promise<{ reason: string; detail: string | null } | null> {
  const h = claimTextHash(text);
  if (!PERSISTENT) {
    const r = memRefusals.get(h);
    if (!r || Date.now() > r.expiresAt) return null;
    return { reason: r.reason, detail: r.detail };
  }
  await ensureSchema();
  const { rows } = await db().query<{ reason: string; detail: string | null }>(
    `SELECT reason, detail FROM api_refusal_text WHERE text_hash = $1 AND expires_at > now()`, [h],
  );
  return rows[0] ?? null;
}

export async function recordRefusalForText(text: string, reason: string, detail: string | null, ttlSeconds: number): Promise<void> {
  const h = claimTextHash(text);
  const ttl = Math.max(60, ttlSeconds);
  try {
    if (!PERSISTENT) { memRefusals.set(h, { reason, detail, expiresAt: Date.now() + ttl * 1000 }); return; }
    await ensureSchema();
    await db().query(
      `INSERT INTO api_refusal_text (text_hash, reason, detail, expires_at)
       VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval)
       ON CONFLICT (text_hash) DO UPDATE SET reason=EXCLUDED.reason, detail=EXCLUDED.detail, expires_at=EXCLUDED.expires_at`,
      [h, reason, detail, String(ttl)],
    );
  } catch (e) {
    console.error("[claims] refusal cache write failed (non-fatal):", (e as Error).message);
  }
}

const memRefusals = new Map<string, { reason: string; detail: string | null; expiresAt: number }>();

/**
 * Put a token back.
 *
 * A token is taken before the work so two replicas cannot both start it, but
 * several paths then do no work at all: the extractor being unreachable, a
 * market failing to open. Charging for those means an inference outage locks a
 * group out for half an hour on top of being an outage.
 */
export async function releaseQuotaToken(apiKey: string, scope: string, capacity: number): Promise<void> {
  const bucket = `${callerScope(apiKey)}:${scope}`;
  try {
    if (!PERSISTENT) {
      const cur = memQuota.get(bucket);
      if (cur) memQuota.set(bucket, { tokens: Math.min(capacity, cur.tokens + 1), at: cur.at });
      return;
    }
    await ensureSchema();
    await db().query(
      `UPDATE api_quota SET tokens = LEAST($2::float8, tokens + 1) WHERE bucket = $1`, [bucket, capacity],
    );
  } catch { /* a refund we could not make is not worth failing a request over */ }
}
