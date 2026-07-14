// One-time migration fix.
//
// `topped_up_at` was added with DEFAULT now(), so every device that existed
// before the renewable economy shipped had its 24-hour clock started at the
// moment of the migration rather than at its last visit. A device sitting on
// zero tokens is therefore locked out for a day — which is the exact condition
// the daily top-up was built to prevent.
//
// Backdating the stamp past one window means the next getWallet() grants. It is
// a no-op for devices at the floor: applyTopUp() grants nothing to them, it just
// advances their window. So this only ever moves tokens toward players who have
// none, which is the whole intent.
//
// Dry-run by default. Pass --commit to apply. Nothing is ever deleted here.
import pg from "pg";
import { TOKEN_FLOOR, DAILY_TOPUP } from "../src/store/economy.js";

const commit = process.argv.includes("--commit");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL, max: 2 });

const show = async (label: string) => {
  const { rows } = await pool.query<{ device_id: string; tokens: number; topped_up_at: Date }>(
    `SELECT device_id, tokens, topped_up_at FROM device_balance ORDER BY tokens, device_id`,
  );
  console.log(`\n  ${label}`);
  for (const r of rows) {
    const hrs = (Date.now() - r.topped_up_at.getTime()) / 3_600_000;
    const due = hrs >= 24 && r.tokens < TOKEN_FLOOR;
    const grant = due ? Math.min(DAILY_TOPUP, TOKEN_FLOOR - r.tokens) : 0;
    console.log(
      `    ${r.device_id.slice(0, 8)}  ${String(r.tokens).padStart(4)} token  ` +
        `son dolum ${hrs.toFixed(1)}sa once  ${due ? `-> sonraki ziyarette +${grant}` : "-> beklemede"}`,
    );
  }
  return rows;
};

const before = await show("ONCE");
const affected = before.filter((r) => r.tokens < TOKEN_FLOOR);
console.log(`\n  ${affected.length}/${before.length} cihaz tabanin (${TOKEN_FLOOR}) altinda ve dolum alacak.`);

if (!commit) {
  console.log("\n  kuru calisma. uygulamak icin --commit");
  await pool.end();
  process.exit(0);
}

// Every row, not just the broke ones: a device at the floor gets no grant from
// applyTopUp anyway, and leaving its clock at the migration moment would make
// "when is my next top-up" wrong for it too.
const res = await pool.query(`UPDATE device_balance SET topped_up_at = now() - interval '24 hours 1 minute'`);
console.log(`\n  ${res.rowCount} satir geriye alindi.`);
await show("SONRA");
await pool.end();
