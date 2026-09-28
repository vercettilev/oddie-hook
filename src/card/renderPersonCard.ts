import { C, DISPLAY, FONT, META, brandLockup, esc, textWidth, wrapToWidth } from "./renderCard.js";

/**
 * A PERSON'S SHARE CARD: what unfurls when their oddie page is posted.
 *
 * The same shell as the market card (lime frame, near-black ground, the
 * wordmark with its pink echo) so a person and their markets read as one
 * product in a timeline. The hero is the most flattering TRUE thing about
 * them, in this order:
 *
 *   1. their best call, when they show their name and have one that paid:
 *      "called YES at 24%" and what it paid, with the room it beat;
 *   2. otherwise the markets they opened, which are public anyway;
 *   3. otherwise the invitation itself.
 *
 * Never a loss, never a count of wrong calls: a card people post is a card
 * people choose, and nobody chooses to post their misses.
 */

const W = 1000;
const H = 524;
const PAD_L = 70;
const PAD_R = 932;
const CONTENT_W = PAD_R - PAD_L;

const AV_CX = 140;
const AV_CY = 206;
const AV_R = 62;
const NAME_X = 232;

export interface PersonCard {
  username: string;
  /** base64 PNG of their picture, or null to draw the ring alone. */
  avatarPng: string | null;
  followers: number;
  opened: number;
  best: { side: "yes" | "no"; entryPct: number; pnlSol: number; headline: string } | null;
  /** The headline of the newest market they opened, for the second state. */
  latestOpen: string | null;
}

const sol = (n: number): string => String(Math.round(n * 1000) / 1000);

/** The largest size, from `start` down, at which `s` fits `maxW`. */
function fit(s: string, start: number, min: number, maxW: number, face?: "display" | "meta"): number {
  let fs = start;
  while (fs > min && textWidth(s, fs, face) > maxW) fs -= 2;
  return fs;
}

