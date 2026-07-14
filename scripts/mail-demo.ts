// Read-only: take a REAL settled position and show the exact email the
// pipeline produces for it — subject, body, and the dry-run send.
import pg from "pg";
import { settleMailBody, sendSettleMail } from "../src/mail.js";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const { rows } = await pool.query(`
  SELECT mc.side, mc.pct_at, mc.exit_pct, mc.proceeds, mc.tokens, ms.question
    FROM market_call mc JOIN market_slug ms ON ms.slug = mc.slug
   WHERE mc.closed_at IS NOT NULL AND mc.exit_pct = 100 ORDER BY mc.closed_at DESC LIMIT 1`);
const r = rows[0];
const m = {
  to: "winner@example.com", question: r.question, side: r.side, entryPct: r.pct_at,
  outcome: (r.exit_pct === 100 ? r.side : r.side === "yes" ? "no" : "yes") as "yes"|"no",
  proceeds: r.proceeds, stake: r.tokens, positionsUrl: "https://poppin.so/feed#/positions",
};
const { subject, html } = settleMailBody(m);
console.log("── GERCEK settled pozisyon:", `${r.side.toUpperCase()} @${r.pct_at}% -> ${r.exit_pct}%, +${r.proceeds}`);
console.log("── subject:", subject);
console.log("── body (html):"); console.log(html);
console.log("── send sonucu:", await sendSettleMail(m));
await pool.end();
