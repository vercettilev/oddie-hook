import { createHash } from "node:crypto";
import pg from "pg";
import {
  STARTING_TOKENS, TOKEN_FLOOR,
  DAILY_CLAIM, CLAIM_INTERVAL_MS, STREAK_WINDOW_MS,
  edgePts, proceedsFor, reputationOf, sharesFor,
  type Reputation,
} from "./economy.js";
import { categorizeText } from "../matching/categorize.js";
import { Market } from "../venues/types.js";
import { randomHandle, validateHandle } from "./handles.js";

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
-- A new device starts with one day's claim (200 = 4 calls at 50). Only the
-- DEFAULT changes, never the existing rows: ALTER COLUMN … SET DEFAULT changes
-- future inserts only, so a device that spent down to 30 keeps its 30 — the
-- daily claim carries it up.
ALTER TABLE device_balance ALTER COLUMN tokens SET DEFAULT 200;
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
  provider         text NOT NULL CHECK (provider IN ('google','twitter')),
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
`;

let pool: pg.Pool | null = null;
let schemaReady: Promise<void> | null = null;

function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  return pool;
}

/** Idempotent, runs once per process. Three queries do not need a migration tool. */
function ensureSchema(): Promise<void> {
  schemaReady ??= db()
    .query(DDL)
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
    if (hit) return hit;
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

export { STARTING_TOKENS, TOKEN_FLOOR, PROVISIONAL_BELOW } from "./economy.js";

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
  floor: number;
  /** Milliseconds until the next grant, or null when the device is at the floor. */
  nextTopUpMs: number | null;
  /** Tokens handed over by the top-up this very call. Zero on almost every read. */
  granted: number;
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
  const cur = memBalance.get(deviceId) ?? { tokens: STARTING_TOKENS, toppedUpAt: Date.now() };
  memBalance.set(deviceId, { ...cur, tokens: cur.tokens + tokens });
}

/**
 * Read a device's wallet. Coins no longer accrue passively here — the daily
 * grant is an ACTIVE claim (claimStatus/claimDaily), so this only ensures the
 * row exists and reports the balance. `nextTopUpMs` stays in the shape (null)
 * so callers/clients that read it don't break; the countdown moved to the claim.
 */
export async function getWallet(rawDeviceId: string): Promise<Wallet> {
  const deviceId = await resolveDevice(rawDeviceId);

  if (!PERSISTENT) {
    const cur = memBalance.get(deviceId) ?? { tokens: STARTING_TOKENS, toppedUpAt: Date.now() };
    if (!memBalance.has(deviceId)) memBalance.set(deviceId, cur);
    return { tokens: cur.tokens, floor: TOKEN_FLOOR, nextTopUpMs: null, granted: 0 };
  }

  await ensureSchema();
  await db().query(`INSERT INTO device_balance (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [deviceId]);
  const { rows } = await db().query<{ tokens: number }>(`SELECT tokens FROM device_balance WHERE device_id = $1`, [deviceId]);
  return { tokens: rows[0].tokens, floor: TOKEN_FLOOR, nextTopUpMs: null, granted: 0 };
}

// --- Daily claim: the active retention hook ---------------------------------
const memClaim = new Map<string, { lastClaimAt: number | null; streak: number }>();

export interface ClaimStatus {
  claimable: boolean;
  nextClaimMs: number | null; // until the next claim opens; null when claimable now
  streak: number;             // EFFECTIVE streak (0 if a day was missed)
  amount: number;             // what a claim grants
  lastClaimAt: string | null;
}
export interface ClaimResult extends ClaimStatus { granted: number; balance: number }

/** Pure: from the last-claim time + stored streak, what the client should see. */
function computeClaim(lastMs: number | null, streak: number, now: number): Omit<ClaimStatus, "lastClaimAt"> {
  const claimable = lastMs === null || now - lastMs >= CLAIM_INTERVAL_MS;
  const nextClaimMs = claimable ? null : Math.max(0, lastMs! + CLAIM_INTERVAL_MS - now);
  // A missed day (no claim within the streak window) reads as a broken streak,
  // even before the next claim formally resets it to 1.
  const effStreak = lastMs !== null && now - lastMs < STREAK_WINDOW_MS ? streak : 0;
  return { claimable, nextClaimMs, streak: effStreak, amount: DAILY_CLAIM };
}

