/**
 * The store behind live calls (src/live/calls.ts): the channels that added
 * oddie, their calls, and every answer.
 *
 * The rules that matter are the database's, not a read's: one call taking
 * answers per channel is a partial unique index (any number may wait for their
 * result), one answer per person is the primary key,
 * and locking or settling a call is a conditional UPDATE that exactly one
 * caller wins. Two moderators, two webhook retries or two instances during a
 * deploy all meet the same answer.
 *
 * A channel's tokens are sealed before they are written (AES-256-GCM, key from
 * LIVE_TOKEN_KEY or the platform's client secret): a copy of the database is
 * not a way into anybody's chat.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { storeDb, storeSchema, STORE_PERSISTENT } from "./markets.js";
import { pointsAt, type LiveCall, type LiveStore, type Platform, type Side, type Tally } from "../live/calls.js";

const DDL = `
CREATE TABLE IF NOT EXISTS live_channel (
  platform          text NOT NULL,
  channel_id        text NOT NULL,
  slug              text NOT NULL,
  name              text,
  avatar            text,
  token_enc         text,
  refresh_enc       text,
  token_expires_at  timestamptz,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  active            boolean NOT NULL DEFAULT true,
  PRIMARY KEY (platform, channel_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS live_channel_slug_idx ON live_channel (platform, lower(slug));

CREATE TABLE IF NOT EXISTS live_call (
  id              bigserial PRIMARY KEY,
  platform        text NOT NULL,
  channel_id      text NOT NULL,
  question        text NOT NULL,
  opened_by_id    text,
  opened_by_name  text,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closes_at       timestamptz NOT NULL,
  locked_at       timestamptz,
  outcome         text CHECK (outcome IN ('yes','no')),
  settled_at      timestamptz,
  canceled_at     timestamptz,
  yes_count       int,
  no_count        int,
  points          int
);
-- A call opened with a length locks on its own; one without takes answers
-- until it is settled (8 Oct). Rows from before were all timed.
ALTER TABLE live_call ADD COLUMN IF NOT EXISTS timed boolean NOT NULL DEFAULT true;
-- ONE CALL TAKING ANSWERS PER CHANNEL, said by the database: two moderators
-- opening at the same moment get one call and one refusal. Calls waiting for
-- their result are not counted: a new call locks the running one and opens.
-- The old index counted every unsettled call; it goes, or the second call
-- waiting for a result would be refused. (Rolling back past this: settle or
-- cancel the extra waiting calls first, or the old index cannot be built.)
DROP INDEX IF EXISTS live_call_one_open;
CREATE UNIQUE INDEX IF NOT EXISTS live_call_one_voting ON live_call (platform, channel_id)
  WHERE locked_at IS NULL AND settled_at IS NULL AND canceled_at IS NULL;
CREATE INDEX IF NOT EXISTS live_call_due_idx ON live_call (closes_at) WHERE locked_at IS NULL AND settled_at IS NULL AND canceled_at IS NULL;

CREATE TABLE IF NOT EXISTS live_pick (
  call_id   bigint NOT NULL REFERENCES live_call(id) ON DELETE CASCADE,
  platform  text NOT NULL,
  user_id   text NOT NULL,
  username  text,
  side      text NOT NULL CHECK (side IN ('yes','no')),
  at        timestamptz NOT NULL DEFAULT now(),
  points    int,
  PRIMARY KEY (call_id, platform, user_id)
);
CREATE INDEX IF NOT EXISTS live_pick_user_idx ON live_pick (platform, user_id);
`;

let ready: Promise<void> | null = null;
async function schema(): Promise<void> {
  ready ??= (async () => { await storeSchema(); await storeDb().query(DDL); })().catch((e) => { ready = null; throw e; });
  return ready;
}

/* ------------------------------------------------------------- sealing -- */

function tokenKey(platform: Platform): Buffer | null {
  const raw = process.env.LIVE_TOKEN_KEY || (platform === "kick" ? process.env.KICK_CLIENT_SECRET : process.env.TWITCH_CLIENT_SECRET);
  return raw ? createHash("sha256").update(`oddie-live:${raw}`).digest() : null;
}

