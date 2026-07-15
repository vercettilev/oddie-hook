import { createHash } from "node:crypto";
import pg from "pg";
import {
  STARTING_TOKENS, TOKEN_FLOOR, TOPUP_INTERVAL_MS,
  applyTopUp, edgePts, nextTopUpIn, proceedsFor, reputationOf, sharesFor,
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
-- Tokens are renewable now, and a new device gets a real bankroll. The default
-- is raised rather than the existing rows rewritten: a device that spent down
-- to 30 earned that 30, and the daily top-up is what carries it back up.
ALTER TABLE device_balance ALTER COLUMN tokens SET DEFAULT 1000;
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
 * Read a device's wallet, granting the daily top-up if one is due.
 *
 * The arithmetic lives in economy.ts and is unit-tested with an injected clock;
 * this function's only job is to persist what that function decided.
 *
 * The UPDATE is guarded on the WINDOW and the BALANCE, never on the timestamp's
 * value. An earlier version wrote `WHERE topped_up_at = $jsDate`, which reads
 * like an optimistic lock and is in fact a lock that never opens: Postgres keeps
 * timestamptz to the microsecond and a JS Date truncates to the millisecond, so
 * `...178902` was compared against `...178` and matched nothing. The grant was
 * computed, the UPDATE touched zero rows, `granted` came back 0, and no balance
 * would ever have risen — silently, for everyone, forever. Nothing in the
 * in-memory tests could see it, because that path compares numbers.
 *
 * Two tabs racing still produce one grant: the first sets topped_up_at = now(),
 * so the second's window predicate fails. If a call deducted a stake in between,
 * the `tokens = $prev` predicate fails instead and the grant simply waits for
 * the next read — a top-up that is one page-load late is not a bug; a top-up
 * that silently overwrites a stake is.
 */
export async function getWallet(rawDeviceId: string): Promise<Wallet> {
  const deviceId = await resolveDevice(rawDeviceId);
  const now = Date.now();

  if (!PERSISTENT) {
    const cur = memBalance.get(deviceId) ?? { tokens: STARTING_TOKENS, toppedUpAt: now };
    const next = applyTopUp(cur.tokens, cur.toppedUpAt, now);
    memBalance.set(deviceId, { tokens: next.tokens, toppedUpAt: next.toppedUpAt });
    return { tokens: next.tokens, floor: TOKEN_FLOOR, nextTopUpMs: nextTopUpIn(next.tokens, next.toppedUpAt, now), granted: next.granted };
  }

  await ensureSchema();
  await db().query(`INSERT INTO device_balance (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [deviceId]);
  const { rows } = await db().query<{ tokens: number; topped_up_at: Date }>(
    `SELECT tokens, topped_up_at FROM device_balance WHERE device_id = $1`,
    [deviceId],
  );
  const cur = rows[0];
  const next = applyTopUp(cur.tokens, cur.topped_up_at.getTime(), now);

  if (next.toppedUpAt !== cur.topped_up_at.getTime()) {
    const upd = await db().query<{ tokens: number; topped_up_at: Date }>(
      `UPDATE device_balance SET tokens = $1, topped_up_at = now()
        WHERE device_id = $2
          AND tokens = $3
          AND topped_up_at <= now() - make_interval(secs => $4)
       RETURNING tokens, topped_up_at`,
      [next.tokens, deviceId, cur.tokens, TOPUP_INTERVAL_MS / 1000],
    );
    if (upd.rows.length === 1) {
      const r = upd.rows[0];
      return {
        tokens: r.tokens,
        floor: TOKEN_FLOOR,
        nextTopUpMs: nextTopUpIn(r.tokens, r.topped_up_at.getTime(), now),
        granted: r.tokens - cur.tokens,
      };
    }
    // Someone else got there first, or a stake moved under us. Report the truth.
    const fresh = await db().query<{ tokens: number; topped_up_at: Date }>(
      `SELECT tokens, topped_up_at FROM device_balance WHERE device_id = $1`,
      [deviceId],
    );
    const r = fresh.rows[0];
    return { tokens: r.tokens, floor: TOKEN_FLOOR, nextTopUpMs: nextTopUpIn(r.tokens, r.topped_up_at.getTime(), now), granted: 0 };
  }
  return { tokens: cur.tokens, floor: TOKEN_FLOOR, nextTopUpMs: nextTopUpIn(cur.tokens, cur.topped_up_at.getTime(), now), granted: 0 };
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
    memBalance.set(deviceId, { tokens: w.tokens - tokens, toppedUpAt: memBalance.get(deviceId)!.toppedUpAt });
    rec.calls.push({ side, tokens, at: new Date().toISOString() });
    memCalls.unshift({
      id: ++memId, deviceId, slug: rec.slug, question: rec.market.question, side, tokens,
      entryPct: pctAt, at: new Date().toISOString(), closedAt: null, exitPct: null, proceeds: null,
    });
    return { ok: true, id: memId, balance: w.tokens - tokens, calls: rec.calls.length, pctAt };
  }

  await getWallet(deviceId); // ensure the row exists (and collect any top-up) first
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
export const EVENT_NAMES = ["feed_view", "card_view", "side_tap", "amount_confirm", "cat_change", "sell", "share_open", "share_done", "alerts_view", "notice_view", "allowlist_denied", "invite_sent", "invite_accepted", "taste_pick", "gate_shown", "gate_signin"] as const;
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
}

interface MemNotice extends Notice { deviceId: string }
const memNotices: MemNotice[] = [];
let memNoticeId = 0;

export async function noticesFor(rawDeviceId: string, limit = 30): Promise<Notice[]> {
  const deviceId = await resolveDevice(rawDeviceId);
  if (!PERSISTENT) {
    return memNotices.filter((n) => n.deviceId === deviceId).slice(0, limit)
      .map(({ deviceId: _d, ...n }) => n);
  }
  await ensureSchema();
  const { rows } = await db().query<{ id: number; kind: string; body: string; delta: number | null; slug: string | null; call_id: number | null; created_at: Date }>(
    `SELECT id, kind, body, delta, slug, call_id, created_at FROM notice WHERE device_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [deviceId, limit],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, body: r.body, delta: r.delta, slug: r.slug, callId: r.call_id, at: r.created_at.toISOString() }));
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
      pushNoticeMem(c.deviceId, slug, rec?.market.question ?? slug, outcome, c.side, proceeds, c.id, crowd);
      out.push({ callId: c.id, deviceId: c.deviceId, side: c.side, stake: c.tokens, entryPct: c.entryPct, exitPct, proceeds, edge: edgePts(c.entryPct, exitPct) });
    }
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
        [r.device_id, won ? "settle_win" : "settle_loss", noticeBody(question, outcome, r.side, r.proceeds, crowd), won ? r.proceeds : null, slug, r.id],
      );
    }
    await client.query("COMMIT");

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
};

