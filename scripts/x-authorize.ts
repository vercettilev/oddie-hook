/**
 * One-time: authorise @oddiefun and print the refresh token the bot runs on.
 *
 * This exists because the bot posts as a USER, not as an app, and X only hands
 * out a user refresh token at the end of a consent screen that a human has to
 * click. There is no way to automate this half, and there should not be: it is
 * the moment somebody grants a program permission to speak as an account.
 *
 * Run it, open the URL it prints, approve as @oddiefun, and it prints the
 * refresh token plus the user id. Both go into Railway once.
 *
 * AFTER THAT THE PRINTED TOKEN IS DEAD. X rotates the refresh token on every
 * refresh and revokes the previous one, so the value you paste into
 * X_BOT_REFRESH_TOKEN is a SEED: the first refresh replaces it, and from then
 * on the live token lives in the bot_state table. If the bot ever reports
 * invalid_grant, that means the stored token was spent or revoked, and the fix
 * is to run this again, not to re-paste the old value.
 *
 * Run with: npm run x-authorize
 */

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const CLIENT_ID = process.env.TWITTER_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET;
const PORT = Number(process.env.X_AUTH_PORT ?? 8477);
const REDIRECT = process.env.X_AUTH_REDIRECT ?? `http://127.0.0.1:${PORT}/callback`;

// tweet.write is the point. offline.access is what yields a refresh token at
// all, and without it the bot works for two hours and then stops for good.
const SCOPES = "tweet.read tweet.write users.read offline.access";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set TWITTER_CLIENT_ID and TWITTER_CLIENT_SECRET first.");
  console.error("Both are in the X developer portal under your app's Keys and tokens.");
  process.exit(1);
}

const b64url = (b: Buffer) => b.toString("base64url");
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));

const authUrl = `https://x.com/i/oauth2/authorize?${new URLSearchParams({
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  scope: SCOPES,
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
})}`;

console.log(`
Add this EXACT callback URL to the app's settings in the X developer portal,
under User authentication settings. It has to match byte for byte or X answers
redirect_uri_mismatch and there is no token:

  ${REDIRECT}

Then open this URL and approve it WHILE LOGGED IN AS @oddiefun. Approving as
your own account gives the bot your voice, which is not what you want:

  ${authUrl}
`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname !== "/callback") { res.writeHead(404).end("no"); return; }

  const code = url.searchParams.get("code");
  const returned = url.searchParams.get("state");
  const denied = url.searchParams.get("error");

  if (denied) {
    res.writeHead(200, { "content-type": "text/plain" }).end(`X said: ${denied}. Nothing was granted.`);
    console.error(`\nAuthorisation refused: ${denied}`);
    server.close(); process.exit(1);
  }
  if (!code || returned !== state) {
    res.writeHead(400, { "content-type": "text/plain" }).end("state mismatch, refusing");
    console.error("\nState did not match. Someone else's callback, or a stale tab. Start over.");
    server.close(); process.exit(1);
  }

  const tok = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      client_id: CLIENT_ID,
    }),
  });
  const body = (await tok.json().catch(() => ({}))) as {
    access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string;
  };

  if (!tok.ok || !body.refresh_token) {
    res.writeHead(500, { "content-type": "text/plain" }).end("token exchange failed, see the terminal");
    console.error(`\nToken exchange failed (${tok.status}): ${body.error ?? ""} ${body.error_description ?? ""}`);
    if (body.error === "invalid_request") {
      console.error("Usually the callback URL in the portal does not match the one above exactly.");
    }
    server.close(); process.exit(1);
  }

  // Who did they actually approve as? Getting this wrong is silent and awful:
  // the bot would work perfectly and post from the wrong account.
  let who = "(unknown)"; let userId = "";
  try {
    const me = await fetch("https://api.x.com/2/users/me", {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    const j = (await me.json()) as { data?: { id: string; username: string } };
    if (j.data) { who = `@${j.data.username}`; userId = j.data.id; }
  } catch { /* the refresh token is still good; the name is a convenience */ }

  res.writeHead(200, { "content-type": "text/html" }).end(
    `<body style="font:16px system-ui;padding:40px;background:#050605;color:#fff">
       <h2 style="color:#D7DC1F">Authorised as ${who}</h2>
       <p>The refresh token is in your terminal. This tab is done.</p>
     </body>`,
  );

  console.log(`
Authorised as ${who}.

Put these in Railway (oddie-hook service), then redeploy:

  X_BOT_USER_ID=${userId}
  X_BOT_REFRESH_TOKEN=${body.refresh_token}
  X_BOT_ENABLED=true
  X_BOT_DRY_RUN=true

Granted scopes: ${body.scope ?? "(not reported)"}
${body.scope && !body.scope.includes("tweet.write") ? "\n  WARNING: tweet.write is NOT in that list. The bot can read and will never be able to post.\n" : ""}${body.scope && !body.scope.includes("offline.access") ? "\n  WARNING: offline.access is NOT in that list, so this refresh token will not work.\n" : ""}
Leave X_BOT_DRY_RUN=true until you have read a few sweeps of what it would say:

  curl -s -H "authorization: Bearer $ODDIE_ADMIN_TOKEN" -X POST https://oddie.fun/api/admin/x/sweep | jq

The token above dies the first time the bot refreshes. That is normal and
expected; the live one lives in the bot_state table from then on.
`);
  server.close();
  process.exit(0);
});

server.listen(PORT, "127.0.0.1", () => console.log(`Waiting for the callback on ${REDIRECT} ...\n`));
