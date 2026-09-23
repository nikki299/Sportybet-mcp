import { MARKET_CATALOGUE } from "./marketCatalogue.js";

export const MARKET_ALIASES: Readonly<Record<string, string>> = {
  gg: "GG/NG Yes",
  "gg/ng": "GG/NG Yes",
  btts: "GG/NG Yes",
  "both teams to score": "GG/NG Yes",
  "both teams score": "GG/NG Yes",
  "1x": "Double Chance 1X",
  "x2": "Double Chance X2",
  dnb: "Draw No Bet",
  "draw no bet": "Draw No Bet",
  "home/home": "Half Time/Full Time Home/Home",
  "ht/ft home/home": "Half Time/Full Time Home/Home",
  "ht-ft home/home": "Half Time/Full Time Home/Home",
};

export function normalizeMarketText(value: string): string {
  return value.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

export function resolveMarketQuery(value: string): string {
  const normalized = normalizeMarketText(value);
  const alias = MARKET_ALIASES[normalized];
  if (alias) return alias;
  const homeTeamOver = normalized.match(/^home team (?:over|more than)\s*(\d+(?:\.\d+)?)$/);
  if (homeTeamOver) return `Home Team Goals Over ${homeTeamOver[1]}`;
  const awayTeamOver = normalized.match(/^away team (?:over|more than)\s*(\d+(?:\.\d+)?)$/);
  if (awayTeamOver) return `Away Team Goals Over ${awayTeamOver[1]}`;
  const homeTeamUnder = normalized.match(/^home team under\s*(\d+(?:\.\d+)?)$/);
  if (homeTeamUnder) return `Home Team Goals Under ${homeTeamUnder[1]}`;
  const awayTeamUnder = normalized.match(/^away team under\s*(\d+(?:\.\d+)?)$/);
  if (awayTeamUnder) return `Away Team Goals Under ${awayTeamUnder[1]}`;
  return value.trim();
}

export function marketSuggestions(query = "", limit = 12): string[] {
  const needle = normalizeMarketText(query);
  const values = [...new Set([
    ...MARKET_CATALOGUE.map(([, name]) => name),
    "GG/NG Yes",
    "Double Chance 1X",
    "Double Chance X2",
    "Half Time/Full Time Home/Home",
    "Home Team Goals Over 1.5",
    "Home Team Goals Under 1.5",
    "Away Team Goals Over 1.5",
    "Away Team Goals Under 1.5",
  ])];
  return values.filter((name) => !needle || normalizeMarketText(name).includes(needle)).slice(0, limit);
}

/** IDs 1–185 cover the broad football catalogue; special promotional IDs are added explicitly. */
export const BROAD_FOOTBALL_MARKET_IDS = [
  ...Array.from({ length: 185 }, (_, index) => String(index + 1)),
  "60100", "60200", "60210", "60110",
];