export function renderPersonCard(p: PersonCard): string {
  const name = `@${p.username}`.toUpperCase();
  const nameFS = fit(name, 66, 34, PAD_R - NAME_X, "display");

  // Only what is worth saying: no "0 followers" on a card somebody posts, and
  // the markets opened only when the hero is not already saying it.
  const bits: string[] = [];
  if (p.followers > 0) bits.push(`${p.followers} ${p.followers === 1 ? "follower" : "followers"}`);
  if (p.opened > 0 && p.best) bits.push(`opened ${p.opened} ${p.opened === 1 ? "market" : "markets"}`);
  const meta = bits.join("  ·  ");

  const chip = "follow on oddie";
  const chipW = Math.round(textWidth(chip, 20, "meta") + 40);
  const chipX = PAD_R - chipW;

  // The hero line and what sits right of it and under it, per state.
  let hero: string;
  let right: string | null = null;
  let body: string;
  let foot: string | null;
  if (p.best) {
    hero = `called ${p.best.side.toUpperCase()} at ${Math.round(p.best.entryPct)}%`;
    right = `+${sol(p.best.pnlSol)} SOL`;
    body = p.best.headline;
    const other = p.best.side === "yes" ? "NO" : "YES";
    // 50 is the first stake into an empty pool: there was no room to beat.
    foot = Math.round(p.best.entryPct) !== 50 ? `the room was ${100 - Math.round(p.best.entryPct)}% ${other}` : "settled on chain";
  } else if (p.opened > 0 && p.latestOpen) {
    hero = p.opened === 1 ? "opened a market" : `opened ${p.opened} markets`;
    body = p.latestOpen;
    foot = "their next one reaches you first";
  } else {
    hero = "calls it first";
    body = `Follow @${p.username} to hear the moment they open a market or take a side.`;
    foot = null;
  }

  // The hero and the money share one line; the hero gives way.
  const rightFS = 50;
  const rightW = right ? textWidth(right, rightFS) : 0;
  const heroFS = fit(hero, 66, 40, CONTENT_W - 24 - (right ? rightW + 30 : 0));
  const bodyFS = 32;
  const bodyLines = wrapToWidth(body, CONTENT_W - 24, bodyFS, 2);
  if (bodyLines.overflow && bodyLines.lines.length) {
    let last = bodyLines.lines[bodyLines.lines.length - 1];
    while (last.length > 1 && textWidth(last + "…", bodyFS) > CONTENT_W - 24) last = last.slice(0, -1);
    bodyLines.lines[bodyLines.lines.length - 1] = last.trimEnd() + "…";
  }

  const HERO_Y = 352;
  const BODY_Y = 400;
  const bodyLH = 38;
  const footY = BODY_Y + bodyLH * (bodyLines.lines.length - 1) + 42;
  const barTop = HERO_Y - Math.round(heroFS * 0.8);
  const barBottom = foot ? footY + 8 : BODY_Y + bodyLH * (bodyLines.lines.length - 1) + 12;

  const avatar = p.avatarPng
    ? `<clipPath id="av"><circle cx="${AV_CX}" cy="${AV_CY}" r="${AV_R}"/></clipPath>
  <image href="data:image/png;base64,${p.avatarPng}" x="${AV_CX - AV_R}" y="${AV_CY - AV_R}" width="${AV_R * 2}" height="${AV_R * 2}" clip-path="url(#av)"/>`
    : "";

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
  <rect width="${W}" height="${H}" fill="${C.accent}"/>
  <rect x="18" y="18" width="964" height="488" rx="44" fill="${C.ground}"/>

  ${brandLockup(true)}

  <rect x="${chipX}" y="68" width="${chipW}" height="44" rx="22" fill="none" stroke="${C.accent}" stroke-width="2"/>
  <text x="${chipX + chipW / 2}" y="97" font-family="${META}" font-size="20" font-weight="700"
        fill="${C.accent}" text-anchor="middle">${esc(chip)}</text>

  <circle cx="${AV_CX + 5}" cy="${AV_CY + 6}" r="${AV_R + 4}" fill="${C.pinkDeep}"/>
  <circle cx="${AV_CX}" cy="${AV_CY}" r="${AV_R + 4}" fill="${C.white}"/>
  ${avatar}

  <text x="${NAME_X + 3}" y="${AV_CY + 3}" font-family="${DISPLAY}" font-size="${nameFS}" fill="${C.echo}">${esc(name)}</text>
  <text x="${NAME_X}" y="${AV_CY}" font-family="${DISPLAY}" font-size="${nameFS}" fill="${C.white}">${esc(name)}</text>
  ${meta ? `<text x="${NAME_X + 2}" y="${AV_CY + 46}" font-family="${META}" font-size="24" font-weight="700"
        fill="${C.white}" fill-opacity="0.62">${esc(meta)}</text>` : ""}

  <rect x="${PAD_L}" y="${barTop}" width="6" height="${barBottom - barTop}" rx="3" fill="${C.accent}"/>
  <text x="${PAD_L + 27}" y="${HERO_Y + 3}" font-size="${heroFS}" font-weight="700" fill="${C.echo}">${esc(hero)}</text>
  <text x="${PAD_L + 24}" y="${HERO_Y}" font-size="${heroFS}" font-weight="700" fill="${C.accent}">${esc(hero)}</text>
  ${right ? `<text x="${PAD_R}" y="${HERO_Y}" font-size="${rightFS}" font-weight="700" fill="${C.white}" text-anchor="end">${esc(right)}</text>` : ""}
  <text font-size="${bodyFS}" font-weight="600" fill="${C.white}">${bodyLines.lines
    .map((l, k) => `<tspan x="${PAD_L + 24}" y="${BODY_Y + k * bodyLH}">${esc(l)}</tspan>`).join("")}</text>
  ${foot ? `<text x="${PAD_L + 25}" y="${footY}" font-family="${META}" font-size="22" font-weight="700"
        fill="${C.white}" fill-opacity="0.62">${esc(foot)}</text>` : ""}
</svg>`;
}
