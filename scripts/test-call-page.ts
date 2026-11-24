/**
 * A SETTLED CALL'S OWN PAGE (Lev, 24 Nov): /live/<platform>/<slug>/call/<id>.
 *
 * The card was a picture behind a link; its page is what a post links to. The
 * post is written from the call's own answers and says how chat voted only
 * when that is exactly true; only an X channel is tagged; the tags a crawler
 * reads name the card; and the page's data hands the page its card and its
 * post. A call that is not there still opens its channel's page.
 */
if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database: unset DATABASE_URL");
  process.exit(1);
}
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { renderCalledItCard } from "../src/card/renderCalledItCard.js";
import { callPageHtml, callPath, callPost, cardPath, postIntentUrl } from "../src/live/callPage.js";
import { addChannelRoutes, type ChannelPageDeps } from "../src/live/channelRoutes.js";
import { _resetLiveStore, liveStore, saveCallFrame, saveChannel } from "../src/store/live.js";

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (ok) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
};

console.log("\nthe post about a settled call\n");
const xCh = { slug: "Showdown_TCG", name: "Showdown" };
const upset = callPost({ question: "Can Vib beat StanCifka?", outcome: "yes", yes: 1, no: 3 }, "x", xCh);
check("the room voted the other way: that is the first line, the result the second, the stream last",
  upset === 'Chat voted no on "Can Vib beat StanCifka?"\n\nIt was yes.\n\nOn @Showdown_TCG\'s stream.', JSON.stringify(upset));
check("...the other way round too", callPost({ question: "q?", outcome: "no", yes: 3, no: 1 }, "x", xCh).startsWith('Chat voted yes on "q?"\n\nIt was no.'));
const plain = callPost({ question: "Can Ondrej beat StanCifka?", outcome: "no", yes: 1, no: 2 }, "x", xCh);
check("a room that was right gets the question and the result", plain === '"Can Ondrej beat StanCifka?"\n\nNo, on @Showdown_TCG\'s stream.', JSON.stringify(plain));
check("two answers are not a vote, and a tie says nothing about one",
  !callPost({ question: "q?", outcome: "yes", yes: 0, no: 2 }, "x", xCh).includes("Chat voted")
  && !callPost({ question: "q?", outcome: "yes", yes: 2, no: 2 }, "x", xCh).includes("Chat voted"));
check("no post starts with @, which X reads as a reply", [upset, plain].every((p) => !p.startsWith("@")));
const kickPost = callPost({ question: "will I win this game?", outcome: "yes", yes: 1, no: 3 }, "kick", { slug: "bee_empire", name: "Bee Empire" });
check("only an X channel is tagged: a Kick or Twitch name gets no @, and says where it streams",
  !kickPost.includes("@") && kickPost.endsWith("On Bee Empire's Kick stream."), JSON.stringify(kickPost));
check("...not even when the channel's own name carries one",
  !callPost({ question: "q?", outcome: "yes", yes: 3, no: 0 }, "twitch", { slug: "s", name: "@somebody" }).includes("@"));
check("...and a channel with no name goes by its slug", callPost({ question: "q?", outcome: "yes", yes: 3, no: 0 }, "twitch", { slug: "bee_empire", name: null }).endsWith("on bee_empire's Twitch stream."));
const long = callPost({ question: "w".repeat(180), outcome: "yes", yes: 1, no: 3 }, "x", { slug: "a_handle_of_15c", name: null });
check("the longest question still leaves room for the link in X's 280", long.length + 1 + 23 <= 280, String(long.length));
const intent = postIntentUrl(upset, "https://app.oddie.fun/live/x/Showdown_TCG/call/7");
const got = new URL(intent);
check("the post opens in X's own compose window, written, with the call's page as its link",
  got.origin + got.pathname === "https://x.com/intent/post" && got.searchParams.get("text") === upset
  && got.searchParams.get("url") === "https://app.oddie.fun/live/x/Showdown_TCG/call/7");
check("...with no bare apostrophe to end the link early", !intent.includes("'") && intent.includes("%27"));

console.log("\nwhat a crawler reads\n");
const shell = "<!doctype html><title>oddie</title><body>page</body>";
const html = callPageHtml(shell, { question: 'Can "Vib" beat <Stan> & win $& all?', outcome: "yes", yes: 1, no: 3 }, "x", xCh,
  "https://app.oddie.fun/live/x/Showdown_TCG/call/7", "https://app.oddie.fun/api/live/x/Showdown_TCG/card/7.png?v=2");
check("the card is the picture X draws under the link",
  html.includes('<meta name="twitter:card" content="summary_large_image">')
  && html.includes('<meta property="og:image" content="https://app.oddie.fun/api/live/x/Showdown_TCG/card/7.png?v=2">')
  && html.includes('<meta name="twitter:image" content="https://app.oddie.fun/api/live/x/Showdown_TCG/card/7.png?v=2">')
  && html.includes('<meta property="og:image:width" content="2000">') && html.includes('<meta property="og:image:height" content="1125">'));