export async function claimStatus(rawDeviceId: string): Promise<ClaimStatus> {
  const deviceId = await resolveDevice(rawDeviceId);
  const now = Date.now();
  if (!PERSISTENT) {
    const c = memClaim.get(deviceId) ?? { lastClaimAt: null, streak: 0 };
    return { ...computeClaim(c.lastClaimAt, c.streak, now), lastClaimAt: c.lastClaimAt ? new Date(c.lastClaimAt).toISOString() : null };
  }
  await ensureSchema();
  await db().query(`INSERT INTO device_balance (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [deviceId]);
  const { rows } = await db().query<{ last_claim_at: Date | null; claim_streak: number }>(
    `SELECT last_claim_at, claim_streak FROM device_balance WHERE device_id = $1`, [deviceId]);
  const last = rows[0]?.last_claim_at ? rows[0].last_claim_at.getTime() : null;
  return { ...computeClaim(last, rows[0]?.claim_streak ?? 0, now), lastClaimAt: last ? new Date(last).toISOString() : null };
}

/** Collect the daily grant. Idempotent within a window (a double-tap grants
 *  once); continues the streak if within the window, else resets it to 1. The
 *  balance is never reset — only the streak. */
export async function claimDaily(rawDeviceId: string): Promise<ClaimResult> {
  const deviceId = await resolveDevice(rawDeviceId);
  const now = Date.now();
  if (!PERSISTENT) {
    const bal = memBalance.get(deviceId) ?? { tokens: STARTING_TOKENS, toppedUpAt: now };
    if (!memBalance.has(deviceId)) memBalance.set(deviceId, bal);
    const c = memClaim.get(deviceId) ?? { lastClaimAt: null, streak: 0 };
    const st = computeClaim(c.lastClaimAt, c.streak, now);
    if (!st.claimable) return { ...st, lastClaimAt: c.lastClaimAt ? new Date(c.lastClaimAt).toISOString() : null, granted: 0, balance: bal.tokens };
    const newStreak = c.lastClaimAt !== null && now - c.lastClaimAt < STREAK_WINDOW_MS ? c.streak + 1 : 1;
    bal.tokens += DAILY_CLAIM;
    memClaim.set(deviceId, { lastClaimAt: now, streak: newStreak });
    return { claimable: false, nextClaimMs: CLAIM_INTERVAL_MS, streak: newStreak, amount: DAILY_CLAIM, lastClaimAt: new Date(now).toISOString(), granted: DAILY_CLAIM, balance: bal.tokens };
  }
  await ensureSchema();
  await db().query(`INSERT INTO device_balance (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [deviceId]);
  // Atomic: grant + streak bump only if the window has elapsed. A concurrent
  // double-tap fails the WHERE on the second and grants nothing.
  const { rows } = await db().query<{ tokens: number; claim_streak: number; last_claim_at: Date }>(
    `UPDATE device_balance SET
        tokens = tokens + $2,
        claim_streak = CASE WHEN last_claim_at IS NOT NULL AND last_claim_at > now() - make_interval(secs => $3)
                            THEN claim_streak + 1 ELSE 1 END,
        last_claim_at = now()
      WHERE device_id = $1
        AND (last_claim_at IS NULL OR last_claim_at <= now() - make_interval(secs => $4))
      RETURNING tokens, claim_streak, last_claim_at`,
    [deviceId, DAILY_CLAIM, STREAK_WINDOW_MS / 1000, CLAIM_INTERVAL_MS / 1000],
  );
  if (rows.length === 1) {
    const r = rows[0];
    return { claimable: false, nextClaimMs: CLAIM_INTERVAL_MS, streak: r.claim_streak, amount: DAILY_CLAIM, lastClaimAt: r.last_claim_at.toISOString(), granted: DAILY_CLAIM, balance: r.tokens };
  }
  // Already claimed within the window — report current state, no grant.
  const [st, w] = await Promise.all([claimStatus(deviceId), getWallet(deviceId)]);
  return { ...st, granted: 0, balance: w.tokens };
}

/** Tokens only. Kept for callers that do not care about the top-up. */
export async function getBalance(deviceId: string): Promise<number> {
  return (await getWallet(deviceId)).tokens;
}

export type PlaceResult =
  | { ok: true; id: number; balance: number; calls: number; pctAt: number }
  | { ok: false; reason: "insufficient"; balance: number }
  | { ok: false; reason: "unknown-market" }
  | { ok: false; reason: "unpriced" };

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
    const firstEver = !memCalls.some((c) => c.deviceId === deviceId); // before this call lands
    memBalance.set(deviceId, { tokens: w.tokens - tokens, toppedUpAt: memBalance.get(deviceId)!.toppedUpAt });
    rec.calls.push({ side, tokens, at: new Date().toISOString() });
    memCalls.unshift({
      id: ++memId, deviceId, slug: rec.slug, question: rec.market.question, side, tokens,
      entryPct: pctAt, at: new Date().toISOString(), closedAt: null, exitPct: null, proceeds: null,
    });
    const distinct = new Set(memCalls.filter((c) => c.slug === rec.slug && c.deviceId).map((c) => c.deviceId)).size;
    void awardParticipation(rec.slug, deviceId, firstEver, distinct);
    void notifyOppositeSide(rec.slug, rec.market.question, deviceId, side);
    return { ok: true, id: memId, balance: w.tokens - tokens, calls: rec.calls.length, pctAt };
  }

  await getWallet(deviceId); // ensure the row exists (and collect any top-up) first
  // Is this the device's first-ever call? Read BEFORE the insert (best-effort;
  // a read failure just means no first-timer award, never a blocked call).
  const firstEver = await db().query<{ e: boolean }>(
    `SELECT NOT EXISTS(SELECT 1 FROM market_call WHERE device_id=$1) AS e`, [deviceId],
  ).then((r) => r.rows[0]?.e === true).catch(() => false);
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
    return { ok: true, id: ins.rows[0].id, balance: upd.rows[0].tokens, calls: rec.calls.length, pctAt };
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
      valueNow: entryPct !== null && nowPct !== null ? proceedsFor(r.tokens, entryPct, nowPct) : null,
      toWin: entryPct ? Math.round(sharesFor(r.tokens, entryPct)) : 0,
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
}

