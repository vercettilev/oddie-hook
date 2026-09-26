/**
 * The Telegram Bot API, the four calls oddie needs and nothing else.
 *
 * Deliberately thin. Everything that decides anything lives in loop.ts, where
 * it can be tested against a fake; this file only knows how to talk to
 * api.telegram.org and how to fail in a way the loop can reason about.
 *
 * THE TOKEN IS IN THE URL. Telegram authenticates by path, not by header, so
 * every request URL carries the bot's full credential. Nothing in this file
 * ever puts a URL into an error, a log line or a thrown message: TgError holds
 * the method name and Telegram's own description, which is what anybody
 * debugging it actually needs.
 */

const API = "https://api.telegram.org";

export const tgToken = (): string | null => {
  const t = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  return t.length ? t : null;
};

export class TgError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    /** Seconds to wait, when Telegram rate limited the call. */
    readonly retryAfter: number | null = null,
  ) {
    super(`telegram ${method} -> ${code} ${description}`);
    this.name = "TgError";
  }
}

async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
  const token = tgToken();
  if (!token) throw new TgError(method, 0, "TELEGRAM_BOT_TOKEN is not set");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    // The fetch error message can include the URL. Replace it wholesale.
    throw new TgError(method, 0, (e as Error).name === "AbortError" ? "timed out" : "network error");
  } finally {
    clearTimeout(timer);
  }
  const json = (await res.json().catch(() => null)) as
    | { ok: true; result: T }
    | { ok: false; error_code?: number; description?: string; parameters?: { retry_after?: number } }
    | null;
  if (json && json.ok) return json.result;
  const err = json && !json.ok ? json : null;
  throw new TgError(
    method,
    err?.error_code ?? res.status,
    err?.description ?? `http ${res.status}`,
    err?.parameters?.retry_after ?? null,
  );
}

/* ------------------------------------------------------------ the shapes -- */

/** Only the fields oddie reads. Telegram sends many more. */
export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  /** OPTIONAL in Telegram's own schema. A person with no @name is a real case,
   *  and the numeric id is the only thing guaranteed to identify them. */
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  /** Present only for PUBLIC groups. */
  username?: string;
  title?: string;
}

export interface TgEntity { type: string; offset: number; length: number }

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  date: number;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  reply_to_message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

/* ------------------------------------------------------------- the calls -- */

/**
 * getUpdates answers 409 for as long as a webhook is set on the bot, which would
 * look exactly like "another instance is polling" and never clear. Idempotent
 * and free, so it runs once at startup and removes the ambiguity.
 */
export async function deleteWebhook(): Promise<void> {
  await call<boolean>("deleteWebhook", { drop_pending_updates: false });
}

export async function getMe(): Promise<TgUser> {
  return call<TgUser>("getMe", {});
}

/**
 * Long poll. Telegram holds the connection open for up to `timeoutSec` and
 * answers the moment something arrives, so an idle bot costs one request per
 * ~25 seconds rather than one per tick.
 *
 * Passing `offset` CONFIRMS every earlier update: Telegram will not send them
 * again. So the offset is advanced only after a batch has been handled.
 */
export async function getUpdates(offset: number | null, timeoutSec = 25): Promise<TgUpdate[]> {
  return call<TgUpdate[]>(
    "getUpdates",
    { ...(offset !== null ? { offset } : {}), timeout: timeoutSec, allowed_updates: ["message"] },
    (timeoutSec + 10) * 1000,
  );
}

export interface SentMessage { message_id: number }

const replyTo = (messageId: number) => ({
  // If the message being answered was deleted in the meantime, still answer,
  // just not as a threaded reply. A missing parent must not cost the reply.
  reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
});

export async function sendMessage(chatId: number, text: string, replyToId: number): Promise<SentMessage> {
  return call<SentMessage>("sendMessage", {
    chat_id: chatId,
    text,
    ...replyTo(replyToId),
  });
}

/** Telegram fetches the photo from the URL itself. */
export async function sendPhoto(
  chatId: number, photoUrl: string, caption: string, replyToId: number,
): Promise<SentMessage> {
  return call<SentMessage>("sendPhoto", {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    ...replyTo(replyToId),
  });
}
