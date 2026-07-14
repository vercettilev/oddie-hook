import { renderCard } from "../src/card/renderCard.js";
import { renderCardPng } from "../src/card/renderPng.js";
import { writeFileSync } from "node:fs";
const base = { venue:"polymarket", venueId:"x", closesAt:"2026-12-20T00:00:00Z", venueUrl:"x", tags:[] } as any;
const cases = [
  { ...base, question:"Will France win the 2026 FIFA World Cup?", yesPct:39, volumeUsd:4700000 },
  { ...base, question:"Will the Federal Reserve cut interest rates by 25 bps at its next meeting?", yesPct:8, volumeUsd:1250000 },
];
cases.forEach((m,i)=>{
  const png = renderCardPng(renderCard(m));
  writeFileSync(`/tmp/card-test${i}.png`, png);
  console.log(`card-test${i}.png bytes=${png.length} sig=${png.subarray(0,8).toString("hex")}`);
});
