// Does the evidence a verdict cites actually say what the verdict claims?
//
// This file is the only part of the oracle a model cannot talk its way past,
// and that is the whole reason it exists. Everything upstream is judgment: a
// model reads a market, searches, and reports what it found. A model that is
// confidently wrong writes a confident citation, and a model that invents a
// source writes a plausible URL with a plausible quote under it. Neither is
// caught by asking another model, because the second model reads the same
// sentence the first one wrote.
//
// So the audit is CODE. We fetch the cited page ourselves, from our own
// process, and require the quoted span to be present in what WE received. A
// quote that is not there fails, whatever the verdict says about it, and no
// confidence score anywhere can lift it back.
//
// WHAT THIS DOES NOT PROVE. That the page is honest, that the outlet is real,
// that the quote is not out of context. It proves one narrow thing: the words
// exist at the address given. That is a floor, not a ceiling, and the pipeline
// treats it that way — passing the audit makes a verdict ELIGIBLE, never
// correct.
//
// FAILING CLOSED IS THE POINT. Plenty of honest pages will not survive this:
// they render in JavaScript, they refuse our fetch, they paginate the quote
// away. Those citations come back unverified and the market goes to a human.
// That is the right direction to be wrong in. The opposite arrangement — treat
// unreachable as fine — is exactly how a fabricated source gets paid.

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 2_000_000; // a page bigger than this is not a source, it is a dump
const UA = "oddie-oracle/1.0 (+https://oddie.fun)"; // plain ASCII: fetch rejects anything else in a header

export interface Citation {
  url: string;
  /** A SHORT verbatim span from the page. Short on purpose: the longer the
   *  quote, the more likely an honest page fails on a stray character. */
  quote: string;
}

export type CitationStatus =
  | "verified"      // fetched, and the quote is in what we fetched
  | "quote-absent"  // fetched fine, the words are not there — the serious one
  | "unreachable"   // network, status, timeout, or a body we could not read
  | "stale";        // verified, but dated before the market closed (see below)

export interface AuditedCitation {
  url: string;
  quote: string;
  status: CitationStatus;
  /** The newest date the document declares for itself, from any of the tags
   *  that carry one. null = it declared none, which is common and is NOT held
   *  against it. */
  datedAt: string | null;
  /** One line, for the log and for the human who ends up looking at this. */
  note: string;
}

/** Collapse the differences that make an honest quote fail: smart quotes,
 *  dashes, entities, non-breaking spaces, casing, and every kind of run of
 *  whitespace. Both sides go through this, so it can only ever make a real
 *  match findable — it cannot invent one. */
export function normalizeText(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** HTML to something a quote can be looked for in. Deliberately crude: script
 *  and style go, every other tag becomes a space so words never fuse across a
 *  tag boundary ("<b>Ars</b>enal" must not read as one token). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
}

/**
 * The most recent date this document claims for itself.
 *
 * THE LATEST DATE, NOT THE FIRST ONE FOUND, and that is a correction rather
 * than a preference. Wikipedia's JSON-LD carries datePublished 2001-09-30 on an
 * article edited this morning: taking the first signal marked every Wikipedia
 * citation as written a quarter-century ago, which under the staleness rule
 * below silently blocked every NO verdict that cited one — and Wikipedia is one
 * of the few sources measured that can carry a citation at all.
 *
 * The question this date is asked is always the same: could this text have
 * known that a deadline had passed? For that, the newest moment the document
 * admits to is the right bound, and a stray ancient <time> element becomes
 * harmless instead of decisive.
 *
 * Finding nothing is a normal answer and is never held against a page.
 */
export function documentDateOf(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']article:(?:published|modified)_time["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:(?:published|modified)_time["']/gi,
    /<meta[^>]+itemprop=["'](?:datePublished|dateModified)["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+name=["'](?:date|pubdate|publish[-_]?date|last[-_]?modified)["'][^>]+content=["']([^"']+)["']/gi,
    /"date(?:Published|Modified)"\s*:\s*"([^"]+)"/gi,
    /<time[^>]+datetime=["']([^"']+)["']/gi,
  ];
  let best: Date | null = null;
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      const d = new Date(m[1]);
      const y = d.getUTCFullYear();
      // A parse landing outside any plausible range is a parse that failed.
      if (Number.isNaN(d.getTime()) || y < 2000 || y > 2100) continue;
      if (!best || d > best) best = d;
    }
  }
  return best ? best.toISOString() : null;
}

/** Fetch seam. Swapped in tests so the audit's logic is exercised against known
 *  bytes rather than against whatever the internet is doing today. */
export type PageFetcher = (url: string) => Promise<{ ok: boolean; html: string; status: number }>;

const liveFetch: PageFetcher = async (url) => {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, html: "", status: res.status };
    const buf = await res.arrayBuffer();
    const html = Buffer.from(buf.slice(0, MAX_BYTES)).toString("utf8");
    return { ok: true, html, status: res.status };
  } catch {
    return { ok: false, html: "", status: 0 };
  }
};

