/**
 * The Genesis season: tickets, who opened which market, and who they brought.
 *
 * THE LEDGER IS KEYED ON THE X HANDLE, NOT ON A CONNECTED ACCOUNT. "Every X
 * account gets 5 tickets" is the campaign's promise, and connecting is how you
 * SEE your tickets, not how you earn them. Keying on the account instead would
 * invert the incentive in the worst possible way: the person who connected
 * would be the only one who could run out, while anyone who never connected
 * tagged forever. So a tag spends from the tagger's handle whether or not that
 * handle has ever visited the site, and connecting later simply shows a balance
 * that is already spent down. Honest, and the same rule for everybody.
 *
 * Three facts, three tables:
 *   genesis_ticket_log  every ticket movement, with a dedup key, so a retried
 *                       sweep or a replayed submit can never double-spend.
 *                       Balance is 5 + SUM(delta) — the log IS the balance.
 *   genesis_tag         which handle opened which market. Not market_surfacer:
 *                       that row records the CLAIM's author (provenance), and
 *                       the tagger is a different person on every reply-tag.
 *   genesis_bettor      first touch, once per wallet FOREVER. The board counts
 *                       humans who put real money in, and the same wallet
 *                       funding ten markets is one human, credited to the
 *                       first market that got them in.
 */
import { storeDb, storeSchema, STORE_PERSISTENT } from "../store/markets.js";
import { _memProfileByHandle } from "./profileStore.js";

/** The campaign constant. Everybody starts here; nobody is ever handed more. */
export const GENESIS_TICKETS = 5;

const norm = (h: string): string => h.replace(/^@+/, "").toLowerCase();
const validHandle = (h: string): boolean => /^[a-z0-9_]{1,15}$/.test(h);

export interface GenesisStanding {
  handle: string;
  ticketsLeft: number;
  /** Markets this handle opened by tagging. */
  marketsOpened: number;
  /** Distinct wallets whose FIRST real-money bet landed in one of them. */
  peopleBrought: number;
  /** Dense rank by peopleBrought among everyone who brought at least one. */
  rank: number | null;
}

// --- in-memory backend (no DATABASE_URL: dev and tests) ---------------------
interface MemLog { handle: string; delta: number; reason: string; dedupKey: string }
interface MemTag { slug: string; handle: string; sourceHandle: string | null }
interface MemBettor { wallet: string; slug: string; handle: string | null }
const memLog: MemLog[] = [];
const memTags: MemTag[] = [];
const memBettors: MemBettor[] = [];

/** Test seam only: the in-memory season, wiped between cases. */
export function _resetSeason(): void {
  memLog.length = 0; memTags.length = 0; memBettors.length = 0;
}

const memBalance = (handle: string): number =>
  GENESIS_TICKETS + memLog.filter((l) => l.handle === handle).reduce((s, l) => s + l.delta, 0);

/** Tickets left for a handle. Never negative, never above the campaign cap. */
export async function ticketsLeft(rawHandle: string): Promise<number> {
  const handle = norm(rawHandle);
  if (!validHandle(handle)) return 0;
  if (!STORE_PERSISTENT) return Math.max(0, Math.min(GENESIS_TICKETS, memBalance(handle)));
  await storeSchema();
  const { rows } = await storeDb().query<{ bal: string }>(
    `SELECT COALESCE(SUM(delta), 0) + $2 AS bal FROM genesis_ticket_log WHERE handle = $1`,
    [handle, GENESIS_TICKETS],
  );
  // node-postgres hands back SUM() as a STRING; Number() it or the clamp below
  // compares a string and silently lets everyone through.
  return Math.max(0, Math.min(GENESIS_TICKETS, Number(rows[0]?.bal ?? GENESIS_TICKETS)));
}

