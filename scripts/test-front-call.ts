/**
 * THE FRONT DOOR'S REAL CALL AND THE SEASON (Lev, 3 Nov, after CRSH).
 *
 * showcaseCalls picks the one call the landing shows: the one taking answers
 * on a streamer's channel, else the newest the screen settled (it has the
 * picture Oddie read). The house's own channels never stand in for a
 * streamer's, a call settled by hand (no picture) is not proof of the screen,
 * and the names under it are the people who called it right, the house left
 * out. The season is a calendar month in UTC.
 */
import { seasonEnd, seasonStart } from "../src/live/calls.js";
import { calledItLine, renderCalledItCard, wrapLines } from "../src/card/renderCalledItCard.js";
import { _resetLiveStore, liveStore, saveCallFrame, saveChannel, showcaseCalls } from "../src/store/live.js";

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
};

console.log("\nthe season\n");
const midNov = Date.UTC(2026, 10, 15, 12);
check("starts on the 1st, 00:00 UTC", seasonStart(midNov) === Date.UTC(2026, 10, 1));
check("ends where the next month starts", seasonEnd(midNov) === Date.UTC(2026, 11, 1));
check("December's runs into January of the next year", seasonEnd(Date.UTC(2026, 11, 31, 23)) === Date.UTC(2027, 0, 1));
check("a moment east of Greenwich on the 1st is still the old month in UTC",
  seasonStart(Date.UTC(2026, 10, 30, 22)) === Date.UTC(2026, 10, 1));

console.log("\nthe real call on the front door\n");
_resetLiveStore();
const empty = await showcaseCalls();
check("nothing to show: both empty, so the scripted chat stays", empty.live === null && empty.settled === null);

const T = Date.UTC(2026, 10, 2, 19);
const channel = async (platform: "x" | "twitch", channelId: string, slug: string, name: string) =>
  saveChannel({ platform, channelId, slug, name, avatar: null, accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
await channel("x", "100", "Showdown_TCG", "Showdown");
await channel("x", "200", "levvercetti", "Lev");
await channel("twitch", "300", "bee_empire", "Bee_Empire");

const open = async (platform: "x" | "twitch", channelId: string, question: string, at: number) => {
  const c = await liveStore.open({ platform, channelId, question, openedById: "host", openedByName: "host", openedAt: at, closesAt: at + 600_000, timed: false });
  if (!c) throw new Error(`could not open ${question}`);
  return c;
};

// A screen-settled call on a streamer's channel, answered by two people and the house.
const read = await open("x", "100", "Can Roothlus beat StanCifka?", T);
await liveStore.pick(read, "u1", "uncleogac", "no", T + 30_000);
await liveStore.pick(read, "u2", "mozaiiic", "yes", T + 40_000);
await liveStore.pick(read, "u3", "levvercetti", "no", T + 10_000);
await liveStore.settle(read.id, "no", 100, T + 900_000);
await saveCallFrame(read.id, Buffer.from("jpeg"), "VICTORY WINNER: STANCIFKA");

// Newer, but settled by hand: no picture, so not proof of the screen.
const byHand = await open("twitch", "300", "will BTC close green?", T + 2_000_000);
await liveStore.pick(byHand, "u4", "litre46", "yes", T + 2_010_000);
await liveStore.settle(byHand.id, "yes", 100, T + 2_100_000);

// The house's own channel, newest of all and with a picture: never shown.
const house = await open("x", "200", "test?", T + 3_000_000);
await liveStore.settle(house.id, "yes", 100, T + 3_100_000);
await saveCallFrame(house.id, Buffer.from("jpeg"), "");

let shown = await showcaseCalls();
check("the settled call shown is the newest one the screen settled", shown.settled?.question === "Can Roothlus beat StanCifka?",
  shown.settled?.question);
check("...on a streamer's channel, never the house's", shown.settled?.slug === "Showdown_TCG");
check("...with its split", shown.settled?.yes === 1 && shown.settled?.no === 2, JSON.stringify(shown.settled));
check("...and who called it right, the house left out", JSON.stringify(shown.settled?.calledIt) === JSON.stringify(["uncleogac"]),
  JSON.stringify(shown.settled?.calledIt));
check("no call taking answers: nothing live", shown.live === null);

// A call taking answers on a streamer's channel is what the front door shows first.
const now = await open("twitch", "300", "Will Bee close the next candle green?", T + 4_000_000);
await liveStore.pick(now, "u5", "litre46", "yes", T + 4_010_000);
await open("x", "200", "house test still open?", T + 4_100_000);
shown = await showcaseCalls();
check("a streamer's call taking answers is live", shown.live?.question === "Will Bee close the next candle green?", shown.live?.question);
check("...with nobody named while it is open", shown.live?.calledIt.length === 0 && shown.live?.yes === 1);
check("...and the settled one is still there for when it closes", shown.settled?.question === "Can Roothlus beat StanCifka?");

console.log("\nthe called-it card\n");
check("names who called it, three at most", calledItLine(["a", "b"]) === "@a and @b called it."
  && calledItLine(["a", "b", "c"]) === "@a, @b and @c called it.");
check("nobody right says so", calledItLine([]) === "Nobody called it.");
check("long names make room with 'and N more'",
  calledItLine(["averyveryverylongname1", "averyveryverylongname2", "x"]) === "@averyveryverylongname1 and 2 more called it.",
  calledItLine(["averyveryverylongname1", "averyveryverylongname2", "x"]));
check("a question wraps to two lines and ends on an ellipsis past that",
  wrapLines("WILL ALEKSA CRACK THE TOP 10 WITH 1066+ POINTS THIS RUN AND THEN DO IT AGAIN TOMORROW NIGHT?", 40, 2).length === 2
  && wrapLines("WILL ALEKSA CRACK THE TOP 10 WITH 1066+ POINTS THIS RUN AND THEN DO IT AGAIN TOMORROW NIGHT?", 40, 2)[1].endsWith("…"));
const svg = renderCalledItCard({ question: "Can Roothlus beat StanCifka?", outcome: "no", channel: "Aleksa Flamingo 🦩", where: "X Live",
  calledIt: ["uncleogac"], frameJpeg: Buffer.from("jpeg") });
check("the card draws the frame, the result and who called it", svg.includes("data:image/jpeg;base64,")
  && svg.includes(">NO</text>") && svg.includes("@uncleogac called it."));
check("an emoji in a channel's name is left out (the card's fonts draw none)", svg.includes(">ALEKSA FLAMINGO · X LIVE</text>"));
check("a call settled by hand makes no claim about the screen",
  !renderCalledItCard({ question: "q?", outcome: "yes", channel: "c", where: "Kick", calledIt: [], frameJpeg: null }).includes("off the stream"));

console.log(failures === 0 ? "\nall front-door call checks passed.\n" : `\n${failures} front-door call check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
