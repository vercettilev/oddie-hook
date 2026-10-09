// @oddiefun's own posts into the Room: which posts go, what they look like,
// and the cursor that never skips one. Then the two X client pieces the relay
// leans on: the read itself, and one token refresh at a time.
//
// Offline: Telegram and the store are fakes, and X is a stubbed fetch.
//
// Run with: npm run test-tweet-relay

if (process.env.DATABASE_URL) {
  console.error("refusing to run against a database. Unset DATABASE_URL.");
  process.exit(1);
}

import { relayOwnTweets, relayText, type RelayDeps } from "../src/telegram/tweetRelay.js";
import type { OwnTweet } from "../src/x/client.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); if (detail) console.error(`      ${detail}`); }
};

const post = (id: string, text: string, extra: Partial<OwnTweet> = {}): OwnTweet =>
  ({ id, text, urls: [], quotedId: null, repliedToId: null, createdAt: null, ...extra });

console.log("\nwhat a relayed post says");
{
  const t = relayText(post("123", "the next big call."), "oddiefun");
  check("the text, then the link on its own line", t === "the next big call.\n\nhttps://x.com/oddiefun/status/123");
  const linked = relayText(post("124", "read this https://t.co/abc", { urls: [{ url: "https://t.co/abc", expanded: "https://oddie.fun/blog" }] }), "oddiefun");
  check("a t.co link becomes where it really goes", linked.startsWith("read this https://oddie.fun/blog\n"));
  const media = relayText(post("125", "COMING SOON https://t.co/vid", { urls: [{ url: "https://t.co/vid", expanded: "https://x.com/oddiefun/status/125/video/1" }] }), "oddiefun");
  check("the post's own media link is dropped (the preview shows it)", media === "COMING SOON\n\nhttps://x.com/oddiefun/status/125");
  check("X's escaping is undone", relayText(post("126", "predict &amp; don't argue &lt;3"), "oddiefun").startsWith("predict & don't argue <3"));
  check("a post that is only media is only its link", relayText(post("127", "https://t.co/p", { urls: [{ url: "https://t.co/p", expanded: "https://x.com/oddiefun/status/127/photo/1" }] }), "oddiefun") === "https://x.com/oddiefun/status/127");
  const long = relayText(post("128", "x".repeat(9000)), "oddiefun");
  check("a long post is cut well inside Telegram's 4096", long.length < 4096 && long.includes("…\n\nhttps://x.com/oddiefun/status/128"));
}

function fake(timeline: OwnTweet[], cursor: string | null, chatId: number | null = -100) {
  const sent: string[] = [];
  const reads: Array<string | null> = [];
  const state = { cursor };
  const deps: RelayDeps = {
    chatId,
    handle: "oddiefun",
    ownTweets: async (since) => { reads.push(since); return timeline; },
    cursorGet: async () => state.cursor,
    cursorSet: async (id) => { state.cursor = id; },
    send: async (_c, text) => { sent.push(text); },
    log: () => {},
  };
  return { deps, sent, reads, state };
}

console.log("\nwhich posts go");
{
  const f = fake([post("1", "x")], "0", null);
  const r = await relayOwnTweets(f.deps);
  check("no Room, no read and no post", r.outcome === "off" && f.reads.length === 0 && f.sent.length === 0);
}
{
  // newest first, the way X returns them, and ids of different lengths
  const f = fake([post("1000", "newest"), post("999", "older")], null);
  const r = await relayOwnTweets(f.deps);
  check("the first run sends nothing", r.outcome === "primed" && f.sent.length === 0);
  check("...and remembers the newest post, by id not by string", f.state.cursor === "1000");
}
{
  const f = fake([], null);
  await relayOwnTweets(f.deps);
  check("an empty timeline leaves no cursor to trip over", f.state.cursor === null);
}
{
  const f = fake([
    post("14", "a result", { quotedId: "9" }),
    post("13", "second"),
    post("12", "a reply", { repliedToId: "3" }),
    post("11", "first"),
  ], "10");
  const r = await relayOwnTweets(f.deps);
  check("reads from the cursor", f.reads[0] === "10");
  check("posts written by hand go, oldest first", f.sent.length === 2 && f.sent[0].startsWith("first") && f.sent[1].startsWith("second"));
  check("quotes and replies (what the bot posts) do not", r.skipped === 2 && !f.sent.some((s) => /a result|a reply/.test(s)));
  check("the cursor ends on the newest post handled", f.state.cursor === "14" && !r.stalled);
}
{
  const f = fake([post("23", "third"), post("22", "second"), post("21", "first")], "20");
  let n = 0;
  f.deps.send = async (_c, text) => { if (++n === 2) throw new Error("Too Many Requests"); f.sent.push(text); };
  const r = await relayOwnTweets(f.deps);
  check("a failed send stops the run", r.stalled && r.posted === 1 && f.sent.length === 1);
  check("...and the cursor stays on the last post that went", f.state.cursor === "21");
  const again = fake([post("23", "third"), post("22", "second")], f.state.cursor);
  await relayOwnTweets(again.deps);
  check("the next run sends what was missed, nothing twice", again.sent.length === 2 && again.sent[0].startsWith("second") && again.reads[0] === "21");
}

console.log("\nthe X client");
process.env.TWITTER_CLIENT_ID = "client";
process.env.TWITTER_CLIENT_SECRET = "secret";
process.env.X_BOT_USER_ID = "42";
process.env.X_BOT_REFRESH_TOKEN = "seed";
const X = await import("../src/x/client.js");
const { botStateGet } = await import("../src/store/markets.js");
let tokenCalls = 0;
const urls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  urls.push(url);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.endsWith("/oauth2/token")) {
    tokenCalls++;
    await new Promise((r) => setTimeout(r, 25));
    return json({ access_token: `access-${tokenCalls}`, refresh_token: `rotated-${tokenCalls}`, expires_in: 7200 });
  }
  if (url.includes("/users/42/tweets")) {
    return json({ data: [
      { id: "201", text: "a preview that X cut short…", note_tweet: { text: "the whole long post https://t.co/a", entities: { urls: [{ url: "https://t.co/a", expanded_url: "https://oddie.fun" }] } } },
      { id: "200", text: "a result", referenced_tweets: [{ type: "quoted", id: "7" }] },
    ] });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;
{
  const tokens = await Promise.all([X.accessToken(), X.accessToken(), X.accessToken()]);
  check("three callers at once share one refresh", tokenCalls === 1 && tokens.every((t) => t === "access-1"), `refreshes: ${tokenCalls}`);
  check("...and the rotated refresh token is the one stored", (await botStateGet("x_refresh_token")) === "rotated-1");
}
{
  const posts = await X.ownTweets("150");
  const u = new URL(urls.find((x) => x.includes("/users/42/tweets")) ?? "http://none");
  check("reads the account's own posts", u.pathname.endsWith("/users/42/tweets"));
  check("X leaves out replies and retweets", u.searchParams.get("exclude") === "replies,retweets");
  check("from the cursor, 100 at a time", u.searchParams.get("since_id") === "150" && u.searchParams.get("max_results") === "100");
  check("a long post comes back whole, with its links", posts[0]?.text === "the whole long post https://t.co/a" && posts[0]?.urls[0]?.expanded === "https://oddie.fun");
  check("a quote comes back flagged", posts[1]?.quotedId === "7" && posts[0]?.quotedId === null);
}

if (failures) { console.error(`\n${failures} tweet relay check(s) failed`); process.exit(1); }
console.log("\nall tweet relay checks passed");
