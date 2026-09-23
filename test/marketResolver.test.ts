import { test } from "node:test";
import assert from "node:assert/strict";
import { marketSuggestions, resolveMarketQuery, BROAD_FOOTBALL_MARKET_IDS } from "../src/marketResolver.js";

test("market shorthand resolves to searchable SportyBet labels", () => {
  assert.equal(resolveMarketQuery("GG"), "GG/NG Yes");
  assert.equal(resolveMarketQuery("1X"), "Double Chance 1X");
  assert.equal(resolveMarketQuery("DNB"), "Draw No Bet");
  assert.equal(resolveMarketQuery("HT/FT home/home"), "Half Time/Full Time Home/Home");
  assert.equal(resolveMarketQuery("home team over 1.5"), "Home Team Goals Over 1.5");
});

test("market suggestions are searchable and broad football IDs are available", () => {
  assert.ok(marketSuggestions("corner").some((name) => /corner/i.test(name)));
  assert.ok(marketSuggestions("over").some((name) => /over/i.test(name)));
  assert.ok(BROAD_FOOTBALL_MARKET_IDS.includes("185"));
  assert.ok(BROAD_FOOTBALL_MARKET_IDS.includes("60100"));
});
