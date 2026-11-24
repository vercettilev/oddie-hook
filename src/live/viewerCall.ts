/**
 * A live call oddie settles from the stream's own viewer count.
 *
 * WHY (Lev, 24 Nov). "Will we hit 500 viewers today?" is the one call whose
 * YES side can do something about the answer: bring somebody. Every other
 * call ends inside the chat it was asked in; this one sends the room out for
 * people.
 *
 * THE NUMBER IS THE PLATFORM'S. Twitch and Kick each publish a count for a
 * live stream, the one under the player, and oddie reads it about every half
 * minute while the call runs. The first reading at the number is a YES, said
 * with the reading. The stream ending first, or the question's own length
 * running out ("in the next 30 minutes"), is a NO. X hands no count over and
 * YouTube's is not read, so there the same question is an ordinary call, the
 * channel's to settle (src/live/calls.ts, viewerCallOf).
 *
 * A VOTE, NEVER A MARKET. A viewer count is a number anybody can buy, so no
 * money rides on one: !call runs it for points, and the market door turns the
 * same question away (!oddie, LIVE_COPY.viewersNoMarket).
 *
 * NARROW ON PURPOSE, as a price call is (src/live/priceCall.ts). Only a
 * question that says nothing but "this stream reaches N viewers" is read: one
 * number, going up, until the stream ends or within a length it states. A
 * name ("will xqc hit 100k viewers", whose count is not this channel's),
 * another condition ("before round 3"), a clock time, a count going down or
 * held ("stay above 300"), a count at the end ("end on 500") all stay the
 * channel's, exactly as before. A wrong result in a live chat costs more than
 * a mod typing !call yes.
 */
import { timeLabel } from "./priceCall.js";

export interface ViewerCall {
  /** The count the question names. */
  target: number;
  /** "over 500", "more than 500": above it. Otherwise reaching it is enough. */
  above: boolean;
  /** "in the next 30 minutes": how long from the open. null: until the stream ends. */
  minutes: number | null;
}

export const VIEWER_TARGET_MAX = 100_000_000;
/** A length past this is not a moment in a stream: left to the channel. */
export const VIEWER_WINDOW_MAX_MIN = 12 * 60;

