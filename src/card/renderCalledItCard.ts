/**
 * THE "CALLED IT" CARD (Lev, 3 Nov, after CRSH's winner cards): one settled
 * call as a picture to post after a show. The frame Oddie read fills it, so
 * the card is the evidence and not a drawing of it; on top sit the question,
 * the result and who called it right. 16:9, the shape X shows in full, and
 * rasterised by renderCardPng like every other card, with the bundled fonts.
 */
import { logoMark } from "./logoMark.js";

export interface CalledItCard {
  question: string;
  outcome: "yes" | "no";
  /** The channel's name and where it streams: "Showdown", "X Live". */
  channel: string;
  where: string;
  /** Who called it right, best first. */
  calledIt: string[];
  /** The picture the screen settled it on; a call settled by hand has none. */
  frameJpeg: Buffer | null;
}

const W = 1200;
const H = 675;
const YELLOW = "#FCF604";
const PINK = "#FF2D78";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));

/** Greedy word wrap by characters: resvg draws text, it does not lay it out. */
export function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= maxChars) { line = next; continue; }
    if (line) lines.push(line);
    line = w.length > maxChars ? `${w.slice(0, maxChars - 1)}…` : w;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = (last.length > maxChars - 1 ? last.slice(0, maxChars - 1) : last).replace(/[\s,.;:!?]+$/, "") + "…";
  return kept;
}

/** "@a, @b and @c called it." or "Nobody called it.", short enough for one line. */
export function calledItLine(names: string[]): string {
  const at = names.slice(0, 3).map((n) => "@" + n.replace(/^@+/, ""));
  if (!at.length) return "Nobody called it.";
  let shown = at;
  while (shown.length > 1 && shown.join(", ").length > 38) shown = shown.slice(0, -1);
  const rest = names.length - shown.length;
  const list = rest > 0 ? `${shown.join(", ")} and ${rest} more`
    : shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return `${list} called it.`;
}

/** The bundled fonts draw no emoji: a flamingo in a channel's name would print as a box. */
const plain = (s: string): string => s.replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, "").replace(/\s+/g, " ").trim();

export function renderCalledItCard(c: CalledItCard): string {
  const back = c.frameJpeg
    ? `<image href="data:image/jpeg;base64,${c.frameJpeg.toString("base64")}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect width="${W}" height="${H}" fill="#0f1210"/>`;
  /* THE MIDDLE OF THE PICTURE STAYS CLEAR. A game puts its result in the
     middle of the screen, and that result is the card's evidence, so the
     words sit on a dark band across the bottom instead of over it. */
  const q = wrapLines(plain(c.question).toUpperCase(), 40, 2);
  const lineH = 58;
  const qLast = 500;
  const qFirst = qLast - (q.length - 1) * lineH;
  const word = c.outcome === "yes" ? "YES" : "NO";
  const wordW = c.outcome === "yes" ? 128 : 86;
  const where = plain(`${c.channel} · ${c.where}`).toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="top" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#020302" stop-opacity=".6"/>
      <stop offset="1" stop-color="#020302" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="band" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#020302" stop-opacity="0"/>
      <stop offset=".18" stop-color="#020302" stop-opacity=".86"/>
      <stop offset="1" stop-color="#020302" stop-opacity=".94"/>
    </linearGradient>
  </defs>
  ${back}
  <rect width="${W}" height="130" fill="url(#top)"/>
  <rect y="${qFirst - 92}" width="${W}" height="${H - (qFirst - 92)}" fill="url(#band)"/>
  ${logoMark(40, 32, 60)}
  <text x="114" y="76" font-family="Fredoka" font-weight="600" font-size="40" fill="#fff">oddie</text>
  <text x="${W - 40}" y="72" text-anchor="end" font-family="Nunito" font-weight="700" font-size="22" letter-spacing="2" fill="#fff" fill-opacity=".85">${esc(where)}</text>
  ${q.map((l, i) => `<text x="40" y="${qFirst + i * lineH}" font-family="Anton" font-size="54" fill="${YELLOW}">${esc(l)}</text>`).join("\n  ")}
  <text x="40" y="592" font-family="Anton" font-size="80" fill="${c.outcome === "yes" ? YELLOW : PINK}">${word}</text>
  <text x="${40 + wordW + 22}" y="580" font-family="Nunito" font-weight="700" font-size="30" fill="#fff">${esc(calledItLine(c.calledIt))}</text>
  ${c.frameJpeg ? `<text x="40" y="${H - 30}" font-family="Nunito" font-weight="700" font-size="21" fill="#fff" fill-opacity=".72">Settled off the stream in seconds.</text>` : ""}
  <text x="${W - 40}" y="${H - 30}" text-anchor="end" font-family="Nunito" font-weight="700" font-size="21" fill="${YELLOW}">oddie.fun</text>
</svg>`;
}