interface CommunityMeta {
  slug: string;
  marketId: number;
  category: string;
  resolvedOutcome: "yes" | "no" | null;
  onchainPubkey: string | null;
  onchainSig: string | null;
}
const memCommunity = new Map<string, CommunityMeta>();

/** Create a community market (base slug + community row). Returns its slug and
 *  the numeric id used BOTH as the market's venueId and its on-chain market_id. */
export async function createCommunityMarket(input: {
  question: string;
  closeTime: number; // unix seconds
  category?: string;
  yesPct?: number; // starting odds; default 50
}): Promise<{ slug: string; marketId: number; market: Market }> {
  const marketId = Date.now(); // unique-per-ms; also the on-chain market_id (u64)
  const yesPct = Math.max(1, Math.min(99, Math.round(input.yesPct ?? 50)));
  const category = input.category?.trim() || "Community";
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
    });
    return { slug: rec.slug, marketId, market };
  }
  await ensureSchema();
  await db().query(
    `INSERT INTO community_market (slug, market_id, category) VALUES ($1,$2,$3)
     ON CONFLICT (slug) DO NOTHING`,
    [rec.slug, marketId, category],
  );
  return { slug: rec.slug, marketId, market };
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

/** Open (unresolved) community markets, Market-shaped + meta. Used for the feed
 *  AND to price plays (livePctOf needs the market in the "live" set). */
