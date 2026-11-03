/**
 * The store behind invites (src/live/referrals.ts): which channel brought
 * which, and the payouts the admin records by hand against what is owed.
 *
 * The rule that matters is the database's: a channel is referred once, by its
 * primary key, and nothing ever changes who brought it (the insert does
 * nothing on a conflict). The terms are kept on the row, so a change to the
 * constants later never reprices a promise already made.
 *
 * A payout is a record of SOL somebody already sent, never a send: nothing
 * here, and nothing that reads it, touches a wallet or the program.
 */
import { storeDb, storeSchema, STORE_PERSISTENT } from "./markets.js";
import type { Platform } from "../live/calls.js";

const DDL = `
CREATE TABLE IF NOT EXISTS live_referral (
  platform           text NOT NULL,
  channel_id         text NOT NULL,
  referrer_platform  text NOT NULL,
  referrer_id        text NOT NULL,
  at                 timestamptz NOT NULL DEFAULT now(),
  share_bps          int NOT NULL,
  days               int NOT NULL,
  PRIMARY KEY (platform, channel_id)
);
CREATE INDEX IF NOT EXISTS live_referral_referrer_idx ON live_referral (referrer_platform, referrer_id);

CREATE TABLE IF NOT EXISTS live_referral_payout (
  id                 bigserial PRIMARY KEY,
  referrer_platform  text NOT NULL,
  referrer_id        text NOT NULL,
  lamports           bigint NOT NULL CHECK (lamports > 0),
  wallet             text,
  tx                 text,
  note               text,
  at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_referral_payout_referrer_idx ON live_referral_payout (referrer_platform, referrer_id);
-- One transaction is one payout: recording the same signature twice would
-- count the same SOL as paid twice.
CREATE UNIQUE INDEX IF NOT EXISTS live_referral_payout_tx_idx ON live_referral_payout (tx) WHERE tx IS NOT NULL;
`;

let ready: Promise<void> | null = null;
async function schema(): Promise<void> {
  ready ??= (async () => { await storeSchema(); await storeDb().query(DDL); })().catch((e) => { ready = null; throw e; });
  return ready;
}

/** A channel that joined through another channel's invite, on the terms of that day. */
export interface Referral {
  /** The channel that joined. */
  platform: Platform; channelId: string;
  /** The channel whose invite brought it. */
  referrerPlatform: Platform; referrerId: string;
  /** When it first connected: the window opens here. */
  at: number;
  /** The share of Oddie's fee, and for how many days, fixed when it joined. */
  shareBps: number; days: number;
}

export interface ReferralPayout {
  id: string; referrerPlatform: Platform; referrerId: string;
  lamports: number; wallet: string | null; tx: string | null; note: string | null; at: number;
}

const memReferrals = new Map<string, Referral>();
const memPayouts: ReferralPayout[] = [];
let memPayoutSeq = 0;
const rk = (p: Platform, id: string) => `${p}:${id}`;

type ReferralRow = { platform: Platform; channel_id: string; referrer_platform: Platform; referrer_id: string; at: Date; share_bps: number; days: number };
const referralFrom = (r: ReferralRow): Referral => ({
  platform: r.platform, channelId: r.channel_id, referrerPlatform: r.referrer_platform, referrerId: r.referrer_id,
  at: new Date(r.at).getTime(), shareBps: r.share_bps, days: r.days,
});

/** Records it unless this channel was referred already. True when this call wrote it. */
export async function saveReferral(r: Referral): Promise<boolean> {
  if (!STORE_PERSISTENT) {
    if (memReferrals.has(rk(r.platform, r.channelId))) return false;
    memReferrals.set(rk(r.platform, r.channelId), { ...r });
    return true;
  }
  await schema();
  const { rowCount } = await storeDb().query(
    `INSERT INTO live_referral (platform, channel_id, referrer_platform, referrer_id, at, share_bps, days)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (platform, channel_id) DO NOTHING`,
    [r.platform, r.channelId, r.referrerPlatform, r.referrerId, new Date(r.at), r.shareBps, r.days]);
  return (rowCount ?? 0) > 0;
}

/** Who brought this channel, or null. */
export async function referralOf(platform: Platform, channelId: string): Promise<Referral | null> {
  if (!STORE_PERSISTENT) { const r = memReferrals.get(rk(platform, channelId)); return r ? { ...r } : null; }
  await schema();
  const { rows } = await storeDb().query<ReferralRow>(
    `SELECT platform, channel_id, referrer_platform, referrer_id, at, share_bps, days FROM live_referral WHERE platform = $1 AND channel_id = $2`, [platform, channelId]);
  return rows[0] ? referralFrom(rows[0]) : null;
}

