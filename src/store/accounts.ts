// Optional identity. Never a wall.
//
// An account is a persistent name for a stream of play. It owns nothing itself:
// balance, calls, positions and reputation all still live keyed by a device id.
// The account just says WHICH device id — its `canonical_device` — and
// `resolveDevice()` in markets.ts points every signed-in browser at it.
//
// That indirection is the whole system. Nothing is copied on link, so there is
// exactly one row per position however many phones a person signs in from, and
// "does reputation follow the account" is not a feature we had to build.

import { randomUUID } from "node:crypto";
import { storeDb, storeSchema, STORE_PERSISTENT, resolveDevice, _memDeviceAccount } from "./markets.js";
import { getWallet } from "./markets.js";


// "phantom" is a wallet, not an OAuth provider — there is no redirect, no
// client secret and no token. It reaches linkAccount through the same door as
// the other two because everything below this line is provider-agnostic: an
// account is a (provider, uid) pair pointing at a canonical device, and a
// wallet address is as good a uid as Google's `sub`. See src/auth/wallet.ts for
// how the identity is proved before it gets here.
export type Provider = "google" | "twitter" | "phantom";

export interface Identity {
  provider: Provider;
  /** The provider's opaque id: Google's `sub`, X's numeric user id, or a
   *  wallet's base58 address. */
  uid: string;
  handle?: string | null;
  name?: string | null;
  /** Verified Google address, held for settlement emails only. */
  email?: string | null;
  /** X only: the Genesis snapshot riding through from identify(); linkAccount
   *  itself never reads it, the callback hands it to captureGenesisProfile. */
  xProfile?: import("../genesis/profileStore.js").XProfileRaw | null;
}

export interface Account {
  provider: Provider;
  handle: string | null;
  name: string | null;
  bonusGranted: boolean;
}

export type LinkResult = {
  account: Account;
  /** True when this link created the account and adopted the device's play.
   *  There is no bonus field any more: linking pays nothing. The score is
   *  earned by tagging markets into existence and being loud about them, and
   *  an account is how that score follows you, not a way to be handed some. */
  seeded: boolean;
  canonicalDevice: string;
};

// --- in-memory backend ------------------------------------------------------
interface MemAccount extends Account { id: number; uid: string; canonicalDevice: string; email?: string | null }
const memAccounts: MemAccount[] = [];
export const _memAccounts = memAccounts; // settlement email lookup, mem backend
let memAcctId = 0;

/**
 * Link a device to a provider identity.
 *
 * Two cases, and the difference between them is the whole anti-farming story:
 *
 * 1. **First link for this identity.** The account is created and ADOPTS the
 *    device: its balance, its open positions, its closed history, its edge. The
 *    device becomes `canonical_device`. The +100 lands here, once.
 *
 * 2. **The identity already has an account.** The new browser ADOPTS THE
 *    ACCOUNT instead. Its own anonymous balance is not added, and this is
 *    deliberate: every fresh browser is born with 1000 free tokens, so adding a
 *    second device's balance to an account would mint 1000 tokens per browser a
 *    person opens. Summing is a printer. Capping the sum is a printer with a
 *    ceiling. Taking the maximum is a printer for anyone who spends down.
 *
 *    Moving the second device's OPEN positions has the same defect one step
 *    removed — their stakes were paid out of free tokens, and their proceeds
 *    would land in the account. So nothing moves. The browser simply starts
 *    reading and writing the account's stream.
 *
 * The cost of (2) is real and worth stating plainly: if someone plays
 * anonymously on a second browser and then signs in there, that browser's play
 * stays with the browser. The UI says so before they tap. Nobody loses anything
 * they earned as themselves, because before signing in they were not anybody.
 *
 * The bonus is keyed on the ACCOUNT, not the device: `bonus_granted_at` is set
 * at creation and never re-read for a grant. Deleting every device that ever
 * linked to an account does not make it claimable again.
 */
/**
 * SIGNING IN AS SOMEBODY ELSE SWITCHES YOU, IT DOES NOT ADD YOU.
 *
 * Connecting X and then Google from the same phone shares a canonical device,
 * which is right: it is one person proving themselves twice. Connecting a
 * SECOND X account is the opposite claim, and sharing a device for it merged
 * two people into one record. On production that had already happened, with
 * three visible consequences: /@levvercetti answered with the brand's name,
 * the leaderboard's exclusion of @oddiefun took the human's row down with it,
 * and one person's resolved calls were credited to the other.
 *
 * So a new identity for a provider this stream already has starts its own
 * canonical device instead of inheriting the current one. The browser then
 * follows the new account (device_account is repointed either way), the
 * previous identity keeps its history intact under its own device, and
 * switching back is just signing in again — the branch above finds that
 * account and repoints to it, unchanged.
 *
 * Refusing the second link was the alternative and it is worse: somebody who
 * wants to change accounts is left with no way to do it at all.
 */
async function canonicalDeviceFor(rawDeviceId: string, deviceId: string, id: Identity): Promise<string> {
  const held = await accountsFor(rawDeviceId).catch(() => [] as Account[]);
  const clash = held.some((a) => a.provider === id.provider);
  return clash ? randomUUID() : deviceId;
}

