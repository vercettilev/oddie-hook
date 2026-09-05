// One bare mailer, used by the operator invite flow (/api/invites/send).
//
// The settlement template that lived here went with Google sign-in on
// 2026-09-05: settlement is announced on X, where the identity is, and an
// email path that could only ever reach Google-linked accounts had no door
// left once the old feed retired.
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


/** The bare send: any subject/html to any address. Dry-run without the key. */
export async function sendMail(msg: { to: string; subject: string; html: string }): Promise<"sent" | "dry-run" | "failed"> {
  return coreSend(msg.to, msg.subject, msg.html);
}


async function coreSend(to: string, subject: string, html: string): Promise<"sent" | "dry-run" | "failed"> {
  if (!mailEnabled()) {
    console.log(JSON.stringify({ evt: "mail-dry-run", to, subject }));
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
