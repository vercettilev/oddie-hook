// Settlement emails, and nothing else. One template: what you called, what
// happened, what it paid, a link to your positions. No marketing, no streaks,
// no "come back and play" — the resolution IS the reason to come back, and
// dressing it up would teach people to ignore the sender.
//
// Provider: Resend (https://resend.com) — one POST, free tier of 100/day,
// which is orders of magnitude above current volume. RESEND_API_KEY enables
// sending; without it every send is a DRY RUN that logs the exact payload, so
// the pipeline is testable before the key exists. MAIL_FROM overrides the
// sender once a domain is verified (defaults to Resend's onboarding address,
// which delivers but shows their domain).
//
// Open/click tracking: Resend offers both as domain-level toggles in its
// dashboard once oddie.fun is verified there; nothing to instrument in code.

const API_KEY_ENV = "RESEND_API_KEY";
export const MAIL_KEY_ENV = API_KEY_ENV;
export const mailEnabled = (): boolean => Boolean(process.env[API_KEY_ENV]);

// Set MAIL_FROM to an oddie.fun sender once the domain is verified in Resend.
const FROM = () => process.env.MAIL_FROM ?? "Oddie <info@oddie.fun>";

export interface SettleMail {
  to: string;
  question: string;
  side: "yes" | "no";
  entryPct: number;
  outcome: "yes" | "no";
  proceeds: number;
  stake: number;
  positionsUrl: string;
}

export function settleMailBody(m: SettleMail): { subject: string; html: string } {
  const won = m.side === m.outcome;
  const subject = won
    ? `you called it — ${m.question}`
    : `resolved ${m.outcome.toUpperCase()} — ${m.question}`;
  const verdict = won
    ? `You called <b>${m.side.toUpperCase()}</b> at ${m.entryPct}% and the market resolved <b>${m.outcome.toUpperCase()}</b>. Your ${m.stake} tokens paid <b>${m.proceeds}</b>.`
    : `You called <b>${m.side.toUpperCase()}</b> at ${m.entryPct}% — the market resolved <b>${m.outcome.toUpperCase()}</b>. The ${m.stake} tokens didn't come back this time.`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:520px">
  <p style="font-size:17px;font-weight:700;margin:0 0 12px">${esc(m.question)}</p>
  <p style="margin:0 0 16px">${verdict}</p>
  <p style="margin:0 0 20px"><a href="${esc(m.positionsUrl)}" style="color:#14607f">your positions →</a></p>
  <p style="color:#6B7A88;font-size:12.5px;margin:0">oddie sends one email per resolved position, nothing else.</p>
</div>`;
  return { subject, html };
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));

/** The bare send: any subject/html to any address. Dry-run without the key. */
export async function sendMail(msg: { to: string; subject: string; html: string }): Promise<"sent" | "dry-run" | "failed"> {
  return coreSend(msg.to, msg.subject, msg.html);
}

/** Send, or dry-run-log when the key is absent. Never throws: a mail failure
 *  must not touch settlement, which already happened. */
export async function sendSettleMail(m: SettleMail): Promise<"sent" | "dry-run" | "failed"> {
  const { subject, html } = settleMailBody(m);
  return coreSend(m.to, subject, html, m.positionsUrl);
}

async function coreSend(to: string, subject: string, html: string, ctx?: string): Promise<"sent" | "dry-run" | "failed"> {
  if (!mailEnabled()) {
    console.log(JSON.stringify({ evt: "mail-dry-run", to, subject, ctx }));
    return "dry-run";
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env[API_KEY_ENV]}`, "content-type": "application/json" },
      body: JSON.stringify({ from: FROM(), to: [to], subject, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    console.log(JSON.stringify({ evt: "mail-sent", to: to.replace(/(.{2}).*(@.*)/, "$1…$2"), subject }));
    return "sent";
  } catch (err) {
    console.error("[mail] send failed:", (err as Error).message);
    return "failed";
  }
}
