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

import { CONNECT_BONUS } from "./economy.js";
import { storeDb, storeSchema, STORE_PERSISTENT, resolveDevice, _memDeviceAccount } from "./markets.js";
import { getWallet } from "./markets.js";

export { CONNECT_BONUS };

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
}

export interface Account {
  provider: Provider;
  handle: string | null;
  name: string | null;
  bonusGranted: boolean;
}

export type LinkResult = {
  account: Account;
  /** Tokens actually paid out by this link. 100 exactly once per account, 0 forever after. */
  bonus: number;
  /** True when this link created the account and adopted the device's play. */
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
export async function linkAccount(rawDeviceId: string, id: Identity): Promise<LinkResult> {
  // A browser that is already signed in links its ACCOUNT's stream, not itself.
  // Connecting X and then Google from the same phone gives both accounts the
  // same canonical device, which is exactly right: it is one person's play.
  const deviceId = await resolveDevice(rawDeviceId);

  if (!STORE_PERSISTENT) {
    const existing = memAccounts.find((a) => a.provider === id.provider && a.uid === id.uid);
    if (existing) {
      _memDeviceAccount.set(rawDeviceId, existing.canonicalDevice);
      return { account: pub(existing), bonus: 0, seeded: false, canonicalDevice: existing.canonicalDevice };
    }
    await getWallet(deviceId); // materialise the balance we are about to top up
    const acct: MemAccount = {
      id: ++memAcctId, provider: id.provider, uid: id.uid,
      handle: id.handle ?? null, name: id.name ?? null, email: id.email ?? null,
      bonusGranted: true, canonicalDevice: deviceId,
    };
    memAccounts.push(acct);
    _memDeviceAccount.set(rawDeviceId, deviceId);
    await grantBonusMem(deviceId);
    return { account: pub(acct), bonus: CONNECT_BONUS, seeded: true, canonicalDevice: deviceId };
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
        bonus: 0, seeded: false, canonicalDevice: a.canonical_device,
      };
    }

    // First time this identity has been seen. The device it arrived on becomes
    // the account's stream, and the bonus is paid into it.
    await client.query(`INSERT INTO device_balance (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [deviceId]);
    const created = await client.query<AcctRow>(
      `INSERT INTO account (provider, provider_uid, handle, display_name, canonical_device, bonus_granted_at, email)
       VALUES ($1,$2,$3,$4,$5, now(), $6) RETURNING *`,
      [id.provider, id.uid, id.handle ?? null, id.name ?? null, deviceId, id.email ?? null],
    );
    await client.query(
      `INSERT INTO device_account (device_id, account_id) VALUES ($1, $2)
       ON CONFLICT (device_id) DO UPDATE SET account_id = EXCLUDED.account_id, linked_at = now()`,
      [rawDeviceId, created.rows[0].id],
    );
    // The one and only place tokens are created out of nothing.
    await client.query(`UPDATE device_balance SET tokens = tokens + $1 WHERE device_id = $2`, [CONNECT_BONUS, deviceId]);
    await client.query("COMMIT");

    const a = created.rows[0];
    return {
      account: { provider: a.provider, handle: a.handle, name: a.display_name, bonusGranted: true },
      bonus: CONNECT_BONUS, seeded: true, canonicalDevice: deviceId,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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

async function grantBonusMem(deviceId: string): Promise<void> {
  const { _memGrant } = await import("./markets.js");
  _memGrant(deviceId, CONNECT_BONUS);
}