check("the title is the result on its question, and the description says how chat voted",
  html.includes("<title>YES: Can &quot;Vib&quot; beat &lt;Stan&gt; &amp; win $&amp; all? · oddie</title>")
  && html.includes(`<meta property="og:description" content="Chat voted no. Settled on Showdown's X stream.">`)
  && html.includes('<link rel="canonical" href="https://app.oddie.fun/live/x/Showdown_TCG/call/7">'), html.slice(0, 400));
check("a question's own characters never break out of a tag", !/content="[^"]*<Stan>/.test(html) && !html.includes('"Vib"'));
check("the page under the tags is the channel's own", html.endsWith("<body>page</body>"));
check("a room that was right is not said to have voted against it",
  !callPageHtml(shell, { question: "q?", outcome: "no", yes: 1, no: 3 }, "kick", { slug: "s", name: null }, "u", "c").includes("Chat voted")
  && callPageHtml(shell, { question: "q?", outcome: "no", yes: 1, no: 3 }, "kick", { slug: "s", name: null }, "u", "c").includes("Settled on s's Kick stream."));
check("the paths are the routes' own", callPath("x", "Showdown_TCG", "7") === "/live/x/Showdown_TCG/call/7"
  && cardPath("kick", "a b", "7", 2) === "/api/live/kick/a%20b/card/7.png?v=2");

console.log("\nthe card says how chat voted\n");
const card = (chatVoted: "yes" | "no" | null, outcome: "yes" | "no") =>
  renderCalledItCard({ question: "Can Vib beat StanCifka?", outcome, channel: "Showdown", where: "X Live", calledIt: ["sol_mika"], frameJpeg: null, chatVoted });
check("a YES the room voted against: the vote in NO's pink, beside the result in YES's yellow",
  /fill="#FF2D78">Chat voted no\.<\/text>/.test(card("no", "yes")) && /fill="#FCF604">YES<\/text>/.test(card("no", "yes")) && card("no", "yes").includes("@sol_mika called it."));
check("a NO the room voted against: the vote in yellow, the result in pink",
  /fill="#FCF604">Chat voted yes\.<\/text>/.test(card("yes", "no")) && /fill="#FF2D78">NO<\/text>/.test(card("yes", "no")));
check("a room that was right, or too small to be a vote, draws no vote", !card("yes", "yes").includes("Chat voted") && !card(null, "yes").includes("Chat voted")
  && !renderCalledItCard({ question: "q?", outcome: "yes", channel: "c", where: "Kick", calledIt: [], frameJpeg: null }).includes("Chat voted"));

console.log("\nthe routes\n");
_resetLiveStore();
const T = Date.UTC(2026, 10, 24, 12);
for (const [channelId, slug, name] of [["100", "streamer", "Bee"], ["200", "other", "Other"]] as const) {
  await saveChannel({ platform: "kick", channelId, slug, name, avatar: null, accessToken: null, refreshToken: null, tokenExpiresAt: null, active: true });
}
async function settled(channelId: string, question: string, picks: Array<[string, "yes" | "no"]>, outcome: "yes" | "no", at: number, frame?: Buffer): Promise<string> {
  const c = await liveStore.open({ platform: "kick", channelId, question, openedById: "host", openedByName: "host", openedAt: at, closesAt: at + 30 * 60_000, timed: false });
  if (!c) throw new Error("not opened");
  let i = 0;
  for (const [who, side] of picks) await liveStore.pick(c, who, who, side, at + ++i * 1000);
  await liveStore.settle(c.id, outcome, 100, at + 60_000);
  if (frame) await saveCallFrame(c.id, frame, "");
  return c.id;
}
const wonId = await settled("100", "will I win this game?", [["a", "yes"], ["b", "no"], ["c", "no"], ["d", "no"]], "yes", T);
const plainId = await settled("100", "will he clutch this?", [["a", "yes"], ["b", "yes"], ["c", "no"]], "yes", T + 3_600_000);
const open = await liveStore.open({ platform: "kick", channelId: "100", question: "still open?", openedById: "host", openedByName: "host", openedAt: T + 7_200_000, closesAt: T + 9_000_000, timed: false });

