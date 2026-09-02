/**
 * The Genesis profile snapshot: what we saw of an X account at the moment it
 * connected, plus the archetype verdict computed from it.
 *
 * Captured at OAuth-callback time and NEVER refetched on its own — the user
 * token dies inside identify(), so this is the only moment the data exists.
 * Reconnecting refreshes the row (people rename, follower counts move, pins
 * change), which also means the card is allowed to change verdict on a
 * reconnect: fresh beats stale, and the person themselves triggered it.
 *
 * The verdict (archetype/headline/reason) is stored, not recomputed at render
 * time, so a shipped card keeps saying what it said when it was minted even if
 * the classifier evolves underneath it.
 */
import { classifyArchetype, type Archetype, type ProfileSignals } from "./archetype.js";
import { storeDb, storeSchema, STORE_PERSISTENT, _memDeviceAccount } from "../store/markets.js";
import { _memAccounts } from "../store/accounts.js";

export interface GenesisProfile {
  /** X's numeric user id — the stable identity; handles get renamed. */
  uid: string;
  /** Display form without the @ ("levvercetti"). Lookup is case-insensitive. */
  handle: string;
  name: string | null;
  archetype: Archetype;
  headline: string;
  reason: string;
  /** The pinned claim printed on the card's ticket stub; null renders the invitation. */
  pinnedText: string | null;
  capturedAt: string;
}

/** What identify() hands over from the one users/me call it already makes. */
export interface XProfileRaw {
  createdAt: string;
  bio: string;
  tweetCount: number;
  followers: number;
  following: number;
  pinnedText: string | null;
}

// resvg refuses XML-invalid characters OUTRIGHT (a single \b in a pinned
// tweet made the constructor throw in review), and these fields come from X
// verbatim. Stripped at capture so no stored row can ever poison a render.
const xmlSafe = (t: string): string =>
  t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, "");

// --- in-memory backend (no DATABASE_URL: dev and tests) ---------------------
const memProfiles = new Map<string, GenesisProfile>();

/** Classify and store. Returns the stored row so the caller can log the verdict. */
export async function captureGenesisProfile(
  uid: string, handle: string, name: string | null, raw: XProfileRaw,
): Promise<GenesisProfile> {
  const bio = xmlSafe(raw.bio);
  const pinned = raw.pinnedText === null ? null : xmlSafe(raw.pinnedText);
  const cleanName = name === null ? null : xmlSafe(name);
  const signals: ProfileSignals = {
    handle: `@${handle}`,
    bio,
    createdAt: raw.createdAt,
    tweetCount: raw.tweetCount,
    followers: raw.followers,
    following: raw.following,
    pinnedText: pinned,
  };
  const r = classifyArchetype(signals);
  const row: GenesisProfile = {
    uid, handle, name: cleanName,
    archetype: r.archetype, headline: r.headline, reason: r.reason,
    pinnedText: pinned,
    capturedAt: new Date().toISOString(),
  };

  if (!STORE_PERSISTENT) {
    // X recycles freed handles. If some OTHER uid still holds this handle from
    // before its owner renamed, blank it: the handle provably belongs to the
    // person connecting right now. Their row heals the same way when THEY
    // reconnect under their new name.
    for (const p of memProfiles.values()) {
      if (p.uid !== uid && p.handle.toLowerCase() === handle.toLowerCase()) p.handle = "";
    }
    memProfiles.set(uid, row);
    return row;
  }

  await storeSchema();
  const client = await storeDb().connect();
  try {
    await client.query("BEGIN");
    // Same recycled-handle hygiene as the mem branch, atomically with the
    // upsert so a race between two callbacks cannot leave two live claimants.
    await client.query(
      `UPDATE genesis_profile SET handle = '' WHERE lower(handle) = lower($2) AND provider_uid <> $1`,
      [uid, handle],
    );
    await client.query(
      `INSERT INTO genesis_profile
         (provider_uid, handle, display_name, bio, x_created_at, tweet_count, followers, following, pinned_text,
          archetype, headline, reason, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (provider_uid) DO UPDATE SET
         handle = EXCLUDED.handle, display_name = EXCLUDED.display_name, bio = EXCLUDED.bio,
         x_created_at = EXCLUDED.x_created_at, tweet_count = EXCLUDED.tweet_count,
         followers = EXCLUDED.followers, following = EXCLUDED.following, pinned_text = EXCLUDED.pinned_text,
         archetype = EXCLUDED.archetype, headline = EXCLUDED.headline, reason = EXCLUDED.reason,
         captured_at = now()`,
      [uid, handle, cleanName, bio, raw.createdAt, raw.tweetCount, raw.followers, raw.following,
       pinned, r.archetype, r.headline, r.reason],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return row;
}

/** Case-insensitive handle lookup, "@" tolerated. Null when never connected. */
export async function genesisProfileByHandle(rawHandle: string): Promise<GenesisProfile | null> {
  const handle = rawHandle.replace(/^@+/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;

  if (!STORE_PERSISTENT) {
    // Newest capture wins, matching the pg ORDER BY: deterministic in both
    // backends even if a blanking somehow missed.
    const hits = [...memProfiles.values()]
      .filter((p) => p.handle !== "" && p.handle.toLowerCase() === handle.toLowerCase())
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    return hits[0] ?? null;
  }

  await storeSchema();
  const { rows } = await storeDb().query<ProfileRow>(
    `SELECT * FROM genesis_profile WHERE handle <> '' AND lower(handle) = lower($1)
      ORDER BY captured_at DESC LIMIT 1`, [handle],
  );
  return rows.length ? fromRow(rows[0]) : null;
}

/** The snapshot behind the device's connected X account, if both exist. */
export async function genesisProfileForDevice(deviceId: string): Promise<GenesisProfile | null> {
  if (!STORE_PERSISTENT) {
    const canon = _memDeviceAccount.get(deviceId);
    if (!canon) return null;
    const acct = _memAccounts.find((a) => a.provider === "twitter" && a.canonicalDevice === canon);
    const hit = acct ? (memProfiles.get(acct.uid) ?? null) : null;
    // A blanked handle means the person renamed and somebody else took the
    // name: their card URL would 404, so treat them as not-yet-carded and let
    // the page offer the connect that heals the row.
    return hit && hit.handle !== "" ? hit : null;
  }
  await storeSchema();
  const { rows } = await storeDb().query<ProfileRow>(
    `SELECT gp.* FROM genesis_profile gp
       JOIN account a ON a.provider = 'twitter' AND a.provider_uid = gp.provider_uid
      WHERE gp.handle <> ''
        AND a.canonical_device = (
        SELECT a2.canonical_device FROM device_account da JOIN account a2 ON a2.id = da.account_id
         WHERE da.device_id = $1)
      LIMIT 1`,
    [deviceId],
  );
  return rows.length ? fromRow(rows[0]) : null;
}

interface ProfileRow {
  provider_uid: string; handle: string; display_name: string | null;
  archetype: Archetype; headline: string; reason: string;
  pinned_text: string | null; captured_at: Date;
}

const fromRow = (r: ProfileRow): GenesisProfile => ({
  uid: r.provider_uid, handle: r.handle, name: r.display_name,
  archetype: r.archetype, headline: r.headline, reason: r.reason,
  pinnedText: r.pinned_text, capturedAt: r.captured_at.toISOString(),
});
