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
  | "verified"      // the quote is there AND the page is dated at or after the close
  | "undated"       // the quote is there and the page declares no date at all
  | "quote-absent"  // fetched fine, the words are not there
  | "unreachable"   // network, status, timeout, or a body we could not read
  | "stale";        // the quote is there but the page is dated before the close

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

/** A numeric character reference that is out of range or a lone surrogate would
 *  throw; an entity we cannot decode is dropped rather than allowed to take the
 *  whole audit down. */
function safeCodePoint(n: number): string {
  try {
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

/** Collapse the differences that make an honest quote fail: smart quotes,
 *  dashes, entities, non-breaking spaces, casing, and every kind of run of
 *  whitespace. Both sides go through this, so it can only ever make a real
 *  match findable — it cannot invent one. */
export function normalizeText(s: string): string {
  return s
    // Numeric references first: a CMS emitting &#8217; for an apostrophe is the
    // default, not the exception, and an undecoded one failed an honest quote
    // with the one status that discards the verdict and blames the source.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(parseInt(n, 10)))
    .replace(/&(mdash|ndash|rsquo|lsquo|rdquo|ldquo|hellip|shy);/gi, (_, n) =>
      ({ mdash: "-", ndash: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: "...", shy: "" })[String(n).toLowerCase()] ?? "")
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

/** A tag matcher that does not stop at a ">" inside a quoted attribute value.
 *  The naive /<[^>]+>/ leaks the tail of any attribute containing one into the
 *  searchable text, so `content="Arsenal beat Chelsea 3-1 -> the title race is
 *  over"` became quotable prose that no reader ever sees. */
const TAG = /<[a-zA-Z\/!?][^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/g;

function strip(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // The head is metadata, not prose. Leaving it in made a meta description
    // quotable, which is text the page never shows.
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ");
}

/** HTML to something a quote can be looked for in. Every tag becomes a space so
 *  words never fuse across a boundary: "<p>a</p><p>b</p>" must not read as
 *  "ab". */
export function htmlToText(html: string): string {
  return strip(html).replace(TAG, " ");
}

/** The same text with tags REMOVED rather than spaced, so a word split by an
 *  inline element survives. This exists because the spaced form alone breaks
 *  honest quotes on ordinary markup: a drop cap renders
 *  "<span>T</span>he Commission" as "t he commission", and <wbr> and &shy; do
 *  the same. Those failed with the one status that discards a verdict and
 *  blames the source, for markup that is standard on longform news.
 *
 *  A quote is accepted if EITHER form contains it. Checking both cannot invent
 *  a match that is in neither, and each form covers the case the other breaks. */
export function htmlToTextJoined(html: string): string {
  return strip(html).replace(TAG, "");
}

/** Are these words on this page? Both readings of the markup are tried. */
export function pageContains(html: string, quote: string): boolean {
  const q = normalizeText(quote);
  return normalizeText(htmlToText(html)).includes(q) || normalizeText(htmlToTextJoined(html)).includes(q);
}

/** Turn a declared date string into an instant, conservatively.
 *
 *  Two things Date() gets wrong for this purpose. A datetime with no timezone
 *  is parsed in the HOST's zone, so the same page verifies on a UTC server and
 *  goes stale on the operator's laptop; it is read as UTC instead. And a bare
 *  date denotes a whole DAY, not midnight. We keep midnight anyway: the
 *  question the date is asked is "could this text have known the deadline had
 *  passed", a day-granular answer is "possibly", and possibly is not
 *  established. That refuses some good NO verdicts to a human, which is the
 *  cheap direction; the other reading pays one out. Measured on real
 *  permalinks this is nearly moot, since every one of them declares a full
 *  timestamp. */
function parseDeclared(raw: string): Date | null {
  const t = raw.trim();
  const naive = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t);
  const d = new Date(naive ? `${t.replace(" ", "T")}Z` : t);
  const y = d.getUTCFullYear();
  // A parse landing outside any plausible range is a parse that failed.
  return Number.isNaN(d.getTime()) || y < 2000 || y > 2100 ? null : d;
}

function earliest(html: string, patterns: RegExp[]): Date | null {
  let best: Date | null = null;
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      const d = parseDeclared(m[1]);
      if (d && (!best || d < best)) best = d;
    }
  }
  return best;
}

const PUBLISHED = [
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/gi,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/gi,
  /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/gi,
  /<meta[^>]+name=["'](?:date|pubdate|publish[-_]?date)["'][^>]+content=["']([^"']+)["']/gi,
  /"datePublished"\s*:\s*"([^"]+)"/gi,
];
const MODIFIED = [
  /<meta[^>]+property=["']article:modified_time["'][^>]+content=["']([^"']+)["']/gi,
  /<meta[^>]+itemprop=["']dateModified["'][^>]+content=["']([^"']+)["']/gi,
  /<meta[^>]+name=["']last[-_]?modified["'][^>]+content=["']([^"']+)["']/gi,
  /"dateModified"\s*:\s*"([^"]+)"/gi,
];

/**
 * When this document says it was written. Null when it does not say.
 *
 * TWO CORRECTIONS LIVE HERE, IN OPPOSITE DIRECTIONS, AND BOTH WERE MEASURED.
 *
 * It first read the FIRST signal it found. Wikipedia's JSON-LD declares
 * datePublished 2001 on an article edited this morning, so every Wikipedia
 * citation looked a quarter-century old and every NO citing one was blocked.
 *
 * The obvious repair, take the NEWEST date anywhere in the HTML, was worse and
 * in the dangerous direction. Any templated news page carries a "latest
 * stories" sidebar with today's <time> in it, so a 2024 article was certified
 * as post-close and could settle a NO it could not possibly support. A
 * forward-looking calendar entry did the same. The staleness rule is the one
 * thing this file exists for and that repair defeated it.
 *
 * So: only DOCUMENT-LEVEL claims count, published preferred over modified, and
 * the earliest of them wins. Published is what "when was this written" means;
 * modified only says somebody touched the file, which a footer edit does. The
 * earliest is the conservative read, and conservative here means a NO gets
 * refused to a human rather than paid out on a stale page.
 *
 * <time datetime> is deliberately NOT read. It was the sidebar's way in, and
 * measuring 13 real article permalinks found 12 carrying document-level
 * metadata and NOT ONE relying on <time> alone, so dropping it costs nothing.
 * The remaining page (sec.gov) declares no date at all, which is its own
 * answer, not a gap.
 */
export function documentDateOf(html: string): string | null {
  const d = earliest(html, PUBLISHED) ?? earliest(html, MODIFIED);
  return d ? d.toISOString() : null;
}

/**
 * Does this quote name a date at or after `after`?
 *
 * This is how an UNDATED page can still establish a non-event, and the reason
 * that branch is needed at all was measured rather than guessed. A NO needs a
 * source that knows the whole window closed, and the right source for a NO is a
 * record that COVERS the window: a price history, a results table, an official
 * index. Those are LIVING pages, continuously updated, and a living page carries
 * no publication date. So the rule "dated at or after the close" and the
 * instruction "find a complete record" were in direct contradiction, and the
 * measurement showed it: of seven period-covering sources, six were perfectly
 * fetchable and almost every one of them declared no date at all.
 *
 * The quote is the way out. It is the span we have already verified is on the
 * page, so if it names a date inside or after the window, the page demonstrably
 * covers the period in question. A frozen old document does not accidentally
 * quote a date that had not happened when it was written.
 *
 * Deliberately narrow: only three unambiguous shapes are read, and anything it
 * cannot parse is simply no evidence of coverage rather than a guess. Being
 * unable to read a date must never become a reason to accept one.
 */
export function quoteCoversDate(quote: string, after: Date): boolean {
  const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
  const found: Date[] = [];
  const push = (y: number, mo: number, d: number) => {
    const dt = new Date(Date.UTC(y, mo, d));
    if (!Number.isNaN(dt.getTime()) && y >= 2000 && y <= 2100) found.push(dt);
  };
  const monthIndex = (name: string) => {
    const n = name.toLowerCase().slice(0, 3);
    return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(n);
  };
  // 2026-07-30
  for (const m of quote.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(+m[1], +m[2] - 1, +m[3]);
  // July 30, 2026  /  Jul 30 2026
  for (const m of quote.matchAll(new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "gi"))) {
    push(+m[3], monthIndex(m[1]), +m[2]);
  }
  // 30 July 2026
  for (const m of quote.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})\\.?,?\\s+(\\d{4})\\b`, "gi"))) {
    push(+m[3], monthIndex(m[2]), +m[1]);
  }
  return found.some((d) => d >= after);
}

/** Fetch seam. Swapped in tests so the audit's logic is exercised against known
 *  bytes rather than against whatever the internet is doing today. */
export type PageFetcher = (url: string) => Promise<{ ok: boolean; html: string; status: number; truncated?: boolean }>;

/** Decode with the charset the response actually declares.
 *
 *  Everything was read as UTF-8. A page served ISO-8859-1 or windows-1252 then
 *  turned every accented character into U+FFFD, so a quote containing one could
 *  never match and came back as though the source had invented it. Older
 *  institutional and regulatory sites are the common case for a non-UTF-8
 *  charset, and they are exactly what a NO on a regulatory market must cite. */
function decodeBody(buf: ArrayBuffer, contentType: string): string {
  const head = Buffer.from(buf.slice(0, 2048)).toString("latin1");
  const declared =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(declared.toLowerCase()).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

const liveFetch: PageFetcher = async (url) => {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, html: "", status: res.status };
    const buf = await res.arrayBuffer();
    const truncated = buf.byteLength > MAX_BYTES;
    return {
      ok: true,
      html: decodeBody(buf.slice(0, MAX_BYTES), res.headers.get("content-type") ?? ""),
      status: res.status,
      truncated,
    };
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

  // A PAGE THAT RENDERS ITS TEXT IN JAVASCRIPT WAS NOT READ, AND MUST NOT BE
  // ACCUSED. Measured on fifa.com: 4,551 bytes of markup arrive and the
  // extractor gets ZERO characters of prose out of them, because the content is
  // fetched by a script we never run. Calling that "the quoted words are not on
  // that page" is the same mistake as calling a truncated page absent, and it
  // is worse than useless: quote-absent is the status that discards the whole
  // verdict AND tells the operator a source was invented. The page did nothing
  // wrong; we simply cannot read it.
  //
  // Substantial markup with almost no prose is the signature. A genuinely tiny
  // document is not caught by this: a plain API response is a few hundred bytes
  // that are ALL content, and the ratio here is what separates the two.
  const readable = normalizeText(htmlToText(page.html));
  if (page.html.length > 1000 && readable.length < 200) {
    return { ...base, status: "unreachable", datedAt, note: "the page renders its text in JavaScript, so we could not read it" };
  }

  if (!pageContains(page.html, c.quote)) {
    // A page we only read part of cannot be said to lack the words. Long
    // Wikipedia season articles and live blogs routinely pass the cap, and they
    // are among the few sources measured as citable at all, so calling that
    // "the words are not there" both refuses the verdict and blames a source
    // that did nothing wrong.
    if (page.truncated) {
      return { ...base, status: "unreachable", datedAt, note: "page too large to read in full" };
    }
    return { ...base, status: "quote-absent", datedAt, note: "the quoted words are not on that page" };
  }

  if (closeTime && datedAt && new Date(datedAt) < closeTime) {
    return { ...base, status: "stale", datedAt, note: "dated before the market closed" };
  }
  // A page that declares NO date is its own answer, not a pass.
  //
  // This branch was missing and it was a hole in the one rule this file exists
  // for. The staleness test read `closeTime && datedAt && ...`, so a null date
  // short-circuited it, the citation came back "verified", and auditSupports
  // then told the operator "N citation(s) dated at or after the close" about a
  // page whose date nobody had established. Measured on real permalinks, the
  // undated class is not random: 3 of 23 declared no date and they were both
  // SEC press releases and a NASA release, which are exactly the sources a NO on
  // a regulatory or announcement market would reach for. An archived or
  // re-served old release would have sailed through a NO it cannot support.
  //
  // With no close time there is no deadline to miss, so the distinction is moot
  // and the citation is simply verified.
  if (closeTime && !datedAt) {
    // A living record proves its own coverage through the quote. See
    // quoteCoversDate: the page carries no date because it is continuously
    // updated, but the span we verified names a moment at or after the close,
    // so it demonstrably knows about the period the market asks about.
    if (quoteCoversDate(c.quote, closeTime)) {
      return { ...base, status: "verified", datedAt, note: "undated page, but the quote itself covers the close" };
    }
    return { ...base, status: "undated", datedAt, note: "quote found, but the page declares no date" };
  }
  return { ...base, status: "verified", datedAt, note: "quote found on the page" };
}

export interface AuditResult {
  citations: AuditedCitation[];
  /** Words found AND the page dated at or after the close. The only class a NO
   *  may rest on. */
  verified: number;
  /** Words found, no date declared anywhere on the page. Supports a YES; can
   *  never support a NO, because nothing established when it was written. */
  undated: number;
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
  /** Whether the market had a close time at all. A NO leans entirely on it, so
   *  it travels with the result rather than being assumed. */
  closeKnown: boolean;
}

export async function auditCitations(cites: Citation[], closeTime: Date | null): Promise<AuditResult> {
  const citations = await Promise.all(cites.map((c) => auditCitation(c, closeTime)));
  return {
    citations,
    verified: citations.filter((c) => c.status === "verified").length,
    undated: citations.filter((c) => c.status === "undated").length,
    stale: citations.filter((c) => c.status === "stale").length,
    absent: citations.filter((c) => c.status === "quote-absent").length,
    unreachable: citations.filter((c) => c.status === "unreachable").length,
    closeKnown: closeTime !== null,
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
  const dead = audit.unreachable > 0 ? `, ${audit.unreachable} unreachable` : "";

  if (outcome === "yes") {
    // A YES only needs the event shown. When the page was written, and whether
    // it says, does not bear on that.
    const parts = [
      audit.verified ? `${audit.verified} dated at or after the close` : "",
      audit.stale ? `${audit.stale} dated before it` : "",
      audit.undated ? `${audit.undated} undated` : "",
    ].filter(Boolean);
    if (parts.length === 0) return { ok: false, why: `no citation could be verified against its own page${dead}` };
    // The composition is spelled out rather than summed. It used to report
    // "N verified citation(s)" for a pile that was mostly stale or dateless,
    // and "verified" means something narrower than that everywhere else in this
    // file: the operator was being told the opposite of the distinction the
    // undated status was added to draw.
    return { ok: true, why: `${parts.join(", ")}${dead}` };
  }

  // A NO says a deadline was missed. With no deadline recorded there is nothing
  // to have missed, and the sentence this used to return named a close time
  // that did not exist.
  if (!audit.closeKnown) {
    return { ok: false, why: "this market has no close time, so nothing can establish that a deadline passed" };
  }
  if (audit.verified === 0) {
    if (audit.stale > 0) return { ok: false, why: `every verified citation predates the close, which cannot establish a non-event${dead}` };
    if (audit.undated > 0) return { ok: false, why: `no citation declares a date, so none of them can establish a non-event${dead}` };
    return { ok: false, why: `no citation could be verified against its own page${dead}` };
  }
  return { ok: true, why: `${audit.verified} citation(s) dated at or after the close${dead}` };
}