/** The channels this one brought, oldest first. */
export async function referralsBy(referrerPlatform: Platform, referrerId: string): Promise<Referral[]> {
  if (!STORE_PERSISTENT) {
    return [...memReferrals.values()].filter((r) => r.referrerPlatform === referrerPlatform && r.referrerId === referrerId)
      .sort((a, b) => a.at - b.at).map((r) => ({ ...r }));
  }
  await schema();
  const { rows } = await storeDb().query<ReferralRow>(
    `SELECT platform, channel_id, referrer_platform, referrer_id, at, share_bps, days FROM live_referral WHERE referrer_platform = $1 AND referrer_id = $2 ORDER BY at ASC`,
    [referrerPlatform, referrerId]);
  return rows.map(referralFrom);
}

/** Every referral, oldest first: the admin's ledger. */
export async function allReferrals(limit = 2000): Promise<Referral[]> {
  const n = Math.max(1, Math.min(5000, Math.floor(limit)));
  if (!STORE_PERSISTENT) return [...memReferrals.values()].sort((a, b) => a.at - b.at).slice(0, n).map((r) => ({ ...r }));
  await schema();
  const { rows } = await storeDb().query<ReferralRow>(`SELECT platform, channel_id, referrer_platform, referrer_id, at, share_bps, days FROM live_referral ORDER BY at ASC LIMIT $1`, [n]);
  return rows.map(referralFrom);
}

type PayoutRow = { id: string; referrer_platform: Platform; referrer_id: string; lamports: string; wallet: string | null; tx: string | null; note: string | null; at: Date };
const payoutFrom = (r: PayoutRow): ReferralPayout => ({
  id: String(r.id), referrerPlatform: r.referrer_platform, referrerId: r.referrer_id, lamports: Number(r.lamports),
  wallet: r.wallet, tx: r.tx, note: r.note, at: new Date(r.at).getTime(),
});

/** Records SOL the admin already sent. Null when that transaction is recorded already. */
export async function recordPayout(p: { referrerPlatform: Platform; referrerId: string; lamports: number; wallet?: string | null; tx?: string | null; note?: string | null; at?: number }): Promise<ReferralPayout | null> {
  if (!Number.isSafeInteger(p.lamports) || p.lamports <= 0) throw new Error("lamports must be a positive whole number");
  const row = { referrerPlatform: p.referrerPlatform, referrerId: p.referrerId, lamports: p.lamports,
    wallet: p.wallet ?? null, tx: p.tx ?? null, note: p.note ?? null, at: p.at ?? Date.now() };
  if (!STORE_PERSISTENT) {
    if (row.tx && memPayouts.some((x) => x.tx === row.tx)) return null;
    const out = { id: String(++memPayoutSeq), ...row };
    memPayouts.push(out);
    return { ...out };
  }
  await schema();
  const { rows } = await storeDb().query<PayoutRow>(
    `INSERT INTO live_referral_payout (referrer_platform, referrer_id, lamports, wallet, tx, note, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING
     RETURNING id, referrer_platform, referrer_id, lamports, wallet, tx, note, at`,
    [row.referrerPlatform, row.referrerId, row.lamports, row.wallet, row.tx, row.note, new Date(row.at)]);
  return rows[0] ? payoutFrom(rows[0]) : null;
}

/** Payouts recorded, oldest first: one referrer's, or everybody's. */
export async function referralPayouts(referrer?: { platform: Platform; channelId: string }): Promise<ReferralPayout[]> {
  if (!STORE_PERSISTENT) {
    return memPayouts.filter((x) => !referrer || (x.referrerPlatform === referrer.platform && x.referrerId === referrer.channelId))
      .map((x) => ({ ...x }));
  }
  await schema();
  const { rows } = referrer
    ? await storeDb().query<PayoutRow>(
      `SELECT id, referrer_platform, referrer_id, lamports, wallet, tx, note, at FROM live_referral_payout
        WHERE referrer_platform = $1 AND referrer_id = $2 ORDER BY at ASC, id ASC`, [referrer.platform, referrer.channelId])
    : await storeDb().query<PayoutRow>(
      `SELECT id, referrer_platform, referrer_id, lamports, wallet, tx, note, at FROM live_referral_payout ORDER BY at ASC, id ASC LIMIT 5000`);
  return rows.map(payoutFrom);
}

/** Test seam. */
export function _resetReferralStore(): void { memReferrals.clear(); memPayouts.length = 0; memPayoutSeq = 0; }