export async function openCommunityMarkets(): Promise<CommunityMarket[]> {
  if (!PERSISTENT) {
    const out: CommunityMarket[] = [];
    for (const meta of memCommunity.values()) {
      if (meta.resolvedOutcome) continue;
      const rec = mem.get(meta.slug);
      if (!rec) continue;
      out.push({ ...rec.market, marketId: meta.marketId, category: meta.category, onchainPubkey: meta.onchainPubkey, onchainSig: meta.onchainSig });
    }
    return out;
  }
  await ensureSchema();
  const { rows } = await db().query<{
    venue_id: string; question: string; yes_pct: number; closes_at: Date | null; volume_usd: number; venue_url: string;
    market_id: string; category: string; onchain_pubkey: string | null; onchain_sig: string | null;
  }>(`
    SELECT s.venue_id, s.question, s.yes_pct, s.closes_at, s.volume_usd, s.venue_url,
           c.market_id, c.category, c.onchain_pubkey, c.onchain_sig
      FROM community_market c JOIN market_slug s ON s.slug = c.slug
     WHERE c.resolved_outcome IS NULL
     ORDER BY c.created_at DESC`);
  return rows.map((r) => ({
    venue: "community", venueId: r.venue_id, question: r.question, yesPct: r.yes_pct,
    closesAt: r.closes_at ? r.closes_at.toISOString() : null, volumeUsd: Number(r.volume_usd),
    venueUrl: r.venue_url, tags: [], marketId: Number(r.market_id), category: r.category,
    onchainPubkey: r.onchain_pubkey, onchainSig: r.onchain_sig,
  }));
}

