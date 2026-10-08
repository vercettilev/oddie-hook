/**
 * ONE LINE AT A TIME, PER CHAT.
 *
 * Twitch holds an account that is not a moderator of a chat to about a line a
 * second there, and answers a faster one with 429 "Your message was not sent
 * because you are sending messages too quickly". oddie's voice is such an
 * account in nearly every chat it speaks in, and it often has two things to say
 * at once: a call locked and the next one opened, two results when a candle
 * closes. Live on 8 Oct the second of two such lines was refused that way, the
 * refusal was read as "oddie may not post here", and for ten minutes oddie's
 * lines went out under the streamer's own name.
 *
 * So the lines to one chat go out in order, a little over a second apart, on
 * both platforms (Kick documents no limit; a second's wait costs nothing), and a
 * 429 is waited out instead of taken for a refusal.
 */

let gapMs = 1_100;
let retryMs = [1_500, 3_000];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const tails = new Map<string, Promise<unknown>>();
const lastAt = new Map<string, number>();

/** Run `f` after every line already on its way to the same chat, and not
 *  sooner than the gap after the last one went out. */
export function paced<T>(chat: string, f: () => Promise<T>): Promise<T> {
  const run = (tails.get(chat) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const wait = (lastAt.get(chat) ?? 0) + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      try { return await f(); } finally { lastAt.set(chat, Date.now()); }
    });
  tails.set(chat, run);
  void run.catch(() => {}).finally(() => { if (tails.get(chat) === run) tails.delete(chat); });
  return run;
}

/** Say it, and when the platform answers "too quickly", wait and say it again:
 *  twice, then the error goes to the caller. Only a 429 is tried again: it is
 *  the one answer that means "this line, a moment later, is fine". */
export async function patiently<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); }
    catch (e) {
      if ((e as { status?: number }).status !== 429 || i >= retryMs.length) throw e;
      await sleep(retryMs[i]);
    }
  }
}

/** "Not now" rather than "not here": still too quick after waiting, the platform
 *  having a bad moment, or no answer at all. It hands on that one line; only a
 *  refusal (a ban, followers-only, a token it will not take) benches the voice. */
export const notNow = (status: number | undefined): boolean => status === undefined || status === 429 || status >= 500;

/** Test seam: the gap and the waits, so a suite does not sit through real seconds. */
export function _setPace(o: { gapMs?: number; retryMs?: number[] }): void {
  if (o.gapMs !== undefined) gapMs = o.gapMs;
  if (o.retryMs !== undefined) retryMs = o.retryMs;
  tails.clear(); lastAt.clear();
}
