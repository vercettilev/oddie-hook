// One definition of what a pool is worth. These pin the three things that were
// actually wrong in production, not the shape of the function.
import { oddsFromPools, type OddsView } from "../src/odds.js";
import { renderCard } from "../src/card/renderCard.js";
import type { Market } from "../src/venues/types.js";

let failures = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (ok) console.log(`  ✓ ${n}`);
  else { failures++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); }
};

const SOL = 1e9;
const FEE = { creatorBps: 200, protocolBps: 200 }; // the 4% this product charges

/* THE LIVE MARKET THAT STARTED THIS. 0.5 SOL on yes, nothing on no. The card
   printed "50%" and "yes pays 1.9x"; the API published 99. Neither number was
   the money, and the multiple was a promise the chain cannot keep: with an
   empty other side a yes win returns the stake and no more. */
{
  const v = oddsFromPools(0.5 * SOL, 0, FEE);
  check("a pool with one empty side has no price", v.state === "one-sided", v.state);
  check("...and names the side holding the money", v.state === "one-sided" && v.side === "yes",
    JSON.stringify(v));
  check("...and quotes no multiple at all", !("yesPays" in v), JSON.stringify(v));
}

/* THE CLAMP THAT INVENTED A NUMBER. The old API line ran the share through
   Math.max(1, Math.min(99, ...)), so a pool that was 100% one way published
   itself as 99 -- a figure nobody's money made. */
{
  const v = oddsFromPools(3 * SOL, 0, FEE);
  check("a 100% pool is never published as 99", v.state !== "priced", v.state);
}

/* BOTH SIDES FUNDED: a real price and a real multiple, and the multiple is the
   chain's own formula -- winning_leg x (pool - fees) / winning_total. */
{
  const v = oddsFromPools(1 * SOL, 1 * SOL, FEE) as Extract<OddsView, { state: "priced" }>;
  check("an even pool prices at 50", v.state === "priced" && v.yesPct === 50, JSON.stringify(v));
  check("...and pays 1.92x, net of the 4% nobody ever collects",
    v.yesPays === 1.92 && v.noPays === 1.92, `${v.yesPays}/${v.noPays}`);
}
{
  // The underdog collects more, and the sum of what each side risks is the pool.
  const v = oddsFromPools(3 * SOL, 1 * SOL, FEE) as Extract<OddsView, { state: "priced" }>;
  check("the money share is the price", v.yesPct === 75, String(v.yesPct));
  check("...the crowded side pays least", v.yesPays === 1.28, String(v.yesPays));
  check("...and the lonely side most", v.noPays === 3.84, String(v.noPays));
  /* The invariant that makes the multiple real: paying every winner on a side
     must spend exactly the pool minus the takeout, never more. */
  const paidIfYes = 3 * v.yesPays;
  check("...and a side's payout never exceeds the pool net of fees",
    Math.abs(paidIfYes - 4 * 0.96) < 0.02, `${paidIfYes} vs ${4 * 0.96}`);
}

/* PER-MARKET RATES. A market with no creator to pay is minted at 0, and quoting
   a single constant against it understates what its winners collect. */
{
  const v = oddsFromPools(1 * SOL, 1 * SOL, { creatorBps: 0, protocolBps: 200 }) as
    Extract<OddsView, { state: "priced" }>;
  check("a market that pays no creator hands more to its winners",
    v.yesPays === 1.96, String(v.yesPays));
}

/* THE READ THAT FAILED. An unreadable pool is never an empty one: a page that
   says "nothing staked" over real money is the lie the read layer exists to
   stop. */
{
  check("a pool that could not be read says so", oddsFromPools(null, 0, FEE).state === "unreadable");
  check("...and so does a half-read one", oddsFromPools(1 * SOL, undefined, FEE).state === "unreadable");
  check("a genuinely empty pool is unpriced, not unreadable",
    oddsFromPools(0, 0, FEE).state === "unpriced");
}

/* THE CARD IS THE SURFACE THAT TRAVELS, so the three states are pinned on the
   rendered SVG rather than on the function that feeds it. */
const mkt = {
  venue: "community", venueId: "1", question: "Will $ORE reach $80 today?",
  yesPct: 50, closesAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
  volumeUsd: 0, venueUrl: "", tags: [],
} as unknown as Market;

{
  // The live market that started this: 0.5 SOL on yes, nothing on no.
  const svg = renderCard(mkt, { pools: { yes: 0.5 * SOL, no: 0, creatorFeeBps: 200 } });
  check("a one-sided card quotes no multiple", !/pays/.test(svg), (svg.match(/pays [^<]*/) || [""])[0]);
  check("...and says what is actually true", /nothing on the other side/.test(svg));
  check("...and prints no percentage hero", !/>\d+%</.test(svg), (svg.match(/>\d+%</) || [""])[0]);
}
{
  const svg = renderCard(mkt, { pools: { yes: 1 * SOL, no: 3 * SOL, creatorFeeBps: 200 } });
  check("a two-sided card prices off the money, not the stored 50", /25%/.test(svg),
    (svg.match(/>\d+%</g) || []).join(","));
  check("...and quotes the multiple the chain will pay", /pays 3\.8/.test(svg),
    (svg.match(/pays [^<]*/) || [""])[0]);
}
{
  const svg = renderCard(mkt, { pools: null });
  check("a chain that would not answer prices nothing", !/pays/.test(svg) && !/>\d+%</.test(svg));
}

console.log(failures ? `\n${failures} failure(s)\n` : "\nall green\n");
process.exit(failures ? 1 : 0);