/** Every community market with resolution + on-chain state, for the /tool admin list. */
export async function adminListCommunity(): Promise<Array<{
  slug: string; question: string; yesPct: number; resolvedOutcome: "yes" | "no" | null; onchainPubkey: string | null; closesAt: string | null;
}>> {
  if (!PERSISTENT) {
    return [...memCommunity.values()].map((meta) => {
      const rec = mem.get(meta.slug)!;
      return { slug: meta.slug, question: rec.market.question, yesPct: rec.market.yesPct, resolvedOutcome: meta.resolvedOutcome, onchainPubkey: meta.onchainPubkey, closesAt: rec.market.closesAt };
    });
  }
  await ensureSchema();
  const { rows } = await db().query<{ slug: string; question: string; yes_pct: number; resolved_outcome: "yes" | "no" | null; onchain_pubkey: string | null; closes_at: Date | null }>(`
    SELECT c.slug, s.question, s.yes_pct, c.resolved_outcome, c.onchain_pubkey, s.closes_at
      FROM community_market c JOIN market_slug s ON s.slug = c.slug
     ORDER BY c.created_at DESC`);
  return rows.map((r) => ({ slug: r.slug, question: r.question, yesPct: r.yes_pct, resolvedOutcome: r.resolved_outcome, onchainPubkey: r.onchain_pubkey, closesAt: r.closes_at ? r.closes_at.toISOString() : null }));
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

function noticeBody(question: string, outcome: "yes" | "no", side: "yes" | "no", proceeds: number, crowd?: CrowdSplit): string {
  const won = side === outcome;
  return won
    ? `You were right on “${question}” — +${proceeds} tokens.${crowdClause(outcome, true, crowd)}`
    : `Market resolved ${outcome.toUpperCase()}: “${question}”. Your ${side.toUpperCase()} call didn't land.${crowdClause(outcome, false, crowd)}`;
}

function pushNoticeMem(deviceId: string, slug: string, question: string, outcome: "yes" | "no", side: "yes" | "no", proceeds: number, callId: number, crowd?: CrowdSplit): void {
  const won = side === outcome;
  memNotices.unshift({
    id: ++memNoticeId, deviceId, kind: won ? "settle_win" : "settle_loss",
    body: noticeBody(question, outcome, side, proceeds, crowd),
    delta: won ? proceeds : null, slug, callId, at: new Date().toISOString(),
  });
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
      resolved: c.exitPct === null ? null : c.exitPct === 100 ? c.side : c.exitPct === 0 ? (c.side === "yes" ? "no" : "yes") : "sold",
      handle: (memHandle.get(c.deviceId) ?? `#${c.deviceId.slice(0, 4)}`).replace(/^@+/, ""),
    };
  }
  await ensureSchema();
  const { rows } = await db().query<{
    slug: string; question: string; side: "yes" | "no"; pct_at: number | null; exit_pct: number | null;
    volume_usd: number; device_id: string; handle: string | null; acct_handle: string | null;
  }>(
    `SELECT mc.slug, ms.question, mc.side, mc.pct_at, mc.exit_pct, ms.volume_usd, mc.device_id,
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
 * The gate: a device may PLAY only when it resolves to a Google account whose
 * email is on the allowlist. Everyone may still LOOK at a shared market page —
 * the share loop stays alive; the call button is what the velvet rope guards.
 */

const memAllowlist = new Map<string, { source: string; cohort: string; invitedAt: string | null; acceptedAt: string | null }>();
const memAllowlistX = new Map<string, { source: string; invitedAt: string | null; acceptedAt: string | null; handle: string | null }>();

export type Gate =
  | { allowed: true; email: string | null; identity: string; provider: "google" | "twitter"; justAccepted: boolean }
  | { allowed: false; reason: "signed_out" | "not_allowlisted"; email: string | null; identity: string | null; provider: "google" | "twitter" | null };

export async function gateFor(rawDeviceId: string): Promise<Gate> {
  const deviceId = await resolveDevice(rawDeviceId);

  if (!PERSISTENT) {
    const { _memAccounts } = await import("./accounts.js");
    const mine = _memAccounts.filter((a) => a.canonicalDevice === deviceId);
    const g = mine.find((a) => a.provider === "google" && a.email);
    const x = mine.find((a) => a.provider === "twitter");
    if (!g && !x) return { allowed: false, reason: "signed_out", email: null, identity: null, provider: null };
    const gEmail = g?.email ?? null;
    const xUid = x?.uid ?? null;
    const gRow = gEmail ? memAllowlist.get(gEmail.toLowerCase()) : undefined;
    const xRow = xUid ? memAllowlistX.get(xUid) : undefined;
    const row = gRow ?? xRow;
    // X first for the identity we echo back (the reputation thesis lives on X).
    const identity = x ? (x.handle ?? `@${x.uid}`) : gEmail!;
    const provider = x ? "twitter" as const : "google" as const;
    if (!row) return { allowed: false, reason: "not_allowlisted", email: gEmail, identity, provider };
    const fresh = !row.acceptedAt;
    if (!row.acceptedAt) row.acceptedAt = new Date().toISOString();
    return { allowed: true, email: gEmail, identity, provider, justAccepted: fresh };
  }

  await ensureSchema();
  // Every identity this browser's stream is signed in with.
  const accts = await db().query<{ provider: "google" | "twitter"; email: string | null; provider_uid: string; handle: string | null }>(
    `SELECT provider, email, provider_uid, handle FROM account WHERE canonical_device = $1 ORDER BY created_at`, [deviceId]);
  const g = accts.rows.find((a) => a.provider === "google" && a.email);
  const x = accts.rows.find((a) => a.provider === "twitter");
  if (!g && !x) return { allowed: false, reason: "signed_out", email: null, identity: null, provider: null };

  const gEmail = g?.email ?? "";
  const xUid = x?.provider_uid ?? "";
  const xHandle = (x?.handle ?? "").replace(/^@+/, "");
  const identity = x ? (x.handle ?? `@${x.provider_uid}`) : gEmail;
  const provider = x ? "twitter" as const : "google" as const;

  // One statement: match by Google email OR X uid OR X handle, and stamp
  // accepted_at exactly once (COALESCE). accepted-in-the-last-10s is the
  // invite_accepted signal. Empty params match nothing (emails/uids non-empty).
  const hit = await db().query<{ fresh: boolean }>(
    `UPDATE allowlist SET accepted_at = COALESCE(accepted_at, now())
      WHERE (email <> '' AND lower(email) = lower($1))
         OR ($2 <> '' AND x_uid = $2)
         OR ($3 <> '' AND lower(x_handle) = lower($3))
     RETURNING accepted_at > now() - interval '10 seconds' AS fresh`,
    [gEmail, xUid, xHandle]);
  if (hit.rows.length === 0) return { allowed: false, reason: "not_allowlisted", email: g?.email ?? null, identity, provider };
  return { allowed: true, email: g?.email ?? null, identity, provider, justAccepted: Boolean(hit.rows[0].fresh) };
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