/**
 * Ranked by average edge, not by tokens. Provisional players are listed and
 * marked rather than hidden — a leaderboard that only shows finished players
 * gives a new one nothing to climb toward — but they sort below everyone whose
 * number has settled, however lucky their first two scalps were.
 */
export async function leaderboard(limit = 20): Promise<LeaderRow[]> {
  let rows: { device_id: string; edges: number[]; handle: string | null }[];
  if (!PERSISTENT) {
    const byDev = new Map<string, number[]>();
    for (const c of memCalls) {
      if (!c.closedAt || c.exitPct === null) continue;
      byDev.set(c.deviceId, [...(byDev.get(c.deviceId) ?? []), edgePts(c.entryPct, c.exitPct)]);
    }
    rows = [...byDev.entries()].map(([device_id, edges]) => ({
      device_id, edges, handle: memHandle.get(device_id) ?? null,
    }));
  } else {
    await ensureSchema();
    // The X handle outranks the chosen one and both outrank the stub, so the
    // board names people the way the rest of the product does.
    const q = await db().query<{ device_id: string; edges: number[]; handle: string | null }>(
      `SELECT mc.device_id,
              array_agg(mc.exit_pct - mc.pct_at) AS edges,
              COALESCE(tw.handle, db.handle) AS handle
         FROM market_call mc
         LEFT JOIN device_balance db ON db.device_id = mc.device_id
         LEFT JOIN LATERAL (
           SELECT a.handle FROM account a
            WHERE a.canonical_device = mc.device_id AND a.provider = 'twitter' AND a.handle IS NOT NULL
            ORDER BY a.created_at LIMIT 1
         ) tw ON true
        WHERE mc.device_id IS NOT NULL AND mc.closed_at IS NOT NULL AND mc.pct_at IS NOT NULL AND mc.exit_pct IS NOT NULL
        GROUP BY mc.device_id, tw.handle, db.handle`,
    );
    rows = q.rows;
  }

  // A board row without a name gets one minted on the spot — same generator,
  // same uniqueness — so devices from before handles existed never show a stub.
  for (const r of rows) {
    if (!r.handle) r.handle = await ensureHandle(r.device_id).catch(() => `#${r.device_id.slice(0, 4)}`);
  }

  return rows
    .map((r) => ({
      deviceId: r.device_id,
      // Stored X handles carry their own "@"; the UI prefixes one for everybody,
      // so strip it here or the board reads "@@levvercetti" (it did).
      handle: (r.handle ?? `#${r.device_id.slice(0, 4)}`).replace(/^@+/, ""),
      ...reputationOf(r.edges.map(Number)),
    }))
    .filter((r): r is LeaderRow => r.avgEdge !== null)
    .sort((a, b) => Number(a.provisional) - Number(b.provisional) || b.avgEdge - a.avgEdge)
    .slice(0, limit);
}