export function sealToken(platform: Platform, plain: string): string {
  const key = tokenKey(platform);
  if (!key) throw new Error("no key to seal a token with");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function openToken(platform: Platform, sealed: string | null): string | null {
  const key = tokenKey(platform);
  if (!key || !sealed) return null;
  try {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch { return null; }
}

/* ------------------------------------------------------------ channels -- */

export interface LiveChannel {
  platform: Platform; channelId: string; slug: string; name: string | null; avatar: string | null;
  accessToken: string | null; refreshToken: string | null; tokenExpiresAt: number | null; active: boolean;
}

const memChannels = new Map<string, LiveChannel>();
const ck = (p: Platform, id: string) => `${p}:${id}`;

export async function saveChannel(ch: LiveChannel): Promise<void> {
  if (!STORE_PERSISTENT) { memChannels.set(ck(ch.platform, ch.channelId), { ...ch }); return; }
  await schema();
  await storeDb().query(
    `INSERT INTO live_channel (platform, channel_id, slug, name, avatar, token_enc, refresh_enc, token_expires_at, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (platform, channel_id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, avatar = EXCLUDED.avatar,
       token_enc = EXCLUDED.token_enc, refresh_enc = EXCLUDED.refresh_enc, token_expires_at = EXCLUDED.token_expires_at,
       active = EXCLUDED.active, connected_at = now()`,
    [ch.platform, ch.channelId, ch.slug, ch.name, ch.avatar,
     ch.accessToken ? sealToken(ch.platform, ch.accessToken) : null,
     ch.refreshToken ? sealToken(ch.platform, ch.refreshToken) : null,
     ch.tokenExpiresAt ? new Date(ch.tokenExpiresAt) : null, ch.active]);
}

type ChannelRow = { platform: Platform; channel_id: string; slug: string; name: string | null; avatar: string | null;
  token_enc: string | null; refresh_enc: string | null; token_expires_at: Date | null; active: boolean };
const fromRow = (r: ChannelRow): LiveChannel => ({
  platform: r.platform, channelId: r.channel_id, slug: r.slug, name: r.name, avatar: r.avatar,
  accessToken: openToken(r.platform, r.token_enc), refreshToken: openToken(r.platform, r.refresh_enc),
  tokenExpiresAt: r.token_expires_at ? new Date(r.token_expires_at).getTime() : null, active: r.active,
});

export async function channelById(platform: Platform, channelId: string): Promise<LiveChannel | null> {
  if (!STORE_PERSISTENT) return memChannels.get(ck(platform, channelId)) ?? null;
  await schema();
  const { rows } = await storeDb().query<ChannelRow>(`SELECT * FROM live_channel WHERE platform = $1 AND channel_id = $2`, [platform, channelId]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function channelBySlug(platform: Platform, slug: string): Promise<LiveChannel | null> {
  const s = String(slug ?? "").toLowerCase();
  if (!STORE_PERSISTENT) return [...memChannels.values()].find((c) => c.platform === platform && c.slug.toLowerCase() === s) ?? null;
  await schema();
  const { rows } = await storeDb().query<ChannelRow>(`SELECT * FROM live_channel WHERE platform = $1 AND lower(slug) = $2`, [platform, s]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/* --------------------------------------------------------------- calls -- */

interface MemCall extends LiveCall { canceledAt: number | null; yesCount: number | null; noCount: number | null; points: number | null;
  openedById: string; openedByName: string }
interface MemPick { callId: string; platform: Platform; userId: string; username: string; side: Side; at: number; points: number | null }
const memCalls = new Map<string, MemCall>();
const memPicks: MemPick[] = [];
let memSeq = 0;

type CallRow = { id: string; platform: Platform; channel_id: string; question: string; opened_at: Date; closes_at: Date;
  timed: boolean | null; locked_at: Date | null; outcome: Side | null; settled_at: Date | null };
const callFrom = (r: CallRow): LiveCall => ({
  id: String(r.id), platform: r.platform, channelId: r.channel_id, question: r.question,
  openedAt: new Date(r.opened_at).getTime(), closesAt: new Date(r.closes_at).getTime(), timed: r.timed !== false,
  lockedAt: r.locked_at ? new Date(r.locked_at).getTime() : null, outcome: r.outcome,
  settledAt: r.settled_at ? new Date(r.settled_at).getTime() : null,
});
const CALL_COLS = `id, platform, channel_id, question, opened_at, closes_at, timed, locked_at, outcome, settled_at`;
const takingAnswers = (c: MemCall) => c.lockedAt === null && c.settledAt === null && c.canceledAt === null;

export const liveStore: LiveStore = {
  async current(platform, channelId) {
    if (!STORE_PERSISTENT) {
      const c = [...memCalls.values()].find((x) => x.platform === platform && x.channelId === channelId && takingAnswers(x));
      return c ? { ...c } : null;
    }
    await schema();
    const { rows } = await storeDb().query<CallRow>(
      `SELECT ${CALL_COLS} FROM live_call WHERE platform = $1 AND channel_id = $2 AND locked_at IS NULL AND settled_at IS NULL AND canceled_at IS NULL`, [platform, channelId]);
    return rows[0] ? callFrom(rows[0]) : null;
  },

  async unsettled(platform, channelId) {
    if (!STORE_PERSISTENT) {
      return [...memCalls.values()]
        .filter((c) => c.platform === platform && c.channelId === channelId && c.settledAt === null && c.canceledAt === null)
        .sort((a, b) => a.openedAt - b.openedAt || Number(a.id) - Number(b.id)).map((c) => ({ ...c }));
    }
    await schema();
    const { rows } = await storeDb().query<CallRow>(
      `SELECT ${CALL_COLS} FROM live_call WHERE platform = $1 AND channel_id = $2 AND settled_at IS NULL AND canceled_at IS NULL
        ORDER BY opened_at, id LIMIT 20`, [platform, channelId]);
    return rows.map(callFrom);
  },

  async open(i) {
    if (!STORE_PERSISTENT) {
      if (await this.current(i.platform, i.channelId)) return null;
      const id = String(++memSeq);
      const c: MemCall = { id, platform: i.platform, channelId: i.channelId, question: i.question, openedAt: i.openedAt, closesAt: i.closesAt,
        timed: i.timed, lockedAt: null, outcome: null, settledAt: null, canceledAt: null, yesCount: null, noCount: null, points: null,
        openedById: i.openedById, openedByName: i.openedByName };
      memCalls.set(id, c);
      return { ...c };
    }
    await schema();
    const { rows } = await storeDb().query<CallRow>(
      `INSERT INTO live_call (platform, channel_id, question, opened_by_id, opened_by_name, opened_at, closes_at, timed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING ${CALL_COLS}`,
      [i.platform, i.channelId, i.question, i.openedById, i.openedByName, new Date(i.openedAt), new Date(i.closesAt), i.timed]);
    return rows[0] ? callFrom(rows[0]) : null;
  },

  async pick(call, userId, username, side, at) {
    if (!STORE_PERSISTENT) {
      if (memPicks.some((p) => p.callId === call.id && p.platform === call.platform && p.userId === userId)) return false;
      memPicks.push({ callId: call.id, platform: call.platform, userId, username, side, at, points: null });
      return true;
    }
    await schema();
    // Only into a call that is still open: a lock that landed a moment ago wins.
    const { rowCount } = await storeDb().query(
      `INSERT INTO live_pick (call_id, platform, user_id, username, side, at)
       SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (SELECT 1 FROM live_call WHERE id = $1 AND locked_at IS NULL AND settled_at IS NULL AND canceled_at IS NULL)
       ON CONFLICT DO NOTHING`,
      [call.id, call.platform, userId, username, side, new Date(at)]);
    return (rowCount ?? 0) > 0;
  },

  async tally(callId) {
    if (!STORE_PERSISTENT) {
      const ps = memPicks.filter((p) => p.callId === callId);
      return { yes: ps.filter((p) => p.side === "yes").length, no: ps.filter((p) => p.side === "no").length };
    }
    await schema();
    const { rows } = await storeDb().query<{ yes: number; no: number }>(
      `SELECT count(*) FILTER (WHERE side = 'yes')::int AS yes, count(*) FILTER (WHERE side = 'no')::int AS no FROM live_pick WHERE call_id = $1`, [callId]);
    return rows[0] ?? { yes: 0, no: 0 };
  },

  async lock(callId, at) {
    if (!STORE_PERSISTENT) {
      const c = memCalls.get(callId);
      if (!c || c.lockedAt !== null || c.settledAt !== null || c.canceledAt !== null) return false;
      c.lockedAt = at;
      return true;
    }
    await schema();
    const { rowCount } = await storeDb().query(
      `UPDATE live_call SET locked_at = $2 WHERE id = $1 AND locked_at IS NULL AND settled_at IS NULL AND canceled_at IS NULL`, [callId, new Date(at)]);
    return (rowCount ?? 0) > 0;
  },

  async settle(callId, outcome, points, at) {
    if (!STORE_PERSISTENT) {
      const c = memCalls.get(callId);
      if (!c || c.settledAt !== null || c.canceledAt !== null) return null;
      const t = await this.tally(callId);
      Object.assign(c, { outcome, settledAt: at, lockedAt: c.lockedAt ?? at, yesCount: t.yes, noCount: t.no, points });
      let right = 0, top = 0;
      for (const p of memPicks) {
        if (p.callId !== callId) continue;
        p.points = p.side === outcome ? pointsAt(points, p.at - c.openedAt) : 0;
        if (p.side === outcome) { right++; top = Math.max(top, p.points); }
      }
      return { right, total: t.yes + t.no, top };
    }
    await schema();
    const client = await storeDb().connect();
    try {
      await client.query("BEGIN");
      const upd = await client.query<{ opened_at: Date }>(
        `UPDATE live_call SET outcome = $2, settled_at = $3, locked_at = COALESCE(locked_at, $3), points = $4,
                yes_count = (SELECT count(*) FROM live_pick WHERE call_id = $1 AND side = 'yes'),
                no_count  = (SELECT count(*) FROM live_pick WHERE call_id = $1 AND side = 'no')
          WHERE id = $1 AND settled_at IS NULL AND canceled_at IS NULL RETURNING opened_at`, [callId, outcome, new Date(at), points]);
      if (!upd.rowCount) { await client.query("ROLLBACK"); return null; }
      // Each right answer by how early it came: worked out here, with the same
      // pointsAt the memory store and the tests use, so there is one formula.
      const openedAt = new Date(upd.rows[0].opened_at).getTime();
      const { rows: picks } = await client.query<{ user_id: string; side: Side; at: Date }>(
        `SELECT user_id, side, at FROM live_pick WHERE call_id = $1`, [callId]);
      const scored = picks.map((p) => ({ id: p.user_id, pts: p.side === outcome ? pointsAt(points, new Date(p.at).getTime() - openedAt) : 0 }));
      if (scored.length) {
        await client.query(
          `UPDATE live_pick SET points = u.pts FROM unnest($2::text[], $3::int[]) AS u(user_id, pts)
            WHERE live_pick.call_id = $1 AND live_pick.user_id = u.user_id`,
          [callId, scored.map((x) => x.id), scored.map((x) => x.pts)]);
      }
      await client.query("COMMIT");
      const right = picks.filter((p) => p.side === outcome).length;
      return { right, total: picks.length, top: Math.max(0, ...scored.map((x) => x.pts)) };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { client.release(); }
  },

  async cancel(callId, at) {
    if (!STORE_PERSISTENT) {
      const c = memCalls.get(callId);
      if (!c || c.settledAt !== null || c.canceledAt !== null) return false;
      c.canceledAt = at;
      return true;
    }
    await schema();
    const { rowCount } = await storeDb().query(
      `UPDATE live_call SET canceled_at = $2 WHERE id = $1 AND settled_at IS NULL AND canceled_at IS NULL`, [callId, new Date(at)]);
    return (rowCount ?? 0) > 0;
  },

  async due(now) {
    if (!STORE_PERSISTENT) {
      return [...memCalls.values()].filter((c) => takingAnswers(c) && c.closesAt <= now).map((c) => ({ ...c }));
    }
    await schema();
    const { rows } = await storeDb().query<CallRow>(
      `SELECT ${CALL_COLS} FROM live_call WHERE locked_at IS NULL AND settled_at IS NULL AND canceled_at IS NULL AND closes_at <= $1 LIMIT 50`,
      [new Date(now)]);
    return rows.map(callFrom);
  },

  async everyUnsettled() {
    if (!STORE_PERSISTENT) {
      return [...memCalls.values()].filter((c) => c.settledAt === null && c.canceledAt === null)
        .sort((a, b) => a.openedAt - b.openedAt || Number(a.id) - Number(b.id)).map((c) => ({ ...c }));
    }
    await schema();
    const { rows } = await storeDb().query<CallRow>(
      `SELECT ${CALL_COLS} FROM live_call WHERE settled_at IS NULL AND canceled_at IS NULL ORDER BY opened_at LIMIT 500`);
    return rows.map(callFrom);
  },

  async takingAnswers() {
    if (!STORE_PERSISTENT) return [...memCalls.values()].filter(takingAnswers).map((c) => ({ ...c }));
    await schema();
    const { rows } = await storeDb().query<CallRow>(
      `SELECT ${CALL_COLS} FROM live_call WHERE locked_at IS NULL AND settled_at IS NULL AND canceled_at IS NULL ORDER BY opened_at LIMIT 200`);
    return rows.map(callFrom);
  },
};

/* ----------------------------------------------------------- the page -- */

export interface StandingRow { userId: string; username: string; points: number; right: number; calls: number }
export interface CallSummary { id: string; question: string; outcome: Side | null; yes: number; no: number; points: number | null;
  closesAt: number; lockedAt: number | null; settledAt: number | null }

/** A channel's standings: every settled call, summed per person. */
export async function channelStandings(platform: Platform, channelId: string, limit = 20): Promise<StandingRow[]> {
  if (!STORE_PERSISTENT) {
    const by = new Map<string, StandingRow>();
    for (const p of memPicks) {
      const c = memCalls.get(p.callId);
      if (!c || c.platform !== platform || c.channelId !== channelId || c.settledAt === null) continue;
      const r = by.get(p.userId) ?? { userId: p.userId, username: p.username, points: 0, right: 0, calls: 0 };
      r.points += p.points ?? 0; r.calls++; if ((p.points ?? 0) > 0) r.right++;
      by.set(p.userId, r);
    }
    return [...by.values()].sort((a, b) => b.points - a.points || b.right - a.right).slice(0, limit);
  }
  await schema();
  // right_count, never `right`: RIGHT is reserved in Postgres, and as a bare
  // ORDER BY term it is a syntax error. The page showed empty standings over
  // two scored calls on the first live test, and no memory test could see it.
  const { rows } = await storeDb().query<{ user_id: string; username: string; points: number; right_count: number; calls: number }>(
    `SELECT p.user_id, max(p.username) AS username, sum(COALESCE(p.points, 0))::int AS points,
            count(*) FILTER (WHERE p.points > 0)::int AS right_count, count(*)::int AS calls
       FROM live_pick p JOIN live_call c ON c.id = p.call_id
      WHERE c.platform = $1 AND c.channel_id = $2 AND c.settled_at IS NOT NULL
      GROUP BY p.user_id ORDER BY points DESC, right_count DESC LIMIT $3`, [platform, channelId, Math.max(1, Math.min(100, limit))]);
  return rows.map((r) => ({ userId: r.user_id, username: r.username, points: r.points, right: r.right_count, calls: r.calls }));
}

/**
 * THE LEADERBOARD: everybody's votes, across every channel (Lev, 8 Oct: the
 * board is the stream votes, not the X era's openers). A person is a
 * platform's user id, so a Twitch name and a Kick name are two rows, and each
 * row names the channel they last called in.
 */
export interface GlobalStandingRow extends StandingRow { platform: Platform; channel: string }
export async function allStandings(limit = 50): Promise<GlobalStandingRow[]> {
  const n = Math.max(1, Math.min(100, limit));
  if (!STORE_PERSISTENT) {
    const by = new Map<string, GlobalStandingRow & { lastAt: number }>();
    for (const p of memPicks) {
      const c = memCalls.get(p.callId);
      if (!c || c.settledAt === null) continue;
      const slug = memChannels.get(ck(c.platform, c.channelId))?.slug ?? c.channelId;
      const r = by.get(`${c.platform}:${p.userId}`)
        ?? { platform: c.platform, userId: p.userId, username: p.username, points: 0, right: 0, calls: 0, channel: slug, lastAt: -1 };
      r.points += p.points ?? 0; r.calls++; if ((p.points ?? 0) > 0) r.right++;
      if (c.settledAt >= r.lastAt) { r.lastAt = c.settledAt; r.channel = slug; }
      by.set(`${c.platform}:${p.userId}`, r);
    }
    return [...by.values()].sort((a, b) => b.points - a.points || b.right - a.right).slice(0, n)
      .map(({ lastAt: _at, ...r }) => r);
  }
  await schema();
  const { rows } = await storeDb().query<{ platform: Platform; user_id: string; username: string; points: number; right_count: number; calls: number; channel: string | null }>(
    `SELECT c.platform, p.user_id, max(p.username) AS username, sum(COALESCE(p.points, 0))::int AS points,
            count(*) FILTER (WHERE p.points > 0)::int AS right_count, count(*)::int AS calls,
            (array_agg(COALESCE(ch.slug, c.channel_id) ORDER BY c.settled_at DESC))[1] AS channel
       FROM live_pick p
       JOIN live_call c ON c.id = p.call_id
       LEFT JOIN live_channel ch ON ch.platform = c.platform AND ch.channel_id = c.channel_id
      WHERE c.settled_at IS NOT NULL
      GROUP BY c.platform, p.user_id ORDER BY points DESC, right_count DESC LIMIT $1`, [n]);
  return rows.map((r) => ({ platform: r.platform, userId: r.user_id, username: r.username, points: r.points, right: r.right_count,
    calls: r.calls, channel: r.channel ?? "" }));
}

/** The channel's latest calls, newest first, with their counts. */
export async function recentCalls(platform: Platform, channelId: string, limit = 10): Promise<CallSummary[]> {
  if (!STORE_PERSISTENT) {
    const out: CallSummary[] = [];
    for (const c of [...memCalls.values()].reverse()) {
      if (c.platform !== platform || c.channelId !== channelId || c.canceledAt !== null) continue;
      const t = await liveStore.tally(c.id);
      out.push({ id: c.id, question: c.question, outcome: c.outcome, yes: t.yes, no: t.no, points: c.points,
        closesAt: c.closesAt, lockedAt: c.lockedAt, settledAt: c.settledAt });
      if (out.length >= limit) break;
    }
    return out;
  }
  await schema();
  const { rows } = await storeDb().query<{ id: string; question: string; outcome: Side | null; yes: number; no: number; points: number | null;
    closes_at: Date; locked_at: Date | null; settled_at: Date | null }>(
    `SELECT c.id, c.question, c.outcome, c.points, c.closes_at, c.locked_at, c.settled_at,
            count(p.*) FILTER (WHERE p.side = 'yes')::int AS yes, count(p.*) FILTER (WHERE p.side = 'no')::int AS no
       FROM live_call c LEFT JOIN live_pick p ON p.call_id = c.id
      WHERE c.platform = $1 AND c.channel_id = $2 AND c.canceled_at IS NULL
      GROUP BY c.id ORDER BY c.opened_at DESC LIMIT $3`, [platform, channelId, Math.max(1, Math.min(50, limit))]);
  return rows.map((r) => ({ id: String(r.id), question: r.question, outcome: r.outcome, yes: r.yes, no: r.no, points: r.points,
    closesAt: new Date(r.closes_at).getTime(), lockedAt: r.locked_at ? new Date(r.locked_at).getTime() : null,
    settledAt: r.settled_at ? new Date(r.settled_at).getTime() : null }));
}

/** Test seam. */
export function _resetLiveStore(): void { memChannels.clear(); memCalls.clear(); memPicks.length = 0; memSeq = 0; }
