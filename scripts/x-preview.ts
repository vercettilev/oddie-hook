/**
 * "What would oddie reply to this?" Answered today, without the X API.
 *
 * This drives the REAL loop (runMentionSweep, the same function the timer
 * calls) with a fake X in front of it. Everything downstream of the fake is
 * genuine: the claim is graded by the real extractor, the market is really
 * minted on Solana through the real create route, the card is the real
 * renderer, and the reply text is the real builder. The only thing that does
 * not happen is the post.
 *
 * It exercises the shipped loop rather than a parallel copy of it on purpose.
 * A preview that reimplements the pipeline proves the preview works.
 *
 * Needs a running server (npm run dev) and its admin token.
 *
 *   npm run x-preview -- "Bitcoin will never hit 200k, cope harder"
 *   npm run x-preview -- --handle cryptonate "the Fed is definitely cutting in March"
 *
 * The market it opens is REAL and public. That is the point (a preview that
 * mocked the mint would review none of the judgement that matters), but it
 * means the slug it prints is a thing that now exists.
 */

import { writeFileSync } from "node:fs";
import { runMentionSweep } from "../src/x/mentionLoop.js";
import type { MintResult } from "../src/x/mentionLoop.js";
import type { Mention } from "../src/x/client.js";
import { runExtract } from "../src/matching/extractClaim.js";
import type { Extraction } from "../src/matching/extractClaim.js";
import { _resetBotState } from "../src/store/markets.js";

const args = process.argv.slice(2);
let handle = "someone";
const rest: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--handle" && args[i + 1]) { handle = args[++i].replace(/^@/, ""); continue; }
  rest.push(args[i]);
}
const claim = rest.join(" ").trim();

if (!claim) {
  console.error(`Give it the tweet to price.

  npm run x-preview -- "Bitcoin will never hit 200k, cope harder"
  npm run x-preview -- --handle cryptonate "the Fed is definitely cutting in March"
`);
  process.exit(1);
}

const BASE = process.env.ODDIE_BASE_URL ?? "http://localhost:3000";
const ADMIN = process.env.ODDIE_ADMIN_TOKEN ?? "";

// Two synthetic tweets: the claim, and an @oddiefun reply under it. Exactly the
// shape the real client returns, so the loop cannot tell the difference.
const CLAIM_ID = "9000000000000000001";
const MENTION_ID = "9000000000000000002";

const mention: Mention = {
  id: MENTION_ID,
  text: "@oddiefun price this",
  authorId: "u-preview",
  authorHandle: "preview",
  repliedToId: CLAIM_ID,
  createdAt: new Date().toISOString(),
};

async function main() {
  const health = await fetch(`${BASE}/api/chain/status`).catch(() => null);
  if (!health?.ok) {
    console.error(`No server at ${BASE}. Start one with: npm run dev`);
    process.exit(1);
  }
  const chain = (await health.json()) as { enabled: boolean; cluster: string };

  console.log(`\n  claim   @${handle}: ${claim}`);
  console.log(`  chain   ${chain.cluster}${chain.enabled ? "" : " (minting OFF, this will fail)"}\n`);

  _resetBotState();
  let cardBytes: Buffer | null = null;

  const r = await runMentionSweep({
    mentions: async () => ({ items: [mention], newestId: MENTION_ID }),
    tweet: async (id) => (id === CLAIM_ID ? { id, text: claim, authorHandle: handle } : null),
    // The grader runs wherever the API key is. That is usually the server and
    // not this shell, and it is what lets the preview be pointed at production
    // to see what the live bot would actually say.
    extract: async (text) => {
      if (ADMIN) {
        const res = await fetch(`${BASE}/api/community/extract`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-oddie-admin": ADMIN },
          body: JSON.stringify({ text }),
        });
        const body = (await res.json().catch(() => ({}))) as { extraction?: Extraction; error?: string };
        if (res.ok && body.extraction) return body.extraction;
        if (res.status !== 503) throw new Error(body.error ?? `extract -> ${res.status}`);
      }
      return runExtract(text);
    },
    openMarket: async (input): Promise<MintResult> => {
      const res = await fetch(`${BASE}/api/v1/markets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: input.question,
          close_time: input.closeInput,
          source_url: input.sourceUrl,
          resolution_criteria: input.resolutionCriteria,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; slug?: string; error?: string };
      return body.ok && body.slug
        ? { ok: true, slug: body.slug }
        : { ok: false, status: res.status, error: body.error ?? String(res.status) };
    },
    cardPng: async (slug) => {
      const res = await fetch(`${BASE}/card/${slug}.png`);
      if (!res.ok) return null;
      cardBytes = Buffer.from(await res.arrayBuffer());
      return cardBytes;
    },
    uploadMedia: async () => "preview-media",
    postReply: async () => ({ id: "preview-reply" }),
    baseUrl: BASE,
    botUserId: "u-oddie",
    // Not a dry run: the mint and the card must really happen, because they are
    // what is being reviewed. The post is stubbed above instead.
    dryRun: false,
    durable: true,
    log: () => {},
  });

  const d = r.decisions[0];
  if (!d) { console.error("  the loop looked at nothing, which should be impossible here"); process.exit(1); }

  if (d.outcome !== "replied") {
    console.log(`  REFUSED  (${d.reason})`);
    if (String(d.reason).startsWith("gate:")) {
      const ex = await runExtract(claim);
      console.log(`  why      ${ex.reason}`);
      console.log(`\n  Nothing was posted and no market was opened. This is the gate working.\n`);
    } else {
      console.log(`\n  Nothing was posted.\n`);
    }
    process.exit(0);
  }

  // The card, on disk, because the picture is half of what a reply is.
  let cardPath = "";
  if (cardBytes) {
    cardPath = `/tmp/oddie-preview-${d.slug}.png`;
    writeFileSync(cardPath, cardBytes);
  }

  console.log("  ── oddie would reply ──────────────────────────────────\n");
  console.log(
    String(d.text)
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );
  console.log(`\n  ───────────────────────────────────────────────────────\n`);
  console.log(`  length  ${String(d.text).length}/280`);
  console.log(`  market  ${BASE}/m/${d.slug}`);
  if (cardPath) console.log(`  card    ${cardPath}`);
  console.log(`  fee     3% of the pool to @${handle}, because the claim is theirs\n`);

  if (ADMIN) {
    // Convenience: the market is real and public, and a preview run should not
    // silently litter the live feed with test questions.
    console.log(`  This market is live. Remove it with:`);
    console.log(`    curl -X POST -H "x-oddie-admin: $ODDIE_ADMIN_TOKEN" ${BASE}/api/community/resolve \\`);
    console.log(`      -H 'content-type: application/json' -d '{"slug":"${d.slug}","outcome":"no"}'\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
