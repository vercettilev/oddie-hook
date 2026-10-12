// The public market list's order (src/marketOrder.ts): money first, then among
// empty markets the soonest close first, closed-but-unsettled ones last.
import { byMarketOrder, type Orderable } from "../src/marketOrder.js";

let failed = 0;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}`); if (!ok) failed++; };

const NOW = Date.parse("2026-10-12T20:00:00Z");
const h = (hours: number) => new Date(NOW + hours * 3600_000).toISOString();
const m = (slug: string, sol: number, closesAt: string | null, stakers = sol > 0 ? 1 : 0): Orderable =>
  ({ slug, closesAt, stakers, pool: { totalSol: sol } });

// bee_empire's screenshot, 12 Oct: three funded, then empty ones in the wrong order.
const items = [
  m("btc-200k-2027", 0.11, h(24 * 80)),
  m("btc-80k-cpi", 0.1, h(40)),
  m("btc-ath", 0, h(24 * 80)),
  m("btc-100k-2026", 0, h(24 * 79)),
  m("btc-83k-today", 0, h(4)),
  m("vibhu-colosseum", 0.51, h(24 * 80)),
  m("no-close", 0, null),
  m("btc-130k-friday", 0, h(-72)),     // closed three days ago, not settled
  m("closed-yesterday", 0, h(-20)),
];
const order = [...items].sort(byMarketOrder({}, NOW)).map((x) => x.slug);
check("funded markets lead, biggest pool first",
  order.slice(0, 3).join() === "vibhu-colosseum,btc-200k-2027,btc-80k-cpi");
check("then the empty ones, soonest close first",
  order.slice(3, 6).join() === "btc-83k-today,btc-100k-2026,btc-ath");
check("a market with no close sorts as the furthest open one", order[6] === "no-close");
check("closed but unsettled go last, the most recently closed first",
  order.slice(7).join() === "closed-yesterday,btc-130k-friday");

// An unreadable pool (null) with wallets in it still outranks an empty market.
const unread = [m("empty-soon", 0, h(1)), { slug: "unreadable", closesAt: h(500), stakers: 3, pool: null }];
check("stakers keep an unreadable funded market above an empty one",
  [...unread].sort(byMarketOrder({}, NOW))[0].slug === "unreadable");

// Views only break a tie between markets closing at the same moment.
const tie = [m("quiet", 0, h(10)), m("watched", 0, h(10)), m("sooner", 0, h(5))];
const byViews = [...tie].sort(byMarketOrder({ watched: 40, quiet: 2, sooner: 0 }, NOW)).map((x) => x.slug);
check("close time beats views, views break a tie", byViews.join() === "sooner,watched,quiet");

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log("market order: all passed");
