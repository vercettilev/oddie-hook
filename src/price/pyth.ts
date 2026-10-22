/**
 * PYTH'S GOLD ON SOLANA, READ AT A MARKET'S OPEN AND NOWHERE ELSE.
 *
 * WHY. A gold market settles from Bybit's XAUUSDT perpetual (feed.ts), and
 * this server cannot read Bybit live: Bybit refuses US addresses, and the
 * public trade archive the market settles from is published a day later. So
 * the price at the open, which tells "gold above $4,200 this week" apart as a
 * hold or a reach (readAtOpen), was never read for a commodity.
 *
 * Pyth keeps gold on Solana itself, in an account its receiver program
 * rewrites about once a minute while the gold market trades, read through the
 * same RPC as everything else on chain, with no key. Its price API (Hermes)
 * answers 401 without one, measured 22 Oct, and of the four commodities only
 * gold is kept current on chain: silver's account last moved on 3 July, WTI
 * and Brent have none.
 *
 * NOT BYBIT'S PRICE. Measured 22 Oct, Pyth's gold sat $8 to $10 (0.20 to
 * 0.26%) under Bybit's perpetual. It only says which side of a level the price
 * is on when the level is well clear of it: closer than PYTH_MARGIN, the
 * market opens as it would have without it (priceNow). It settles nothing;
 * the close is read on Bybit, as the rule says.
 *
 * NEVER OLD. Bybit's perpetual trades through the weekend and Pyth's gold
 * stops with the gold market, on Friday and for an hour every evening. A price
 * published more than PYTH_FRESH_S ago is not the price now.
 *
 * The account is mainnet's. On devnet it is not there, and the read says so.
 */
/** The program that writes Pyth's price accounts on Solana. */
const RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
/** sha256("account:PriceUpdateV2"), first eight bytes: the account's Anchor tag. */
const PRICE_UPDATE_TAG = "22f123639d7ef4cd";

/** Pyth's price accounts, by the Bybit pair each stands in for at the open: shard 0
 *  of Pyth's push oracle (pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT), the
 *  account derived from its feed id. */
export const PYTH_ACCOUNTS: Readonly<Record<string, { account: string; feed: string }>> = {
  XAUUSDT: { account: "2uPQGpm8X4ZkxMHxrAW1QuhXcse1AHEgPih6Xp9NuEWW", feed: "765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2" },
};

/** A price published longer ago than this is a closed market's, not the price now. */
export const PYTH_FRESH_S = 180;
/** A level closer than this to Pyth's price is not called from it: Pyth and Bybit
 *  sat 0.20 to 0.26% apart on 22 Oct, and they may disagree on its side. */
export const PYTH_MARGIN = 0.005;
/** Pyth's own uncertainty, past which its price says nothing. */
const MAX_CONF = 0.002;

export interface PythPrice { feed: string; price: number; conf: number; publishTime: number; full: boolean }

/** A PriceUpdateV2 account's bytes, or null for anything else. */
export function parsePriceUpdate(data: Buffer): PythPrice | null {
  if (data.length < 8 + 32 + 1 || data.subarray(0, 8).toString("hex") !== PRICE_UPDATE_TAG) return null;
  // Tag, write authority, then the verification level: Partial carries a
  // signature count, Full nothing.
  let o = 8 + 32;
  const level = data[o];
  if (level !== 0 && level !== 1) return null;
  o += level === 0 ? 2 : 1;
  if (data.length < o + 32 + 8 + 8 + 4 + 8) return null;
  const feed = data.subarray(o, o + 32).toString("hex"); o += 32;
  const price = data.readBigInt64LE(o); o += 8;
  const conf = data.readBigUInt64LE(o); o += 8;
  const expo = data.readInt32LE(o); o += 4;
  const publishTime = Number(data.readBigInt64LE(o));
  const scale = 10 ** expo;
  return { feed, price: Number(price) * scale, conf: Number(conf) * scale, publishTime, full: level === 1 };
}

type Account = { owner: string; data: Buffer } | null;
type AccountReader = (address: string) => Promise<Account>;

async function rpcAccount(address: string): Promise<Account> {
  const url = process.env.SOLANA_RPC_URL;
  if (!url) throw new Error("no SOLANA_RPC_URL");
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", commitment: "confirmed" }] }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`the Solana RPC answered ${r.status}`);
  const j = (await r.json()) as { result?: { value?: { owner: string; data: [string, string] } | null }; error?: { message?: string } };
  if (j.error) throw new Error(`the Solana RPC refused: ${String(j.error.message ?? "no reason").slice(0, 120)}`);
  const v = j.result?.value;
  return v ? { owner: v.owner, data: Buffer.from(v.data[0], "base64") } : null;
}

let reader: AccountReader | null = null;
/** Test seam: the account's bytes without a network. Null puts the RPC back. */
export function _setPythReader(r: AccountReader | null): void {
  reader = r;
}

/** Pyth's price now for a Bybit pair it stands in for, or why there is none. Never throws. */
export async function pythPrice(pool: string, now = Date.now()): Promise<{ ok: true; price: number; publishTime: number } | { ok: false; why: string }> {
  const p = PYTH_ACCOUNTS[pool];
  if (!p) return { ok: false, why: `Pyth keeps no current ${pool} price on Solana` };
  let acct: Account;
  try {
    acct = await (reader ?? rpcAccount)(p.account);
  } catch (e) {
    return { ok: false, why: `Pyth's ${pool} account could not be read: ${(e as Error).message}` };
  }
  if (!acct) return { ok: false, why: `Pyth's ${pool} account is not on chain` };
  if (acct.owner !== RECEIVER) return { ok: false, why: `Pyth's ${pool} account is not written by Pyth's receiver` };
  const u = parsePriceUpdate(acct.data);
  if (!u || u.feed !== p.feed) return { ok: false, why: `Pyth's ${pool} account does not hold its feed` };
  if (!u.full) return { ok: false, why: `Pyth's ${pool} price is only partly verified` };
  if (!(u.price > 0) || u.conf > u.price * MAX_CONF) return { ok: false, why: `Pyth's ${pool} price is too uncertain to read` };
  const age = Math.round(now / 1000 - u.publishTime);
  if (age > PYTH_FRESH_S) return { ok: false, why: `Pyth's ${pool} price was last published ${Math.round(age / 60)} minutes ago, not the price now` };
  return { ok: true, price: u.price, publishTime: u.publishTime };
}