// --- Week-1 events ----------------------------------------------------------

/** The only names that are ever written. An unknown name is dropped, not stored. */
export const EVENT_NAMES = ["feed_view", "card_view", "side_tap", "amount_confirm", "cat_change", "sell", "share_open", "share_done", "alerts_view", "notice_view", "allowlist_denied", "invite_sent", "invite_accepted", "taste_pick", "gate_shown", "gate_signin", "challenge_click"] as const;
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
  // Calibration-adjusted reputation. meanEdge = mean(outcome − impliedProb): how
  // much the user beat the odds they took. Rewards correct low-prob calls, and
  // neutralises a safe favourite-only bettor to ~500. oddieScore = 500 + 1000·edge.
  oddieScore: number | null;  // 0..1000, 500 = matches the market; null until hasEnough
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
function computeAccuracy(rows: { correct: boolean; category: string; pct: number }[]): AccuracyRecord {
  const resolved = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  const hasEnough = resolved >= MIN_RESOLVED_FOR_ACCURACY;

  let cur = 0, best = 0;
  for (const r of rows) { if (r.correct) { cur++; if (cur > best) best = cur; } else cur = 0; }

  // Calibration-adjusted score: per pick, edge = outcome(1|0) − impliedProb.
  const meanEdge = resolved ? rows.reduce((a, r) => a + ((r.correct ? 1 : 0) - r.pct), 0) / resolved : 0;
  const oddieScore = clamp(Math.round(500 + 1000 * meanEdge), 0, 1000);

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
    accuracyPct: hasEnough ? Math.round((100 * correct) / resolved) : null,
    oddieScore: hasEnough ? oddieScore : null,
    meanEdge: hasEnough ? Math.round(meanEdge * 1000) / 1000 : null,
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

export async function accuracyFor(rawDeviceId: string): Promise<AccuracyRecord> {
  const deviceId = await resolveDevice(rawDeviceId);
  return computeAccuracy(await resolvedRowsFor(deviceId));
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
export async function weeklyScoreDeltaFor(rawDeviceId: string): Promise<WeeklyScoreDelta | null> {
  const deviceId = await resolveDevice(rawDeviceId);
  const rows = await resolvedRowsFor(deviceId);
  const cutoff = Date.now() - WEEK_MS;
  if (!rows.some((r) => Date.parse(r.closedAt) >= cutoff)) return null;

  const now = computeAccuracy(rows);
  if (now.oddieScore == null) return null; // still short of the accuracy floor even after this week
  const before = computeAccuracy(rows.filter((r) => Date.parse(r.closedAt) < cutoff));
  // Same neutral-500 fallback celebrationsFor uses for a baseline that predates
  // hasEnough — a device that crossed the accuracy floor THIS week started its
  // week at the neutral score, not at "no score".
  const baseline = before.hasEnough ? (before.oddieScore as number) : 500;
  const delta = now.oddieScore - baseline;
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

  const accRow = (r: CelebrationRow) => ({ correct: r.exitPct === 100, category: r.category, pct: prob(r.entryPct) });
  const out: Celebration[] = [];
  const slugsNeeded = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!unseenCallIds.has(r.callId)) continue;
    const before = computeAccuracy(rows.slice(0, i).map(accRow));
    const after = computeAccuracy(rows.slice(0, i + 1).map(accRow));
    const won = r.exitPct === 100;
    const outcome = won ? r.side : r.side === "yes" ? "no" : "yes";
    slugsNeeded.add(r.slug);
    out.push({
      noticeId: noticeIdByCall.get(r.callId)!,
      callId: r.callId, slug: r.slug, question: r.question, side: r.side, outcome, won,
      oddsPct: Math.max(1, Math.min(99, Math.round(r.entryPct))),
      proceeds: won ? r.proceeds : null,
      scoreBefore: before.hasEnough ? (before.oddieScore as number) : 500,
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
export async function markCelebrationsSeen(rawDeviceId: string, noticeIds: number[]): Promise<void> {
  const deviceId = await resolveDevice(rawDeviceId);
  const ids = [...new Set(noticeIds)].filter((n) => Number.isInteger(n));
  if (!ids.length) return;
  if (!PERSISTENT) {
    const now = new Date().toISOString();
    for (const n of memNotices) if (n.deviceId === deviceId && ids.includes(n.id)) n.seenAt = now;
    return;
  }
  await ensureSchema();
  await db().query(
    `UPDATE notice SET seen_at = now() WHERE device_id = $1 AND id = ANY($2) AND seen_at IS NULL`,
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
        if (c.exitPct !== 100 || !c.deviceId) continue;
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
  /** Points paid out to winners in the rolling last 24h — settlement proceeds
   *  only, so it means "earned by being right", not "handed out by the faucet". */
  pointsWonToday: number;
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
      pointsWonToday: memCalls.reduce(
        (a, c) => a + (c.closedAt && Date.parse(c.closedAt) >= cutoff && c.proceeds ? c.proceeds : 0), 0),
    };
  }
  await ensureSchema();
  const { rows } = await db().query<{ markets_open: number; calls_today: number; points_won_today: number }>(
    `SELECT
       (SELECT count(*)::int FROM community_market WHERE resolved_outcome IS NULL) AS markets_open,
       (SELECT count(*)::int FROM market_call
          WHERE device_id IS NOT NULL AND at >= now() - interval '24 hours')      AS calls_today,
       (SELECT coalesce(sum(proceeds), 0)::int FROM market_call
          WHERE proceeds > 0 AND closed_at >= now() - interval '24 hours')        AS points_won_today`,
  );
  const r = rows[0];
  return {
    marketsOpen: Number(r?.markets_open ?? 0),
    callsToday: Number(r?.calls_today ?? 0),
    pointsWonToday: Number(r?.points_won_today ?? 0),
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
  label: string;      // the screenshot-friendly line, e.g. "Top 10% · Crypto"
  emoji: string;      // UI only; the PNG card renders text (resvg has no emoji font)
  detail?: string;    // small subtitle under the label
}
export interface SeasonRank { rank: number; total: number; topPct: number; }

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
  const val = computeStandings(rows);
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
  return { rank, total, topPct: Math.max(1, Math.ceil((rank / total) * 100)) };
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
    if (pctile <= CATEGORY_TOP_PCT) cat.push({ id: `cat-${category}`, kind: "category", label: `Top ${CATEGORY_TOP_PCT}% · ${category}`, emoji: "🎯", detail: `${list[i].deviceId === deviceId ? Math.round(list[i].pct * 100) : 0}% accuracy` });
  }
  cat.sort((a, b) => a.label.localeCompare(b.label));
  badges.push(...cat.slice(0, 3));

  return badges;
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
      const proceeds = proceedsFor(c.tokens, c.entryPct, exitPct);
      c.closedAt = new Date().toISOString();
      c.exitPct = exitPct;
      c.proceeds = proceeds;
      const w = memBalance.get(c.deviceId) ?? { tokens: STARTING_TOKENS, toppedUpAt: Date.now() };
      memBalance.set(c.deviceId, { ...w, tokens: w.tokens + proceeds });
      pushNoticeMem(c.deviceId, slug, rec?.market.question ?? slug, outcome, c.side, c.entryPct, proceeds, c.id, crowd);
      out.push({ callId: c.id, deviceId: c.deviceId, side: c.side, stake: c.tokens, entryPct: c.entryPct, exitPct, proceeds, edge: edgePts(c.entryPct, exitPct) });
    }
    void awardCleanResolve(slug); // +50 to the surfacer: clean resolution
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
    // arithmetic mirrors economy.proceedsFor exactly: round(stake * 100 / entry)
    // for the winning side, 0 for the losing one.
    const closed = await client.query<{
      id: number; device_id: string | null; side: "yes" | "no"; tokens: number; pct_at: number; exit_pct: number; proceeds: number;
    }>(
      `UPDATE market_call SET
         closed_at = now(),
         exit_pct  = CASE WHEN side = $2 THEN 100 ELSE 0 END,
         proceeds  = CASE WHEN side = $2 THEN CAST(round(tokens * 100.0 / pct_at) AS integer) ELSE 0 END
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
    await client.query("COMMIT");

    void awardCleanResolve(slug); // +50 to the surfacer: clean resolution (post-commit, best-effort)
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
}
const memCommunity = new Map<string, CommunityMeta>();

// In-memory mirrors of market_surfacer and season_points_log (the mem backend
// tests run against). Same shape as the tables above.
interface MemSurfacer { handle: string | null; deviceId: string | null; sourceUrl: string | null; createdAt: string }
const memSurfacer = new Map<string, MemSurfacer>();
interface MemSeasonRow { deviceId: string | null; handle: string | null; event: string; amount: number; slug: string | null; dedupKey: string; createdAt: string }
const memSeasonLog: MemSeasonRow[] = [];

/** Create a community market (base slug + community row). Returns its slug and
 *  the numeric id used BOTH as the market's venueId and its on-chain market_id. */
export async function createCommunityMarket(input: {
  question: string;
  closeTime: number; // unix seconds
  category?: string;
  yesPct?: number; // starting odds; default 50
  resolutionCriteria?: string | null; // the "Resolves by: …" rules bettors see
  resolvability?: string | null; // gate grade: clean | fuzzy | unresolvable
}): Promise<{ slug: string; marketId: number; market: Market }> {
  const marketId = Date.now(); // unique-per-ms; also the on-chain market_id (u64)
  const yesPct = Math.max(1, Math.min(99, Math.round(input.yesPct ?? 50)));
  const category = input.category?.trim() || "Community";
  const resolutionCriteria = input.resolutionCriteria?.trim() || null;
  const resolvability = input.resolvability?.trim() || null;
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
      resolutionCriteria, resolvability,
    });
    return { slug: rec.slug, marketId, market };
  }
  await ensureSchema();
  await db().query(
    `INSERT INTO community_market (slug, market_id, category, resolution_criteria, resolvability)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (slug) DO NOTHING`,
    [rec.slug, marketId, category, resolutionCriteria, resolvability],
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
} as const;
export type SeasonEvent = keyof typeof SEASON_POINTS;

/** Pull the tweet author's handle out of a status URL (x.com / twitter.com).
 *  Lowercased, no "@". Null when the URL isn't a recognisable tweet permalink —
 *  an operator-created market with no identifiable contributor earns nothing. */
export function handleFromSourceUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = String(url).match(/(?:^|\/\/)(?:www\.)?(?:x|twitter|fixupx|vxtwitter)\.com\/([A-Za-z0-9_]{1,15})\/status\//i);
  return m ? m[1].toLowerCase() : null;
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
  const { rows } = await db().query<{ device_id: string }>(
    `SELECT canonical_device AS device_id FROM account
       WHERE provider='twitter' AND lower(handle)=$1 ORDER BY created_at LIMIT 1`, [h]);
  if (rows[0]) return rows[0].device_id;
  const { rows: r2 } = await db().query<{ device_id: string }>(
    `SELECT device_id FROM device_balance WHERE lower(handle)=$1 LIMIT 1`, [h]);
  return r2[0]?.device_id ?? null;
}

/** Record who surfaced a market — once per slug (the first writer wins). Safe to
 *  call repeatedly (every reply generation does). Resolves the handle→device at
 *  write time as a convenience; awards resolve again in case they sign up later. */
export async function recordSurfacer(slug: string, input: { handle?: string | null; deviceId?: string | null; sourceUrl?: string | null }): Promise<void> {
  const handle = (input.handle ?? handleFromSourceUrl(input.sourceUrl))?.replace(/^@+/, "").toLowerCase() ?? null;
  const sourceUrl = input.sourceUrl ?? null;
  const deviceId = input.deviceId ?? (await deviceForTwitterHandle(handle).catch(() => null));
  if (!handle && !deviceId) return; // no identifiable contributor — nothing to record
  if (!PERSISTENT) {
    if (!memSurfacer.has(slug)) memSurfacer.set(slug, { handle, deviceId, sourceUrl, createdAt: new Date().toISOString() });
    return;
  }
  await ensureSchema();
  await db().query(
    `INSERT INTO market_surfacer (slug, handle, device_id, source_url)
     VALUES ($1,$2,$3,$4) ON CONFLICT (slug) DO NOTHING`,
    [slug, handle, deviceId, sourceUrl],
  );
}

export interface Surfacer { handle: string | null; deviceId: string | null }
export async function surfacerFor(slug: string): Promise<Surfacer | null> {
  if (!PERSISTENT) { const s = memSurfacer.get(slug); return s ? { handle: s.handle, deviceId: s.deviceId } : null; }
  await ensureSchema();
  const { rows } = await db().query<{ handle: string | null; device_id: string | null }>(
    `SELECT handle, device_id FROM market_surfacer WHERE slug=$1`, [slug]);
  return rows[0] ? { handle: rows[0].handle, deviceId: rows[0].device_id } : null;
}

export interface SurfacerInfo { handle: string | null; sourceUrl: string | null }
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
      out[slug] = { handle: s?.handle ?? null, sourceUrl: s?.sourceUrl ?? null };
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; handle: string | null; source_url: string | null }>(
    `SELECT slug, handle, source_url FROM market_surfacer WHERE slug = ANY($1)`, [slugs]);
  for (const r of rows) out[r.slug] = { handle: r.handle, sourceUrl: r.source_url };
  for (const s of slugs) out[s] ??= { handle: null, sourceUrl: null };
  return out;
}

/** The one idempotent write. Credits `slug`'s surfacer (resolving handle→device
 *  freshly, so a contributor who signed up AFTER surfacing still gets the row
 *  attributed to their device). No surfacer, or an amount already logged under
 *  the dedup key, is a silent no-op. Best-effort: never throws into the caller.
 *  Returns whether a new award landed. */
async function awardSeasonPoints(event: SeasonEvent, slug: string, dedupKey: string): Promise<boolean> {
  try {
    const surfacer = await surfacerFor(slug);
    if (!surfacer) return false; // nobody to credit
    const amount = SEASON_POINTS[event];
    const handle = surfacer.handle;
    const deviceId = surfacer.deviceId ?? (await deviceForTwitterHandle(handle).catch(() => null));
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

/** The two placeCall-driven awards, fired best-effort after a call lands: the
 *  3-distinct-participants milestone and the newcomer's first-ever call. Both
 *  credit the market's surfacer; both are idempotent, so firing on every call is
 *  safe. Never throws — participation must never break placing a call. */
async function awardParticipation(slug: string, deviceId: string, firstEver: boolean, distinct: number): Promise<void> {
  try {
    if (distinct === 3) await awardThreePlayers(slug);
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
              SELECT lower(handle) FROM account WHERE provider='twitter' AND canonical_device=$1 AND handle IS NOT NULL
              UNION SELECT lower(handle) FROM device_balance WHERE device_id=$1 AND handle IS NOT NULL))`,
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
        tokens: memBalance.get(deviceId)?.tokens ?? STARTING_TOKENS,
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

/** Open (unresolved) community markets, Market-shaped + meta. Used for the feed
 *  AND to price plays (livePctOf needs the market in the "live" set). */
export async function openCommunityMarkets(): Promise<CommunityMarket[]> {
  if (!PERSISTENT) {
    const out: CommunityMarket[] = [];
    for (const meta of memCommunity.values()) {
      if (meta.resolvedOutcome) continue;
      const rec = mem.get(meta.slug);
      if (!rec) continue;
      out.push({ ...rec.market, marketId: meta.marketId, category: meta.category, onchainPubkey: meta.onchainPubkey, onchainSig: meta.onchainSig, resolutionCriteria: meta.resolutionCriteria, resolvability: meta.resolvability });
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{
    venue_id: string; question: string; yes_pct: number; closes_at: Date | null; volume_usd: number; venue_url: string;
    market_id: string; category: string; onchain_pubkey: string | null; onchain_sig: string | null;
    resolution_criteria: string | null; resolvability: string | null;
  }>(`
    SELECT s.venue_id, s.question, s.yes_pct, s.closes_at, s.volume_usd, s.venue_url,
           c.market_id, c.category, c.onchain_pubkey, c.onchain_sig, c.resolution_criteria, c.resolvability
      FROM community_market c JOIN market_slug s ON s.slug = c.slug
     WHERE c.resolved_outcome IS NULL
     ORDER BY c.created_at DESC`);
  return rows.map((r) => ({
    venue: "community", venueId: r.venue_id, question: r.question, yesPct: r.yes_pct,
    closesAt: r.closes_at ? r.closes_at.toISOString() : null, volumeUsd: Number(r.volume_usd),
    venueUrl: r.venue_url, tags: [], marketId: Number(r.market_id), category: r.category,
    onchainPubkey: r.onchain_pubkey, onchainSig: r.onchain_sig,
    resolutionCriteria: r.resolution_criteria, resolvability: r.resolvability,
  }));
}

export interface CommunityListItem {
  slug: string; question: string; yesPct: number;
  resolvedOutcome: "yes" | "no" | null; onchainPubkey: string | null; closesAt: string | null;
  yesTokens: number; noTokens: number; yesPlayers: number; noPlayers: number;
}

/** Every community market with resolution + on-chain state + pool totals, for the /tool admin panel. */
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
      };
    });
  }
  await ensureSchema();
  const { rows } = await db().query<{
    slug: string; question: string; yes_pct: number; resolved_outcome: "yes" | "no" | null; onchain_pubkey: string | null; closes_at: Date | null;
    yes_tokens: number; no_tokens: number; yes_players: number; no_players: number;
  }>(`
    SELECT c.slug, s.question, s.yes_pct, c.resolved_outcome, c.onchain_pubkey, s.closes_at,
           COALESCE(SUM(mc.tokens) FILTER (WHERE mc.side = 'yes'), 0)::int AS yes_tokens,
           COALESCE(SUM(mc.tokens) FILTER (WHERE mc.side = 'no'), 0)::int  AS no_tokens,
           COUNT(DISTINCT mc.device_id) FILTER (WHERE mc.side = 'yes')::int AS yes_players,
           COUNT(DISTINCT mc.device_id) FILTER (WHERE mc.side = 'no')::int  AS no_players
      FROM community_market c JOIN market_slug s ON s.slug = c.slug
      LEFT JOIN market_call mc ON mc.slug = c.slug
     GROUP BY c.slug, s.question, s.yes_pct, c.resolved_outcome, c.onchain_pubkey, s.closes_at, c.created_at
     ORDER BY c.created_at DESC`);
  return rows.map((r) => ({
    slug: r.slug, question: r.question, yesPct: r.yes_pct, resolvedOutcome: r.resolved_outcome,
    onchainPubkey: r.onchain_pubkey, closesAt: r.closes_at ? r.closes_at.toISOString() : null,
    yesTokens: r.yes_tokens, noTokens: r.no_tokens, yesPlayers: r.yes_players, noPlayers: r.no_players,
  }));
}

