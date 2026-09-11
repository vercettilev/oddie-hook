/**
 * A VAPID pair, printed once, for the Railway panel.
 *
 *   npm run push-keys
 *
 * The public key is not a secret: every browser that subscribes is handed it.
 * The private key is, and it goes in the panel like every other one — never on
 * a command line, never in the repo, never in a log.
 */
import { generateVapidKeys } from "../src/push/webpush.js";
const { publicKey, privateKey } = generateVapidKeys();
console.log(`
Put these in the Railway panel, then redeploy.

  VAPID_PUBLIC_KEY   ${publicKey}
  VAPID_PRIVATE_KEY  ${privateKey}
  VAPID_SUBJECT      https://oddie.fun

Rotating them invalidates every existing subscription: browsers bind a
subscription to the public key it was created with, so everybody who has
allowed notifications would silently stop receiving them. Generate once.
`);