const UNIT = String.raw`(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)`;
/** "in 30 min", "within the next 2 hours", "in half an hour", "within the hour". */
const WINDOW = new RegExp(String.raw`\b(?:in|within)\s+(?:the\s+)?(?:next\s+)?(?:(\d{1,3})\s*-?\s*${UNIT}|(half\s+an\s+hour)|((?:an\s+|one\s+|a\s+)?hour))\b`);
/** One count: "500", "2,000", "1.5k", "500+". Not "5m", "3rd" or "2x": what follows is part of it. */
const NUMBER = /(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(k)?(\+)?(?![a-z0-9])/g;

const STREAM = String.raw`(?:stream|broadcast|show|session)`;
/** Every way a chat says "while this stream is on": the only end such a call has. */
const UNTIL_THE_END: RegExp[] = [
  // "before the stream ends", "by the end of the stream", "until stream is over"
  new RegExp(String.raw`\b(?:before|by|until|till|til)\s+(?:the\s+)?(?:end\s+of\s+)?(?:the\s+|this\s+|my\s+|our\s+)?${STREAM}(?:\s+(?:ends|is\s+over|is\s+done|finishes|goes\s+offline))?(?![a-z'])`, "g"),
  // "before we end", "before I go offline"
  /\b(?:before|by\s+the\s+time)\s+(?:we|i)\s+(?:end|finish|go\s+offline|log\s+off|stop|wrap\s+up)(?:\s+(?:the\s+|this\s+)?(?:stream|broadcast|show))?(?![a-z'])/g,
  // "this stream", "on today's stream", "during the stream"
  new RegExp(String.raw`\b(?:(?:on|in|during)\s+)?(?:this|the|today's|tonight's|todays|tonights)\s+${STREAM}(?![a-z'])`, "g"),
  /\b(?:today|tonight)\b/g,
  /\bat\s+(?:any|some)\s+point\b/g,
  /\bsometime\b/g,
];

/** A count that has to be passed, not reached: only right in front of the number. */
const ABOVE = /\b(?:over|above|past|more\s+than|pass|passes|exceed|exceeds|surpass|surpasses)\s+(?:the\s+)?#/;
/** A question about now or before now is not one about the rest of the stream. */
const NOT_AHEAD = /^(?:have|has|had|did)\b|\b(?:do|does)\s+(?:we|i|you|they)\s+have\b/;

/** What is left of a question once its number, its length and its "this
 *  stream" are taken out may hold these words and no others. */
const WORDS: ReadonlySet<string> = new Set([
  // asking
  "will", "would", "can", "could", "do", "does", "is", "are", "shall", "should", "gonna", "going", "think", "bet", "let", "lets", "let's",
  // who
  "we", "we'll", "i", "i'll", "you", "they", "it", "us", "there", "the", "this", "that", "my", "our", "your", "chat", "stream", "channel", "streamer", "guys", "everyone", "everybody",
  // getting there
  "hit", "hits", "hitting", "reach", "reaches", "reaching", "get", "gets", "getting", "to", "up", "see", "sees", "have", "has", "make", "makes",
  "break", "breaks", "touch", "touches", "go", "goes", "be",
  // the count
  "viewers", "viewer", "ccv", "concurrent", "live", "count", "mark", "a", "an", "of",
  // nothing
  "please", "pls", "ok", "yo", "hey", "so",
]);

/** The viewer-count call in a question, or null when oddie should leave it to the channel. */
export function parseViewerCall(question: string): ViewerCall | null {
  let text = String(question ?? "").toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, " ").trim();
  if (!/\b(?:viewers?|ccv)\b/.test(text)) return null;
  // "50% more viewers" is a move, not a count.
  if (/%|\bpercent\b/.test(text)) return null;
  if (NOT_AHEAD.test(text)) return null;

  let minutes: number | null = null;
  const win = WINDOW.exec(text);
  if (win) {
    minutes = win[1] ? Number(win[1]) * (win[2].startsWith("h") ? 60 : 1) : win[3] ? 30 : 60;
    if (minutes < 1 || minutes > VIEWER_WINDOW_MAX_MIN) return null;
    text = `${text.slice(0, win.index)} ${text.slice(win.index + win[0].length)}`;
  }

  const numbers = [...text.matchAll(NUMBER)];
  if (numbers.length !== 1) return null;
  const [whole, digits, k] = numbers[0];
  // Whole viewers only, counted in digits: 1.1 times 1000 is not 1100 to a float.
  const [int, frac = ""] = digits.replace(/,/g, "").split(".");
  if (frac.length > (k ? 3 : 0)) return null;
  const target = Number(int) * (k ? 1000 : 1) + (k ? Number(frac.padEnd(3, "0")) : 0);
  if (!Number.isInteger(target) || target < 2 || target > VIEWER_TARGET_MAX) return null;
  text = `${text.slice(0, numbers[0].index)} # ${text.slice(numbers[0].index! + whole.length)}`;
  // Any other figure is another condition: "before round 3", "by 9pm", "5m".
  if (/\d/.test(text)) return null;

  for (const end of UNTIL_THE_END) text = text.replace(end, " ");
  const above = ABOVE.test(text);
  text = text.replace(ABOVE, " # ").replace(/\bat\s+least\s+#/, " # ");

  const words = text.replace(/[^a-z'# ]+/g, " ").split(" ").map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
  if (words.filter((w) => w === "#").length !== 1) return null;
  if (!words.some((w) => w === "viewers" || w === "viewer" || w === "ccv")) return null;
  if (!words.every((w) => w === "#" || WORDS.has(w))) return null;
  return { target, above, minutes };
}

/** A count as chat reads it: 1,500. */
export const viewersText = (n: number): string => Math.round(n).toLocaleString("en-US");

/** Has the count got there? "More than 500" needs 501. */
export const viewerMet = (vc: ViewerCall, count: number): boolean => (vc.above ? count > vc.target : count >= vc.target);

/** How many more it takes from `count`: 0 when it is there. */
export const viewersShort = (vc: ViewerCall, count: number): number => Math.max(0, (vc.above ? vc.target + 1 : vc.target) - count);

/** When a call with a length runs out; null for one that runs until the stream ends. */
export const viewerDeadline = (vc: ViewerCall, openedAt: number): number | null => (vc.minutes === null ? null : openedAt + vc.minutes * 60_000);

/** What the room hears about when it settles: "the moment the stream has 500 viewers, or when it ends". */
export function viewerWhenText(vc: ViewerCall, deadline: number | null): string {
  return `the moment the stream has ${vc.above ? "more than " : ""}${viewersText(vc.target)} viewers, or ${deadline === null ? "when it ends" : `at ${timeLabel(deadline)}`}`;
}