export async function linkAccount(rawDeviceId: string, id: Identity): Promise<LinkResult> {
  const deviceId = await resolveDevice(rawDeviceId);

  if (!STORE_PERSISTENT) {
    const existing = memAccounts.find((a) => a.provider === id.provider && a.uid === id.uid);
    if (existing) {
      _memDeviceAccount.set(rawDeviceId, existing.canonicalDevice);
      return { account: pub(existing), seeded: false, canonicalDevice: existing.canonicalDevice };
    }
    const canon = await canonicalDeviceFor(rawDeviceId, deviceId, id);
    await getWallet(canon); // materialise the balance row for the new stream
    const acct: MemAccount = {
      id: ++memAcctId, provider: id.provider, uid: id.uid,
      handle: id.handle ?? null, name: id.name ?? null, email: id.email ?? null,
      bonusGranted: true, canonicalDevice: canon,
    };
    memAccounts.push(acct);
    _memDeviceAccount.set(rawDeviceId, canon);
    return { account: pub(acct), seeded: true, canonicalDevice: canon };
  }

  await storeSchema();
  const client = await storeDb().connect();
  try {
    await client.query("BEGIN");
    // Lock the identity row so two tabs finishing the same OAuth dance cannot
    // both see "no account yet" and both pay the bonus.
    const found = await client.query<AcctRow>(
      `SELECT * FROM account WHERE provider = $1 AND provider_uid = $2 FOR UPDATE`,
      [id.provider, id.uid],
    );

    if (found.rows.length > 0) {
      const a = found.rows[0];
      // Refresh the display fields; people rename themselves.
      await client.query(`UPDATE account SET handle = $1, display_name = $2, email = COALESCE($3, email) WHERE id = $4`,
        [id.handle ?? a.handle, id.name ?? a.display_name, id.email ?? null, a.id]);
      await client.query(
        `INSERT INTO device_account (device_id, account_id) VALUES ($1, $2)
         ON CONFLICT (device_id) DO UPDATE SET account_id = EXCLUDED.account_id, linked_at = now()`,
        [rawDeviceId, a.id],
      );
      await client.query("COMMIT");
      return {
        account: { provider: a.provider, handle: id.handle ?? a.handle, name: id.name ?? a.display_name, bonusGranted: a.bonus_granted_at !== null },
        seeded: false, canonicalDevice: a.canonical_device,
      };
    }

    // First time this identity has been seen. The device it arrived on becomes
    // the account's stream, and the bonus is paid into it.
    const canon = await canonicalDeviceFor(rawDeviceId, deviceId, id);
    await client.query(`INSERT INTO device_balance (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [canon]);
    const created = await client.query<AcctRow>(
      `INSERT INTO account (provider, provider_uid, handle, display_name, canonical_device, bonus_granted_at, email)
       VALUES ($1,$2,$3,$4,$5, now(), $6) RETURNING *`,
      [id.provider, id.uid, id.handle ?? null, id.name ?? null, canon, id.email ?? null],
    );
    await client.query(
      `INSERT INTO device_account (device_id, account_id) VALUES ($1, $2)
       ON CONFLICT (device_id) DO UPDATE SET account_id = EXCLUDED.account_id, linked_at = now()`,
      [rawDeviceId, created.rows[0].id],
    );
    // No grant here any more. This UPDATE was "the one and only place tokens
    // are created out of nothing", which is exactly why it went: the score is
    // earned, and an account is how it follows you, not a way to be handed
    // some. bonus_granted_at still gets stamped above, so an account that WAS
    // paid in the grant era can never be paid again should one ever return.
    await client.query("COMMIT");

    const a = created.rows[0];
    return {
      account: { provider: a.provider, handle: a.handle, name: a.display_name, bonusGranted: true },
      seeded: true, canonicalDevice: canon,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Sign THIS BROWSER out: drop its device_account row. The account, its
 * canonical device and every bit of its history stay untouched — the browser
 * simply goes back to being anonymous, exactly the state it was born in.
 * Reconnecting is the same OAuth door as ever; linkAccount finds the account
 * and repoints. Nothing here is destructive, which is why it needs no
 * confirmation ceremony.
 */
export async function disconnectDevice(deviceId: string): Promise<void> {
  if (!STORE_PERSISTENT) { _memDeviceAccount.delete(deviceId); return; }
  await storeSchema();
  await storeDb().query(`DELETE FROM device_account WHERE device_id = $1`, [deviceId]);
}

/** Every account this browser is signed in to. Empty for an anonymous device. */
export async function accountsFor(deviceId: string): Promise<Account[]> {
  if (!STORE_PERSISTENT) {
    const canon = _memDeviceAccount.get(deviceId);
    return canon ? memAccounts.filter((a) => a.canonicalDevice === canon).map(pub) : [];
  }
  await storeSchema();
  // Every account whose stream this browser reads — connecting X and then Google
  // leaves two rows pointing at one canonical device, and Profile shows both.
  const { rows } = await storeDb().query<AcctRow>(
    `SELECT a.* FROM account a
      WHERE a.canonical_device = (
        SELECT a2.canonical_device FROM device_account da JOIN account a2 ON a2.id = da.account_id
         WHERE da.device_id = $1)
      ORDER BY a.created_at`,
    [deviceId],
  );
  return rows.map((a) => ({ provider: a.provider, handle: a.handle, name: a.display_name, bonusGranted: a.bonus_granted_at !== null }));
}

interface AcctRow {
  id: number; provider: Provider; provider_uid: string;
  handle: string | null; display_name: string | null;
  canonical_device: string; bonus_granted_at: Date | null;
}

const pub = (a: MemAccount): Account => ({ provider: a.provider, handle: a.handle, name: a.name, bonusGranted: a.bonusGranted });