let pageIsOpen = true;
const deps: ChannelPageDeps = {
  appBaseUrl: "https://app.oddie.fun/", pageHtml: () => shell, pageOpen: () => pageIsOpen, pageClosed: (res) => { res.status(404).end(); }, log: () => {},
};
const app = express();
const router = express.Router();
addChannelRoutes(router, "kick", deps);
app.use(router);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const get = (p: string) => fetch(base + p);
try {
  const page = await get(`/live/kick/streamer/call/${wonId}`);
  const body = await page.text();
  check("a settled call's page is the channel's page with the call's tags in its head",
    page.status === 200 && /text\/html/.test(page.headers.get("content-type") ?? "") && body.endsWith("<body>page</body>")
    && body.includes(`<meta property="og:image" content="https://app.oddie.fun/api/live/kick/streamer/card/${wonId}.png?v=2">`)
    && body.includes(`<meta property="og:url" content="https://app.oddie.fun/live/kick/streamer/call/${wonId}">`)
    && body.includes("<title>YES: will I win this game? · oddie</title>") && body.includes("Chat voted no. Settled on Bee's Kick stream."), body.slice(0, 300));
  check("...and is asked for again every time, like the channel's own", page.headers.get("cache-control") === "no-cache");
  for (const [what, path] of [["a call that does not exist", "/live/kick/streamer/call/999"], ["a call still open", `/live/kick/streamer/call/${open?.id}`],
    ["another channel's call", `/live/kick/other/call/${wonId}`], ["a channel that does not exist", `/live/kick/nobody/call/${wonId}`]] as const) {
    const r = await get(path);
    check(`${what} still opens the channel's page, with no card claimed`, r.status === 200 && (await r.text()) === shell);
  }
  check("an address with no number in it opens the channel's page too, and a longer one is nobody's",
    (await (await get("/live/kick/streamer/call/abc")).text()) === shell && (await get("/live/kick/streamer/call/12/more")).status === 404);
  pageIsOpen = false;
  check("while the app is closed the call's page is closed with it", (await get(`/live/kick/streamer/call/${wonId}`)).status === 404);
  pageIsOpen = true;

  type Api = { shown: { id: string; question: string; outcome: string; card: string; post: string } | null;
    recent: Array<{ id: string; question: string; card: string | null; page: string | null }> };
  const data = await (await get(`/api/live/kick/streamer?call=${wonId}`)).json() as Api;
  const post = data.shown ? new URL(data.shown.post) : null;
  check("the page's data hands it the call it was opened for: its card and its post",
    data.shown?.id === wonId && data.shown.question === "will I win this game?" && data.shown.outcome === "yes"
    && data.shown.card === `/api/live/kick/streamer/card/${wonId}.png?v=2`
    && post?.searchParams.get("url") === `https://app.oddie.fun/live/kick/streamer/call/${wonId}`
    && post?.searchParams.get("text") === 'Chat voted no on "will I win this game?"\n\nIt was yes.\n\nOn Bee\'s Kick stream.', JSON.stringify(data.shown));
  check("every settled call in the list names its own page and its number",
    data.recent.length === 2 && data.recent[0].id === plainId && data.recent[0].page === `/live/kick/streamer/call/${plainId}`
    && data.recent[1].id === wonId && data.recent[1].card === `/api/live/kick/streamer/card/${wonId}.png?v=2`, JSON.stringify(data.recent));
  check("the channel's own page is handed no call", (await (await get("/api/live/kick/streamer")).json() as Api).shown === null);
  check("...nor is a page opened for a call that is not this channel's, not settled, or not a number",
    (await (await get(`/api/live/kick/other?call=${wonId}`)).json() as Api).shown === null
    && (await (await get(`/api/live/kick/streamer?call=${open?.id}`)).json() as Api).shown === null
    && (await (await get("/api/live/kick/streamer?call=1%20OR%201")).json() as Api).shown === null
    && (await (await get(`/api/live/kick/streamer?call=${wonId}&call=${plainId}`)).json() as Api).shown === null);

  const png = await get(`/api/live/kick/streamer/card/${wonId}.png?v=2`);
  const bytes = Buffer.from(await png.arrayBuffer());
  check("the card is a picture kept for good", png.status === 200 && /image\/png/.test(png.headers.get("content-type") ?? "")
    && bytes.subarray(1, 4).toString("latin1") === "PNG" && /immutable/.test(png.headers.get("cache-control") ?? ""), `${png.status} ${bytes.length}`);
  check("...and not through another channel's address", (await get(`/api/live/kick/other/card/${wonId}.png`)).status === 404);
} finally {
  server.close();
}

console.log("\nthe page that draws it\n");
const live = readFileSync("public/app/live.html", "utf8");
check("the page knows a call's address under its channel's", live.includes("(?:\\/call\\/(\\d{1,18}))?") && live.includes('(CALL ? "?call=" + CALL : "")'));
check("...draws the call's card on top, with one way to post it", live.includes('<section class="shown">') && live.includes(">Post on X</a>") && live.includes("esc(sh.post)"));
check("...does not say that call a second time in the list under it", live.includes("return !sh || r.id !== sh.id;"));
check("...and a settled call's Card link opens its page, not the bare picture", live.includes("esc(r.page)") && !live.includes("esc(r.card)"));

console.log(failures === 0 ? "\nall call page checks passed.\n" : `\n${failures} call page check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