/**
 * Spend one ticket for a market this handle just opened.
 *
 * Called AFTER the mint succeeded, on purpose: a tag that failed to become a
 * market cost the person nothing, which is the only version of this rule
 * anybody would call fair. Idempotent on the slug, so a retried sweep charges
 * once.
 *
 * Returns false when the handle had nothing left — the caller decides what
 * that means; this function never lets a balance go negative.
 */
export async function spendTicketForTag(
  slug: string, rawTagger: string, rawSource: string | null,
): Promise<boolean> {
  const handle = norm(rawTagger);
  if (!validHandle(handle)) return false;
  const source = rawSource ? norm(rawSource) : null;

  if (!STORE_PERSISTENT) {
    if (memTags.some((t) => t.slug === slug)) return true; // already charged
    if (memBalance(handle) <= 0) return false;
    memTags.push({ slug, handle, sourceHandle: source });
    memLog.push({ handle, delta: -1, reason: "tag", dedupKey: `tag:${slug}` });
    return true;
  }

  await storeSchema();
  const client = await storeDb().connect();
  try {
    await client.query("BEGIN");
    // Lock this handle's ledger so two sweeps cannot both read "1 left".
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`genesis:${handle}`]);
    const bal = await client.query<{ bal: string }>(
      `SELECT COALESCE(SUM(delta), 0) + $2 AS bal FROM genesis_ticket_log WHERE handle = $1`,
      [handle, GENESIS_TICKETS],
    );
    const already = await client.query(`SELECT 1 FROM genesis_tag WHERE slug = $1`, [slug]);
    if (already.rows.length > 0) { await client.query("COMMIT"); return true; }
    if (Number(bal.rows[0]?.bal ?? GENESIS_TICKETS) <= 0) { await client.query("COMMIT"); return false; }

    await client.query(
      `INSERT INTO genesis_tag (slug, handle, source_handle) VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO NOTHING`,
      [slug, handle, source],
    );
    await client.query(
      `INSERT INTO genesis_ticket_log (handle, delta, reason, dedup_key)
       VALUES ($1, -1, 'tag', $2) ON CONFLICT (dedup_key) DO NOTHING`,
      [handle, `tag:${slug}`],
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A real-money bet just landed. If this wallet has never funded anything
 * before, it is a NEW HUMAN and the person whose market got them in is
 * credited: +1 on the board, and +1 ticket back if they are under the cap.
 *
 * Once per wallet forever, not once per market, because the board counts
 * people rather than bets. Best-effort by contract: the caller is the money
 * path, and no bookkeeping failure may ever cost somebody their transaction.
 *
 * `walletHandle` is the X handle that owns this wallet, when we know it, and it
 * enforces the rule the page prints: YOUR OWN WALLET NEVER COUNTS. Funding your
 * own market records NOTHING at all rather than a null-credited row, on purpose:
 * a wallet consumed here could never count for somebody else later, and the
 * rule is "this does not score", not "this wallet is spent".
 */
export async function creditFundedBettor(
  slug: string, wallet: string, walletHandle?: string | null,
): Promise<void> {
  if (!slug || !wallet) return;
  const owner = walletHandle ? norm(walletHandle) : null;

  if (!STORE_PERSISTENT) {
    if (memBettors.some((b) => b.wallet === wallet)) return;
    const tag = memTags.find((t) => t.slug === slug) ?? null;
    if (tag && owner && tag.handle === owner) return; // kendi cuzdanin sayilmaz
    memBettors.push({ wallet, slug, handle: tag?.handle ?? null });
    if (tag && memBalance(tag.handle) < GENESIS_TICKETS) {
      memLog.push({ handle: tag.handle, delta: 1, reason: "bettor", dedupKey: `bettor:${wallet}` });
    }
    return;
  }

  await storeSchema();
  const client = await storeDb().connect();
  try {
    await client.query("BEGIN");
    const tag = await client.query<{ handle: string }>(`SELECT handle FROM genesis_tag WHERE slug = $1`, [slug]);
    const handle = tag.rows[0]?.handle ?? null;
    if (handle && owner && handle === owner) { await client.query("COMMIT"); return; }
    const ins = await client.query(
      `INSERT INTO genesis_bettor (wallet, slug, handle) VALUES ($1,$2,$3)
       ON CONFLICT (wallet) DO NOTHING RETURNING wallet`,
      [wallet, slug, handle],
    );
    // Not the first touch: this wallet already belongs to somebody else's
    // number, and first-touch means the credit never moves.
    if (ins.rows.length === 0 || !handle) { await client.query("COMMIT"); return; }

    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`genesis:${handle}`]);
    const bal = await client.query<{ bal: string }>(
      `SELECT COALESCE(SUM(delta), 0) + $2 AS bal FROM genesis_ticket_log WHERE handle = $1`,
      [handle, GENESIS_TICKETS],
    );
    // The cap is the campaign's whole scarcity claim: bringing people back
    // refills what you spent, it never mints a sixth ticket.
    if (Number(bal.rows[0]?.bal ?? GENESIS_TICKETS) < GENESIS_TICKETS) {
      await client.query(
        `INSERT INTO genesis_ticket_log (handle, delta, reason, dedup_key)
         VALUES ($1, 1, 'bettor', $2) ON CONFLICT (dedup_key) DO NOTHING`,
        [handle, `bettor:${wallet}`],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Everything the connected page shows about one person. */
export async function genesisStanding(rawHandle: string): Promise<GenesisStanding> {
  const handle = norm(rawHandle);
  const empty: GenesisStanding = { handle, ticketsLeft: GENESIS_TICKETS, marketsOpened: 0, peopleBrought: 0, rank: null };
  if (!validHandle(handle)) return empty;

  if (!STORE_PERSISTENT) {
    const people = memBettors.filter((b) => b.handle === handle).length;
    const counts = new Map<string, number>();
    for (const b of memBettors) if (b.handle) counts.set(b.handle, (counts.get(b.handle) ?? 0) + 1);
    // DENSE rank, matching the pg branch's DENSE_RANK: count DISTINCT totals
    // above this one, so two people tied at four are both fourth and the next
    // person is fifth. Counting rows instead made the two backends disagree.
    const better = new Set([...counts.values()].filter((c) => c > people)).size;
    return {
      handle,
      ticketsLeft: Math.max(0, Math.min(GENESIS_TICKETS, memBalance(handle))),
      marketsOpened: memTags.filter((t) => t.handle === handle).length,
      peopleBrought: people,
      rank: people > 0 ? better + 1 : null,
    };
  }

  await storeSchema();
  const { rows } = await storeDb().query<{ tickets: string; opened: string; people: string; rank: string | null }>(
    `WITH me AS (SELECT $1::text AS handle),
     bal AS (SELECT COALESCE(SUM(delta), 0) + $2 AS t FROM genesis_ticket_log WHERE handle = (SELECT handle FROM me)),
     opened AS (SELECT COUNT(*) AS c FROM genesis_tag WHERE handle = (SELECT handle FROM me)),
     people AS (SELECT COUNT(*) AS c FROM genesis_bettor WHERE handle = (SELECT handle FROM me)),
     board AS (SELECT handle, COUNT(*) AS c FROM genesis_bettor WHERE handle IS NOT NULL GROUP BY handle),
     -- DENSE_RANK: two people who each brought four are both fourth, and the
     -- next number is fifth, not seventh.
     ranked AS (SELECT handle, DENSE_RANK() OVER (ORDER BY c DESC) AS r FROM board)
     SELECT (SELECT t FROM bal) AS tickets, (SELECT c FROM opened) AS opened,
            (SELECT c FROM people) AS people,
            (SELECT r FROM ranked WHERE handle = (SELECT handle FROM me)) AS rank`,
    [handle, GENESIS_TICKETS],
  );
  const r = rows[0];
  if (!r) return empty;
  return {
    handle,
    ticketsLeft: Math.max(0, Math.min(GENESIS_TICKETS, Number(r.tickets))),
    marketsOpened: Number(r.opened),
    peopleBrought: Number(r.people),
    rank: r.rank === null ? null : Number(r.rank),
  };
}

export interface BoardRow { handle: string; peopleBrought: number; marketsOpened: number; rank: number }

/** The board. Only people who actually brought somebody appear on it. */
export async function genesisBoard(limit = 20): Promise<BoardRow[]> {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));

  if (!STORE_PERSISTENT) {
    const counts = new Map<string, number>();
    for (const b of memBettors) if (b.handle) counts.set(b.handle, (counts.get(b.handle) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    // Same dense rule: the rank advances by one per DISTINCT total, not per row.
    let rank = 0, prev = -1;
    return sorted.slice(0, n).map(([handle, people]) => {
      if (people !== prev) { rank += 1; prev = people; }
      return { handle, peopleBrought: people, marketsOpened: memTags.filter((t) => t.handle === handle).length, rank };
    });
  }

  await storeSchema();
  const { rows } = await storeDb().query<{ handle: string; people: string; opened: string; rank: string }>(
    `WITH board AS (SELECT handle, COUNT(*) AS people FROM genesis_bettor WHERE handle IS NOT NULL GROUP BY handle)
     SELECT b.handle, b.people,
            (SELECT COUNT(*) FROM genesis_tag t WHERE t.handle = b.handle) AS opened,
            DENSE_RANK() OVER (ORDER BY b.people DESC) AS rank
       FROM board b ORDER BY b.people DESC, b.handle ASC LIMIT $1`,
    [n],
  );
  return rows.map((r) => ({
    handle: r.handle, peopleBrought: Number(r.people),
    marketsOpened: Number(r.opened), rank: Number(r.rank),
  }));
}

/* ------------------------------------------------------------- operator -- */

/**
 * THE MARKETS THIS HANDLE OPENED.
 *
 * The campaign asked people to spend a ticket and then showed them nothing for
 * it: once a tag was charged, no surface on oddie.fun ever named the market it
 * bought. genesis_tag has held the answer since the first tag; it was simply
 * never read back for the person who paid.
 *
 * Newest first, because the one you just opened is the one you are looking for.
 */
export interface OpenedTag { slug: string; at: string }

export async function genesisOpened(rawHandle: string, limit = 10): Promise<OpenedTag[]> {
  const handle = norm(rawHandle);
  if (!validHandle(handle)) return [];
  const n = Math.max(1, Math.min(50, Math.floor(limit)));
  if (!STORE_PERSISTENT) {
    // The in-memory tag list carries no timestamp, so insertion order IS the
    // order. Reversed to match the persistent path's newest-first contract
    // rather than quietly serving two different orders per environment.
    return memTags.filter((t) => t.handle === handle).slice(-n).reverse()
      .map((t) => ({ slug: t.slug, at: "" }));
  }
  await storeSchema();
  const { rows } = await storeDb().query<{ slug: string; at: Date }>(
    `SELECT slug, at FROM genesis_tag WHERE handle = $1 ORDER BY at DESC LIMIT $2`,
    [handle, n],
  );
  return rows.map((r) => ({ slug: r.slug, at: r.at.toISOString() }));
}

export interface RosterRow {
  handle: string;
  name: string | null;
  archetype: string | null;
  /** When they connected X. Null for a handle that only ever tagged. */
  connectedAt: string | null;
  ticketsLeft: number;
  marketsOpened: number;
  peopleBrought: number;
  /** Every market they opened, newest first: slug, whose claim it was, when. */
  tags: Array<{ slug: string; sourceHandle: string | null; at: string }>;
}

/**
 * THE ROSTER: everybody the campaign has touched, and what they did.
 *
 * Deliberately a UNION rather than a join off genesis_profile. Connecting and
 * tagging are separate acts and either can happen without the other: the ledger
 * is keyed on the X handle precisely so that somebody who tags without ever
 * visiting the site still spends tickets. An operator view built on connections
 * alone would silently omit exactly those people, which is the group worth
 * watching most.
 *
 * Operator-only: this is the one place handles, names and tag targets are
 * listed together, so the route that serves it must be admin-gated.
 */
export async function genesisRoster(limit = 200): Promise<RosterRow[]> {
  const n = Math.max(1, Math.min(1000, Math.floor(limit)));

  if (!STORE_PERSISTENT) {
    const handles = new Set<string>(memTags.map((t) => t.handle));
    return [...handles].slice(0, n).map((handle) => {
      // Ayni birlesim: profil deposunu da okur, yoksa BAGLANMIS birine
      // "hic baglanmadi" derdi ve bu tam olarak bu sayfanin yalan
      // soylememesi gereken sey.
      const gp = _memProfileByHandle(handle);
      return {
        handle,
        name: gp?.name ?? null,
        archetype: gp?.archetype ?? null,
        connectedAt: gp?.capturedAt ?? null,
        ticketsLeft: Math.max(0, Math.min(GENESIS_TICKETS, memBalance(handle))),
        marketsOpened: memTags.filter((t) => t.handle === handle).length,
        peopleBrought: memBettors.filter((b) => b.handle === handle).length,
        tags: memTags.filter((t) => t.handle === handle)
          .map((t) => ({ slug: t.slug, sourceHandle: t.sourceHandle, at: "" })),
      };
    });
  }

  await storeSchema();
  const { rows } = await storeDb().query<{
    handle: string; display_name: string | null; archetype: string | null;
    captured_at: Date | null; tickets: string; opened: string; people: string;
  }>(
    `WITH folk AS (
       SELECT lower(handle) AS handle FROM genesis_profile WHERE handle <> ''
       UNION
       SELECT handle FROM genesis_tag
       UNION
       SELECT handle FROM genesis_ticket_log
     )
     SELECT f.handle,
            gp.display_name, gp.archetype, gp.captured_at,
            COALESCE((SELECT SUM(delta) FROM genesis_ticket_log l WHERE l.handle = f.handle), 0) + $2 AS tickets,
            (SELECT COUNT(*) FROM genesis_tag t WHERE t.handle = f.handle) AS opened,
            (SELECT COUNT(*) FROM genesis_bettor b WHERE b.handle = f.handle) AS people
       FROM folk f
       LEFT JOIN genesis_profile gp ON lower(gp.handle) = f.handle
      ORDER BY people DESC, opened DESC, f.handle ASC
      LIMIT $1`,
    [n, GENESIS_TICKETS],
  );
  if (!rows.length) return [];

  // One extra query for every tag, rather than N: the roster is an operator
  // page and N+1 over a growing campaign is how these pages get slow quietly.
  const { rows: tagRows } = await storeDb().query<{ handle: string; slug: string; source_handle: string | null; at: Date }>(
    `SELECT handle, slug, source_handle, at FROM genesis_tag
      WHERE handle = ANY($1::text[]) ORDER BY at DESC`,
    [rows.map((r) => r.handle)],
  );
  const byHandle = new Map<string, RosterRow["tags"]>();
  for (const t of tagRows) {
    const list = byHandle.get(t.handle) ?? [];
    list.push({ slug: t.slug, sourceHandle: t.source_handle, at: t.at.toISOString() });
    byHandle.set(t.handle, list);
  }

  return rows.map((r) => ({
    handle: r.handle,
    name: r.display_name,
    archetype: r.archetype,
    connectedAt: r.captured_at ? r.captured_at.toISOString() : null,
    ticketsLeft: Math.max(0, Math.min(GENESIS_TICKETS, Number(r.tickets))),
    marketsOpened: Number(r.opened),
    peopleBrought: Number(r.people),
    tags: byHandle.get(r.handle) ?? [],
  }));
}