let fetcher: PageFetcher = liveFetch;
export function _setPageFetcher(f: PageFetcher | null): void {
  fetcher = f ?? liveFetch;
}

/**
 * Check one citation against the live page.
 *
 * `closeTime` decides only whether a VERIFIED citation is additionally marked
 * stale; it never rescues one that failed on its words.
 */
export async function auditCitation(c: Citation, closeTime: Date | null): Promise<AuditedCitation> {
  const base = { url: c.url, quote: c.quote };

  // A URL we would not follow is not a source. http/https only: no file://, no
  // data:, nothing that reads our own disk or our own network.
  let parsed: URL | null = null;
  try { parsed = new URL(c.url); } catch { parsed = null; }
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return { ...base, status: "unreachable", datedAt: null, note: "not an http(s) address" };
  }

  const quote = normalizeText(c.quote);
  // An empty or near-empty quote would match everything. It is not evidence.
  if (quote.length < 12) {
    return { ...base, status: "quote-absent", datedAt: null, note: "quote too short to mean anything" };
  }

  const page = await fetcher(c.url);
  if (!page.ok) {
    return { ...base, status: "unreachable", datedAt: null, note: page.status ? `http ${page.status}` : "fetch failed" };
  }

  const datedAt = documentDateOf(page.html);
  const text = normalizeText(htmlToText(page.html));
  if (!text.includes(quote)) {
    return { ...base, status: "quote-absent", datedAt, note: "the quoted words are not on that page" };
  }

  if (closeTime && datedAt && new Date(datedAt) < closeTime) {
    return { ...base, status: "stale", datedAt, note: "published before the market closed" };
  }
  return { ...base, status: "verified", datedAt, note: "quote found on the page" };
}

export interface AuditResult {
  citations: AuditedCitation[];
  /** Citations whose words we found. */
  verified: number;
  /** Verified, but dated before the close. Real evidence of an EARLY event;
   *  worthless as evidence that something never happened. */
  stale: number;
  /** Fetched fine and the words were not in it. One of these discards the
   *  verdict. NOT called "fabricated": the audit cannot tell an invented source
   *  from a live page that changed between the search and our re-fetch, and
   *  front pages were measured doing exactly that. Both are reasons to stop, and
   *  only one of them is somebody's fault, so the name claims neither. */
  absent: number;
  unreachable: number;
}

export async function auditCitations(cites: Citation[], closeTime: Date | null): Promise<AuditResult> {
  const citations = await Promise.all(cites.map((c) => auditCitation(c, closeTime)));
  return {
    citations,
    verified: citations.filter((c) => c.status === "verified").length,
    stale: citations.filter((c) => c.status === "stale").length,
    absent: citations.filter((c) => c.status === "quote-absent").length,
    unreachable: citations.filter((c) => c.status === "unreachable").length,
  };
}

/**
 * Is this audit strong enough to let a verdict of THIS side stand?
 *
 * The asymmetry here is the part that would be silently wrong if it were left
 * out, so it is spelled out rather than implied.
 *
 * A YES says an event HAPPENED. A document written before the market closed can
 * prove that perfectly well: the thing may simply have happened early. So a
 * verified-but-stale citation still supports a YES.
 *
 * A NO says an event DID NOT happen by the deadline. Nothing written before the
 * deadline can establish that — at the moment it was published the deadline had
 * not passed and the event still could have occurred. So a NO needs at least one
 * verified citation dated AT OR AFTER the close, and a NO built only on
 * pre-close documents is not evidence, it is a guess with footnotes.
 *
 * This is also why a NO is structurally the harder verdict: the usual proof of
 * a non-event is the absence of any report, and an absence has no URL. Those
 * markets are supposed to reach a person. That is not a gap in the design.
 */
export function auditSupports(outcome: "yes" | "no", audit: AuditResult): { ok: boolean; why: string } {
  // A source that was reachable and did not contain its own quote is the one
  // failure no amount of other evidence outweighs. It can mean the quote was
  // invented; it can equally mean the page moved on between the search and the
  // re-fetch, which front pages were measured doing. Either way the citation
  // cannot be checked now, and a verdict whose evidence cannot be checked is a
  // verdict that goes to a person.
  if (audit.absent > 0) {
    return { ok: false, why: `${audit.absent} citation(s) no longer show the quoted words on the page` };
  }
  if (outcome === "yes") {
    const usable = audit.verified + audit.stale;
    if (usable === 0) return { ok: false, why: "no citation could be verified against its own page" };
    return { ok: true, why: `${usable} verified citation(s)` };
  }
  if (audit.verified === 0) {
    return audit.stale > 0
      ? { ok: false, why: "every verified citation predates the close, which cannot establish a non-event" }
      : { ok: false, why: "no citation could be verified against its own page" };
  }
  return { ok: true, why: `${audit.verified} citation(s) dated at or after the close` };
}
