// The Room announcement: which markets reach it, what it says, and the ledger
// row that makes later bet pings and the result land under it.
//
// Offline: the Telegram send and the ledger write are fakes.
//
// Run with: npm run test-room

import { announceToRoom, isRoomSource, openedOn, roomChatId, roomText, type RoomDeps } from "../src/telegram/room.js";
import { parseTgKey } from "../src/telegram/resolution.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

const ROOM = -1004355810770;

console.log("\nthe room's chat id");
check("defaults to the Room", roomChatId({}) === ROOM);
check("an env id replaces it", roomChatId({ TELEGRAM_ROOM_CHAT_ID: "-1001234567890" }) === -1001234567890);
check("\"off\" switches it off", roomChatId({ TELEGRAM_ROOM_CHAT_ID: "off" }) === null);
check("a positive or garbled id is no room at all", roomChatId({ TELEGRAM_ROOM_CHAT_ID: "12345" }) === null
  && roomChatId({ TELEGRAM_ROOM_CHAT_ID: "room" }) === null);

console.log("\na market tagged inside the Room is not announced twice");
check("public link to the Room", isRoomSource("https://t.me/oddieroom/42", ROOM));
check("...whatever the case", isRoomSource("https://t.me/OddieRoom/42", ROOM));
check("internal link to the Room", isRoomSource("https://t.me/c/4355810770/42", ROOM));
check("another public group is not the Room", !isRoomSource("https://t.me/somegroup/42", ROOM));
check("another private group is not the Room", !isRoomSource("https://t.me/c/4413284410/2", ROOM));
check("a tweet is not the Room", !isRoomSource("https://x.com/someone/status/1", ROOM));
check("no source is not the Room", !isRoomSource(null, ROOM));

console.log("\nwhere it was opened");
check("X", openedOn("https://x.com/someone/status/1") === "X");
check("...twitter.com too", openedOn("https://twitter.com/someone/status/1") === "X");
check("Telegram", openedOn("https://t.me/c/4413284410/2") === "Telegram");
check("Kick chat marker", openedOn("kick-chat:oddiefun/abc") === "Kick");
check("nothing known says nothing", openedOn(null) === null && openedOn("not a url") === null);

console.log("\nwhat it says");
const t = roomText("BTC to $200k by 2027?", "X");
check("headline first", t.startsWith("BTC to $200k by 2027?\n"));
check("where, then the ask", t.endsWith("Opened on X. Pick a side."));
check("no place, just the ask", roomText("SOL above $120?", null) === "SOL above $120?\nPick a side.");
check("never names anybody", !/opened by|@/i.test(t));

console.log("\nannouncing");
function fake(chatId: number | null) {
  const sent: Array<{ chatId: number; text: string; url: string }> = [];
  const rows: Array<{ key: string; slug: string }> = [];
  const deps: RoomDeps = {
    chatId,
    send: async (c, text, url) => { sent.push({ chatId: c, text, url }); return { message_id: 77 }; },
    record: async (key, slug) => { rows.push({ key, slug }); },
    log: () => {},
  };
  return { deps, sent, rows };
}
const m = { slug: "btc-200k", headline: "BTC to $200k by 2027?", url: "https://app.oddie.fun/m/btc-200k", sourceUrl: "https://x.com/someone/status/1" };
{
  const f = fake(ROOM);
  const out = await announceToRoom(f.deps, m);
  check("a market from X is announced", out === "announced" && f.sent.length === 1 && f.sent[0].chatId === ROOM);
  check("the button carries the market link", f.sent[0]?.url === m.url);
  check("the ledger row is the sent message", f.rows[0]?.key === `tg:${ROOM}:77` && f.rows[0]?.slug === "btc-200k");
  const parsed = parseTgKey(f.rows[0]?.key ?? "");
  check("...in the shape the result and bet pings read", parsed?.chatId === ROOM && parsed?.messageId === 77);
}
{
  const f = fake(ROOM);
  const out = await announceToRoom(f.deps, { ...m, sourceUrl: "https://t.me/oddieroom/9" });
  check("a market tagged in the Room is skipped", out === "room-source" && f.sent.length === 0 && f.rows.length === 0);
}
{
  const f = fake(null);
  const out = await announceToRoom(f.deps, m);
  check("off means nothing is sent", out === "off" && f.sent.length === 0);
}
{
  const f = fake(ROOM);
  f.deps.send = async () => { throw new Error("Bad Request: chat not found"); };
  const out = await announceToRoom(f.deps, m);
  check("a failed send writes no row", out === "failed" && f.rows.length === 0);
}

if (failures) { console.error(`\n${failures} room check(s) failed`); process.exit(1); }
console.log("\nall room checks passed");