export interface CommunityDetailPosition {
  deviceId: string | null; side: "yes" | "no"; tokens: number; entryPct: number | null; closed: boolean; proceeds: number | null;
}
export interface CommunityMarketDetail {
  slug: string; question: string; closesAt: string | null; yesPct: number; marketId: number;
  resolvedOutcome: "yes" | "no" | null; onchainPubkey: string | null; onchainSig: string | null;
  resolutionCriteria: string | null; resolvability: string | null;
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
      resolutionCriteria: meta.resolutionCriteria, resolvability: meta.resolvability, positions,
    };
  }
  await ensureSchema();
  const meta = await db().query<{ question: string; yes_pct: number; closes_at: Date | null; market_id: string; resolved_outcome: "yes" | "no" | null; onchain_pubkey: string | null; onchain_sig: string | null; resolution_criteria: string | null; resolvability: string | null }>(`
    SELECT s.question, s.yes_pct, s.closes_at, c.market_id, c.resolved_outcome, c.onchain_pubkey, c.onchain_sig, c.resolution_criteria, c.resolvability
      FROM community_market c JOIN market_slug s ON s.slug = c.slug WHERE c.slug = $1`, [slug]);
  if (!meta.rows.length) return null;
  const m = meta.rows[0];
  const pos = await db().query<{ side: "yes" | "no"; tokens: number; device_id: string | null; pct_at: number | null; closed_at: Date | null; proceeds: number | null }>(`
    SELECT side, tokens, device_id, pct_at, closed_at, proceeds FROM market_call WHERE slug = $1 ORDER BY at ASC`, [slug]);
  return {
    slug, question: m.question, closesAt: m.closes_at ? m.closes_at.toISOString() : null, yesPct: m.yes_pct,
    marketId: Number(m.market_id), resolvedOutcome: m.resolved_outcome, onchainPubkey: m.onchain_pubkey, onchainSig: m.onchain_sig,
    resolutionCriteria: m.resolution_criteria, resolvability: m.resolvability,
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
    ? `You called “${question}” at ${odds}% — it resolved ${outcome.toUpperCase()}. You were right. +${proceeds} tokens.${crowdClause(outcome, true, crowd)}`
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
  return withHandles(out.slice(0, limit));
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
  return withHandles(out.slice(0, limit));
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
