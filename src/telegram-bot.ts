import { Bot, type Context } from "grammy";
import { loadConfig } from "./config.js";
import { SportyBetClient } from "./client.js";
import type { SportyBetBooking, SportyBetBookingLeg, SportyBetSelection } from "./types.js";
import { calcCombinedOdds } from "./odds.js";
import { interpretWithGemini } from "./agent.js";
import { BROAD_FOOTBALL_MARKET_IDS, marketSuggestions, resolveMarketQuery } from "./marketResolver.js";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required. Add it to a local .env file or environment variable.");
}

const client = new SportyBetClient(loadConfig());
const bot = new Bot(token);

const noStake = "\n\nNo wager was placed. This bot only reads and prepares non-staking SportyBet booking codes.";
const codePattern = /^[A-Z0-9]{4,12}$/i;

async function replyLong(ctx: Context, text: string): Promise<void> {
  const limit = 3900;
  if (text.length <= limit) {
    await ctx.reply(formatTelegramHtml(text), { parse_mode: "HTML" });
    return;
  }
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < 500) cut = limit;
    await ctx.reply(formatTelegramHtml(remaining.slice(0, cut)), { parse_mode: "HTML" });
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) await ctx.reply(formatTelegramHtml(remaining), { parse_mode: "HTML" });
}

function formatTelegramHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(/(booking code:\s*)([A-Z0-9]{4,12})/gi, "$1<code>$2</code>");
}

function odds(legs: SportyBetBookingLeg[]): number | null {
  const values = legs.map((leg) => leg.outcome.odds).filter((value) => Number.isFinite(value) && value > 0);
  return values.length === legs.length && values.length > 0 ? calcCombinedOdds(values) : null;
}

function selection(leg: SportyBetBookingLeg): SportyBetSelection {
  return {
    eventId: leg.eventId,
    marketId: leg.market.marketId,
    outcomeId: leg.outcome.outcomeId,
    specifier: leg.market.specifier,
    odds: leg.outcome.odds,
  };
}

function describe(booking: SportyBetBooking): string {
  const lines = [
    `Booking code: ${booking.shareCode}`,
    `Legs: ${booking.legs.length}`,
    `Combined odds: ${odds(booking.legs) ?? "unavailable"}`,
    booking.expiresAt ? `Expires: ${booking.expiresAt}` : "Expiry: unavailable",
    "",
  ];
  booking.legs.forEach((leg, index) => {
    lines.push(
      `${index + 1}. ${leg.homeTeam} vs ${leg.awayTeam}`,
      `   Kickoff: ${leg.startTime ?? "unknown"}`,
      `   Market: ${leg.market.marketName}${leg.market.specifier ? ` (${leg.market.specifier})` : ""}`,
      `   Selection: ${leg.outcome.outcomeName} @ ${leg.outcome.odds}`,
    );
  });
  return lines.join("\n") + noStake;
}

async function loadCode(code: string): Promise<SportyBetBooking> {
  const clean = code.trim().toUpperCase();
  if (!codePattern.test(clean)) throw new Error("That does not look like a valid SportyBet booking code.");
  return client.getBooking(clean);
}

async function createCode(legs: SportyBetBookingLeg[]): Promise<string> {
  if (!legs.length) throw new Error("The requested operation left no selections.");
  const booking = await client.createBooking(legs.map(selection));
  return `${describe(booking)}\n\nNew booking code: ${booking.shareCode}\nShare URL: ${booking.shareURL}${noStake}`;
}

type ResearchStyle = "conservative" | "balanced" | "high";

function todayBounds(tzOffsetMinutes: number): { start: number; end: number } {
  const now = new Date();
  const utcToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = utcToday - tzOffsetMinutes * 60_000;
  return { start, end: start + 24 * 60 * 60_000 };
}

function selectResearchLegs(
  fixtures: Awaited<ReturnType<SportyBetClient["getFixtures"]>>,
  style: ResearchStyle,
): SportyBetSelection[] {
  const result: SportyBetSelection[] = [];
  for (const fixture of fixtures) {
    const candidates = fixture.markets.flatMap((market) => market.outcomes
      .filter((outcome) => outcome.isActive && Number.isFinite(outcome.odds) && outcome.odds > 1)
      .map((outcome) => ({ market, outcome })));
    const preferred = candidates.filter(({ market, outcome }) => {
      const label = `${market.marketName} ${outcome.outcomeName}`.toLowerCase();
      if (style === "conservative") return /double chance|draw no bet|1x2/.test(label) && outcome.odds <= 1.8;
      if (style === "balanced") return /1x2|over\/under|both teams|double chance/.test(label) && outcome.odds <= 2.5;
      return outcome.odds >= 1.8 && outcome.odds <= 6;
    }).sort((a, b) => style === "high" ? b.outcome.odds - a.outcome.odds : a.outcome.odds - b.outcome.odds);
    const pick = preferred[0] ?? candidates.sort((a, b) => a.outcome.odds - b.outcome.odds)[0];
    if (pick) result.push({ eventId: fixture.eventId, marketId: pick.market.marketId, outcomeId: pick.outcome.outcomeId, specifier: pick.market.specifier, odds: pick.outcome.odds });
  }
  return result;
}

async function researchTicket(style: ResearchStyle): Promise<string> {
  const cfg = loadConfig();
  const bounds = todayBounds(cfg.tzOffsetMinutes);
  const fixtures = (await client.getFixtures({ timelineHours: 48, maxPages: 8 })).filter(
    (fixture) => fixture.startTimeMs >= bounds.start && fixture.startTimeMs < bounds.end && fixture.matchStatus === "Not start",
  );
  const selections = selectResearchLegs(fixtures, style).slice(0, style === "conservative" ? 5 : style === "balanced" ? 8 : 12);
  if (!selections.length) throw new Error(`No suitable upcoming fixtures were found for the ${style} style today.`);
  const created = await client.createBooking(selections);
  return `${style.toUpperCase()} RESEARCH TICKET\n${describe(created)}\n\nSelection method: live SportyBet markets and odds only; this is not a prediction and does not assess form, H2H, injuries, or probability.${noStake}`;
}

async function requestedMarketTicket(leagueQuery: string, marketQuery: string): Promise<string> {
  const cfg = loadConfig();
  marketQuery = resolveMarketQuery(marketQuery);
  const bounds = todayBounds(cfg.tzOffsetMinutes);
  const fixtures = (await client.getFixtures({ marketIds: BROAD_FOOTBALL_MARKET_IDS, timelineHours: 48, maxPages: 10 })).filter((fixture) =>
    fixture.startTimeMs >= bounds.start && fixture.startTimeMs < bounds.end && fixture.matchStatus === "Not start" && fixture.league.toLowerCase().includes(leagueQuery.toLowerCase()),
  );
  const selections: SportyBetSelection[] = [];
  const missing: string[] = [];
  for (const fixture of fixtures) {
    const match = fixture.markets.flatMap((market) => market.outcomes.filter((outcome) => outcome.isActive).map((outcome) => ({ market, outcome }))).find(({ market, outcome }) => `${market.marketName} ${outcome.outcomeName}`.toLowerCase().includes(marketQuery.toLowerCase()));
    if (match) selections.push({ eventId: fixture.eventId, marketId: match.market.marketId, outcomeId: match.outcome.outcomeId, specifier: match.market.specifier, odds: match.outcome.odds });
    else missing.push(`${fixture.homeTeam} vs ${fixture.awayTeam}`);
  }
  if (!selections.length) throw new Error(`No upcoming ${marketQuery} selections were found in ${leagueQuery}.`);
  const created = await client.createBooking(selections);
  return `REQUESTED TICKET\nLeague: ${leagueQuery}\nMarket: ${marketQuery}\n${describe(created)}\n\n${missing.length ? `Market unavailable for ${missing.length} game(s): ${missing.slice(0, 5).join(", ")}` : "The requested market was found for every matched game."}${noStake}`;
}

async function randomTargetTicket(target: number, requestedLegs?: number): Promise<string> {
  if (!Number.isFinite(target) || target <= 1 || target > 10000) throw new Error("Target odds must be between 1 and 10000.");
  if (requestedLegs != null && (!Number.isInteger(requestedLegs) || requestedLegs < 2 || requestedLegs > 30)) {
    throw new Error("The number of legs must be a whole number between 2 and 30.");
  }
  const fixtures = (await client.getFixtures({ timelineHours: 168, maxPages: 10 })).filter(
    (fixture) => fixture.matchStatus === "Not start" && fixture.startTimeMs > Date.now(),
  );
  const candidates = fixtures.map((fixture) => {
    const options = fixture.markets.flatMap((market) => market.outcomes
      .filter((outcome) => outcome.isActive && Number.isFinite(outcome.odds) && outcome.odds > 1.05 && outcome.odds <= 8)
      .map((outcome) => ({ eventId: fixture.eventId, marketId: market.marketId, outcomeId: outcome.outcomeId, specifier: market.specifier, odds: outcome.odds })));
    return options.length ? options[Math.floor(Math.random() * options.length)] : null;
  }).filter((value): value is NonNullable<typeof value> => value != null);
  const legCount = requestedLegs ?? Math.min(Math.max(2, Math.floor(Math.random() * 8) + 2), candidates.length);
  if (candidates.length < legCount) throw new Error(`SportyBet returned only ${candidates.length} suitable upcoming games, so I cannot build the requested ${legCount}-leg ticket.`);

  let best: SportyBetSelection[] = [];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3000; attempt++) {
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    const sample = shuffled.slice(0, legCount);
    const value = calcCombinedOdds(sample.map((item) => item.odds ?? 0));
    const distance = Math.abs(Math.log(value / target));
    if (distance < bestDistance) {
      best = sample;
      bestDistance = distance;
    }
    if (value >= target * 0.9 && value <= target * 1.1) break;
  }
  if (!best.length || best.length !== legCount || bestDistance > Math.abs(Math.log(1.1))) {
    throw new Error(`Could not find a ${legCount}-leg ticket within about 10% of ${target} combined odds. No ticket was created.`);
  }
  const created = await client.createBooking(best);
  return `RANDOM ${legCount}-LEG BETSLIP TARGET ${target}\n${describe(created)}\n\nThis was selected randomly from live upcoming SportyBet markets. The requested leg count was enforced; actual odds may differ if prices move.${noStake}`;
}

async function randomMarketTicket(marketQuery: string): Promise<string> {
  const resolvedMarket = resolveMarketQuery(marketQuery);
  const terms = resolvedMarket.toLowerCase().split(/\s+/).filter(Boolean);
  const fixtures = (await client.getFixtures({ marketIds: BROAD_FOOTBALL_MARKET_IDS, timelineHours: 168, maxPages: 10 })).filter(
    (fixture) => fixture.matchStatus === "Not start" && fixture.startTimeMs > Date.now(),
  );
  const candidates = fixtures.flatMap((fixture) => fixture.markets.flatMap((market) => market.outcomes
    .filter((outcome) => outcome.isActive && Number.isFinite(outcome.odds) && outcome.odds > 1)
    .filter((outcome) => {
      const label = `${market.marketName} ${outcome.outcomeName}`.toLowerCase();
      return terms.every((term) => label.includes(term));
    })
    .map((outcome) => ({ eventId: fixture.eventId, marketId: market.marketId, outcomeId: outcome.outcomeId, specifier: market.specifier, odds: outcome.odds }))));
  const byEvent = new Map<string, SportyBetSelection>();
  for (const candidate of candidates) if (!byEvent.has(candidate.eventId)) byEvent.set(candidate.eventId, candidate);
  const chosen = [...byEvent.values()].sort(() => Math.random() - 0.5).slice(0, 8);
  if (!chosen.length) throw new Error(`No upcoming SportyBet selections matched ${resolvedMarket}. Try /markets ${marketQuery} to see available names.`);
  const created = await client.createBooking(chosen);
  return `RANDOM ${resolvedMarket.toUpperCase()} TICKET\n${describe(created)}\n\nSelected randomly from current upcoming SportyBet markets.${noStake}`;
}

function chunks<T>(items: T[], count: number): T[][] {
  const result: T[][] = Array.from({ length: count }, () => []);
  items.forEach((item, index) => result[index % count]!.push(item));
  return result.filter((group) => group.length > 0);
}

function parseKeyValue(value: string): { key: string; query: string } {
  const separator = value.indexOf("=");
  if (separator < 1) return { key: "team", query: value };
  return { key: value.slice(0, separator).toLowerCase(), query: value.slice(separator + 1).trim() };
}

async function handleCommand(ctx: Context, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const command = (parts.shift() ?? "").toLowerCase().split("@")[0] ?? "";
  const args = parts;

  if (command === "/start" || command === "/help") {
    await ctx.reply([
      "SportyBet Helper",
      "",
      "Send a booking code or use one of these commands:",
      "/inspect CODE — show the ticket contents",
      "/split CODE 2 — split into 2 or 3 slips",
      "/regroup CODE league|date|kickoff — regroup legs",
      "/combine CODE1 CODE2 — merge tickets",
      "/trim CODE 20 — trim toward a target combined odds",
      "/remove CODE team=NAME|market=TEXT|date=YYYY-MM-DD|first|last",
      "/random CODE 3 — choose random legs",
      "/random-target 20 — randomly build a live ticket near 20 combined odds",
      "/market CODE Over 2.5 — change legs to an available market",
      "/markets [TEXT] — list matching football markets",
      "/research all — build conservative, balanced, and high-odds tickets from today's live games",
      "/today — show current upcoming fixtures",
      "",
      "Fresh form, H2H, injury, and live-result research is not guessed; it will be added when a verified sports-data source is configured.",
      noStake,
    ].join("\n"));
    return;
  }

  if (command === "/today") {
    const fixtures = await client.getFixtures({ timelineHours: 48, maxPages: 3 });
    const lines = fixtures.slice(0, 20).map((fixture, index) => `${index + 1}. ${fixture.homeTeam} vs ${fixture.awayTeam} — ${fixture.startTime} — ${fixture.league}`);
    await ctx.reply(["Upcoming SportyBet fixtures", "", ...(lines.length ? lines : ["No upcoming fixtures returned."]), noStake].join("\n"));
    return;
  }

  if (command === "/markets") {
    const query = args.join(" ");
    const suggestions = marketSuggestions(query, 30);
    await replyLong(ctx, [`Available market suggestions${query ? ` for “${query}”` : ""}:`, "", ...suggestions.map((item, index) => `${index + 1}. ${item}`), "", "Shorthand: GG, 1X, X2, DNB, HT/FT home/home, home team over 1.5", noStake].join("\n"));
    return;
  }

  if (command === "/research") {
    const requested = (args[0] ?? "all").toLowerCase();
    const styles: ResearchStyle[] = requested === "all" ? ["conservative", "balanced", "high"] : [requested as ResearchStyle];
    if (styles.some((style) => !["conservative", "balanced", "high"].includes(style))) {
      throw new Error("Usage: /research all|conservative|balanced|high");
    }
    const results: string[] = [];
    for (const style of styles) {
      try {
        results.push(await researchTicket(style));
      } catch (error) {
        results.push(`${style.toUpperCase()} RESEARCH TICKET\nNot created: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await replyLong(ctx, results.join("\n\n====================\n\n"));
    return;
  }

  if (command === "/inspect" || (args.length === 0 && codePattern.test(command.slice(1)))) {
    const booking = await loadCode(command === "/inspect" ? args[0] ?? "" : command.slice(1));
    await replyLong(ctx, describe(booking));
    return;
  }

  if (command === "/combine") {
    if (args.length < 2) throw new Error("Usage: /combine CODE1 CODE2 [CODE3]");
    const bookings = await Promise.all(args.map(loadCode));
    const seen = new Set<string>();
    const legs = bookings.flatMap((booking) => booking.legs).filter((leg) => {
      const key = `${leg.eventId}|${leg.market.marketId}|${leg.market.specifier ?? ""}|${leg.outcome.outcomeId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await replyLong(ctx, await createCode(legs));
    return;
  }

  if (command === "/split") {
    const booking = await loadCode(args[0] ?? "");
    const count = Math.min(Math.max(Number(args[1] ?? 2), 2), 3);
    const groups = chunks(booking.legs, count);
    const results: string[] = [];
    for (const [index, group] of groups.entries()) results.push(`Slip ${index + 1}\n${await createCode(group)}`);
    await replyLong(ctx, results.join("\n\n--------------------\n\n"));
    return;
  }

  if (command === "/regroup") {
    const booking = await loadCode(args[0] ?? "");
    const mode = (args[1] ?? "league").toLowerCase();
    const groups = new Map<string, SportyBetBookingLeg[]>();
    for (const leg of booking.legs) {
      const date = leg.startTime?.slice(0, 10) ?? "unknown-date";
      const fixture = mode === "league" ? await client.findEvent(leg.eventId) : null;
      const key = mode === "date" ? date : mode === "kickoff" ? (leg.startTime ?? "unknown-time").slice(0, 13) : fixture?.league || "unknown-league";
      const group = groups.get(key) ?? [];
      group.push(leg);
      groups.set(key, group);
    }
    const results: string[] = [];
    for (const [key, legs] of groups) results.push(`${mode} ${key}\n${await createCode(legs)}`);
    await replyLong(ctx, results.join("\n\n--------------------\n\n"));
    return;
  }

  if (command === "/trim") {
    const booking = await loadCode(args[0] ?? "");
    const target = Number(args[1]);
    if (!Number.isFinite(target) || target <= 1) throw new Error("Usage: /trim CODE TARGET_ODDS, e.g. /trim ABC123 20");
    const chosen: SportyBetBookingLeg[] = [];
    for (const leg of booking.legs) {
      const next = odds([...chosen, leg]);
      if (!chosen.length || (next != null && next <= target)) chosen.push(leg);
    }
    await replyLong(ctx, await createCode(chosen));
    return;
  }

  if (command === "/random") {
    const booking = await loadCode(args[0] ?? "");
    const count = Math.min(Math.max(Number(args[1] ?? 3), 1), booking.legs.length);
    const shuffled = [...booking.legs].sort(() => Math.random() - 0.5).slice(0, count);
    await replyLong(ctx, await createCode(shuffled));
    return;
  }

  if (command === "/random-target") {
    await replyLong(ctx, await randomTargetTicket(Number(args[0]), args[1] ? Number(args[1]) : undefined));
    return;
  }

  if (command === "/remove") {
    const booking = await loadCode(args[0] ?? "");
    const filter = (args.slice(1).join(" ") || "first").toLowerCase();
    let legs = [...booking.legs];
    if (filter === "first") legs = legs.slice(1);
    else if (filter === "last") legs = legs.slice(0, -1);
    else {
      const { key, query } = parseKeyValue(filter);
      if (!query) throw new Error("Usage: /remove CODE team=NAME, market=TEXT, or date=YYYY-MM-DD");
      legs = legs.filter((leg) => {
        const haystack = key === "market" ? leg.market.marketName + " " + leg.outcome.outcomeName : key === "date" ? leg.startTime ?? "" : `${leg.homeTeam} ${leg.awayTeam}`;
        return !haystack.toLowerCase().includes(query);
      });
    }
    await replyLong(ctx, await createCode(legs));
    return;
  }

  if (command === "/market") {
    const booking = await loadCode(args[0] ?? "");
    const target = resolveMarketQuery(args.slice(1).join(" ")).toLowerCase();
    if (!target) throw new Error("Usage: /market CODE MARKET, e.g. /market ABC123 Over 2.5");
    const changed: SportyBetSelection[] = [];
    const failures: string[] = [];
    for (const leg of booking.legs) {
      const fixture = await client.findEvent(leg.eventId);
      const match = fixture?.markets.flatMap((market) => market.outcomes.map((outcome) => ({ market, outcome }))).find(({ market, outcome }) => `${market.marketName} ${outcome.outcomeName}`.toLowerCase().includes(target));
      if (!match) failures.push(`${leg.homeTeam} vs ${leg.awayTeam}`);
      else changed.push({ eventId: leg.eventId, marketId: match.market.marketId, outcomeId: match.outcome.outcomeId, specifier: match.market.specifier, odds: match.outcome.odds });
    }
    if (failures.length) throw new Error(`No matching ${target} market was available for: ${failures.join(", ")}`);
    const created = await client.createBooking(changed);
    await ctx.reply(`${describe(created)}${noStake}`);
    return;
  }

  throw new Error("Unknown command. Send /help for available commands.");
}

function extractBookingCodes(text: string): string[] {
  const words = new Set(["A", "AN", "AND", "ALL", "AROUND", "BETSLIP", "BUILD", "CHANGE", "CHOOSE", "COMBINE", "COMBINED", "CONNER", "CORNER", "CORNERS", "DELETE", "DIVIDE", "DROP", "EXPLAIN", "FIRST", "FOR", "FRESH", "FROM", "GAMES", "GROUP", "HELP", "IN", "INSIDE", "INTO", "LAST", "MAKE", "MARKET", "ME", "MERGE", "NEW", "ODDS", "OF", "ON", "OR", "OVER", "PICK", "PLEASE", "RANDOM", "RANDOMLY", "READ", "REGROUP", "REMOVE", "RESEARCH", "SAFER", "SCAN", "SCRATCH", "SELECT", "SHOW", "SLIPS", "SPORTYBET", "SPLIT", "SWITCH", "TARGET", "THE", "THIS", "THROUGH", "TICKET", "TODAY", "TODAYS", "TO", "TRIM", "UNDER", "WHAT", "WHATS", "WHAT'S", "WITH"]);
  return [...new Set((text.toUpperCase().match(/\b[A-Z0-9]{4,12}\b/g) ?? []).filter((value) => !words.has(value)))];
}

async function handleNaturalLanguage(ctx: Context, text: string): Promise<boolean> {
  const lower = text.toLowerCase();
  const codes = extractBookingCodes(text);
  if (/(what.?s inside|show|inspect|read|explain|details)/.test(lower) && codes[0]) {
    await handleCommand(ctx, `/inspect ${codes[0]}`);
    return true;
  }
  if (/(split|safer slips|divide)/.test(lower) && codes[0]) {
    const count = Number((lower.match(/\b([23])\s*(?:slips?|tickets?|parts?)/) ?? [])[1] ?? 2);
    await handleCommand(ctx, `/split ${codes[0]} ${count}`);
    return true;
  }
  if (/(regroup|group|organize|sort)/.test(lower) && codes[0]) {
    const mode = /league/.test(lower) ? "league" : /kickoff|kick.off|time/.test(lower) ? "kickoff" : "date";
    await handleCommand(ctx, `/regroup ${codes[0]} ${mode}`);
    return true;
  }
  if (/(combine|merge|join)/.test(lower) && codes.length >= 2) {
    await handleCommand(ctx, `/combine ${codes.slice(0, 3).join(" ")}`);
    return true;
  }
  if (/(trim|cut|reduce|bring).*odds|odds.*(trim|cut|reduce|target)/.test(lower) && codes[0]) {
    const target = (lower.match(/(?:odds|target)\s*(?:of|to|around|at)?\s*(\d+(?:\.\d+)?)/) ?? [])[1];
    if (target) {
      await handleCommand(ctx, `/trim ${codes[0]} ${target}`);
      return true;
    }
  }
  if (/(remove|delete|drop|take out)/.test(lower) && codes[0]) {
    const filter = /first/.test(lower) ? "first" : /last/.test(lower) ? "last" : /market/.test(lower) ? `market=${text.replace(/.*market\s+(?:called\s+)?/i, "")}` : /date/.test(lower) ? `date=${(text.match(/\d{4}-\d{2}-\d{2}/) ?? [""])[0]}` : `team=${text.replace(/.*(?:team|game|match)\s+(?:called\s+)?/i, "")}`;
    await handleCommand(ctx, `/remove ${codes[0]} ${filter}`);
    return true;
  }
  if (/(random|randomly).*(pick|select|choose|games|legs)/.test(lower) && codes[0]) {
    const count = Number((lower.match(/\b(\d+)\s*(?:games?|legs?|selections?)/) ?? [])[1] ?? 3);
    await handleCommand(ctx, `/random ${codes[0]} ${count}`);
    return true;
  }
  if (!codes[0] && /(?:random|randomly|build|make).*(?:around|near|target)?.*(?:odds?)?\s*\d+(?:\.\d+)?/.test(lower)) {
    const target = (lower.match(/(?:around|near|target|odds?)\s*(?:of|at|to)?\s*(\d+(?:\.\d+)?)/) ?? lower.match(/(?:random|randomly|build|make)[^\d]{0,30}(\d+(?:\.\d+)?)/) ?? [])[1];
    if (target) {
      const legs = Number((lower.match(/\b(\d+)\s*(?:-?leg|games?|picks?|selections?)/) ?? [])[1]);
      await replyLong(ctx, await randomTargetTicket(Number(target), Number.isFinite(legs) ? legs : undefined));
      return true;
    }
  }
  if (!codes[0] && /random|build|make|scan/.test(lower) && /over\s+(?:corner|corners|conner)/.test(lower)) {
    await replyLong(ctx, await randomMarketTicket("over corner"));
    return true;
  }
  if (!codes[0] && /(?:research|find|build|make|pick|select)/.test(lower) && /\b(?:gg|btts|1x|x2|dnb|draw no bet|ht\/?ft\s+home\/home|home team (?:over|under)\s+\d)/.test(lower)) {
    const shorthand = lower.match(/\b(?:gg|btts|1x|x2|dnb|draw no bet|ht\/?ft\s+home\/home|home team (?:over|under)\s+\d+(?:\.\d+)?)\b/)?.[0];
    if (shorthand) {
      const leagueMatch = lower.match(/(?:today'?s?|today)\s+(.+?)\s+(?:games?|matches?)/);
      if (leagueMatch?.[1]) {
        await replyLong(ctx, await requestedMarketTicket(leagueMatch[1].trim(), shorthand));
        return true;
      }
    }
  }
  if (/(change|switch|convert|replace).*(market|markets)/.test(lower) && codes[0]) {
    const target = text.replace(/.*?(?:to|into)\s+/i, "").trim();
    await handleCommand(ctx, `/market ${codes[0]} ${target}`);
    return true;
  }
  if (!codes[0] && /\b(?:today|today's)\b/.test(lower) && /\b(?:over|under|both teams|double chance|draw no bet)\b/.test(lower)) {
    const marketMatch = lower.match(/\b(over\s*\d+(?:\.\d+)?|under\s*\d+(?:\.\d+)?|both teams to score|double chance|draw no bet)\b/);
    const leagueMatch = lower.match(/(?:today'?s?|today)\s+(.+?)\s+(?:games?|matches?)/);
    if (marketMatch?.[1] && leagueMatch?.[1]) {
      await replyLong(ctx, await requestedMarketTicket(leagueMatch[1].trim(), marketMatch[1].trim()));
      return true;
    }
  }
  if (/(research|today|fresh|new tickets?|build.*from scratch)/.test(lower) && !codes[0]) {
    await handleCommand(ctx, "/research all");
    return true;
  }
  return false;
}

async function handleWithAgent(ctx: Context, text: string): Promise<boolean> {
  const intent = await interpretWithGemini(text);
  if (!intent) return false;
  switch (intent.kind) {
    case "inspect": await handleCommand(ctx, `/inspect ${intent.codes[0] ?? ""}`); return true;
    case "split": await handleCommand(ctx, `/split ${intent.codes[0] ?? ""} ${intent.count || 2}`); return true;
    case "regroup": await handleCommand(ctx, `/regroup ${intent.codes[0] ?? ""} ${intent.mode || "league"}`); return true;
    case "combine": await handleCommand(ctx, `/combine ${intent.codes.join(" ")}`); return true;
    case "trim": await handleCommand(ctx, `/trim ${intent.codes[0] ?? ""} ${intent.target}`); return true;
    case "remove": await handleCommand(ctx, `/remove ${intent.codes[0] ?? ""} ${intent.filter || "first"}`); return true;
    case "random_existing": await handleCommand(ctx, `/random ${intent.codes[0] ?? ""} ${intent.count || 3}`); return true;
    case "random_target": await handleCommand(ctx, `/random-target ${intent.target}${intent.legs ? ` ${intent.legs}` : ""}`); return true;
    case "market": await handleCommand(ctx, `/market ${intent.codes[0] ?? ""} ${intent.market}`); return true;
    case "league_market": await requestedMarketTicket(intent.league, intent.market).then((result) => replyLong(ctx, result)); return true;
    case "random_market": await replyLong(ctx, await randomMarketTicket(intent.market)); return true;
    case "research": await handleCommand(ctx, `/research ${intent.style || "all"}`); return true;
    case "help": await handleCommand(ctx, "/help"); return true;
    case "clarify": await ctx.reply(`I won't guess on this request. ${intent.reason || "Please specify the league, market, number of selections, or target odds."}${noStake}`); return true;
    default: return false;
  }
}

bot.command(["start", "help", "today", "markets", "research", "inspect", "combine", "split", "regroup", "trim", "random", "random-target", "remove", "market"], async (ctx) => {
  try {
    await handleCommand(ctx, ctx.message?.text ?? "");
  } catch (error) {
    await ctx.reply(`Could not complete that request: ${error instanceof Error ? error.message : String(error)}${noStake}`);
  }
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (codePattern.test(text)) {
    try {
      await ctx.reply(describe(await loadCode(text)));
    } catch (error) {
      await ctx.reply(`Could not read that booking code: ${error instanceof Error ? error.message : String(error)}${noStake}`);
    }
  } else {
    if (/^(hi|hello|hey|good morning|good afternoon|good evening|help)$/i.test(text)) {
      await handleCommand(ctx, "/help");
      return;
    }
    try {
      if (await handleNaturalLanguage(ctx, text)) return;
    } catch (error) {
      await ctx.reply(`The local football engine understood the request but SportyBet could not complete it: ${error instanceof Error ? error.message : String(error)}${noStake}`);
      return;
    }
    if (process.env.GEMINI_API_KEY?.trim()) {
      try {
        if (await handleWithAgent(ctx, text)) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const quota = /HTTP 429|quota|rate.?limit|exceeded/i.test(message);
        await ctx.reply(quota
          ? `The local football engine could not match that wording, and Gemini is temporarily out of quota. No ticket was created. Try a more direct request such as “today's Eredivisie games over 2.5” or “random over corners.”${noStake}`
          : `The local football engine could not match that wording, and Gemini could not safely interpret it. No ticket was created. Please specify the league, market, number of picks, or target odds.${noStake}`);
        return;
      }
    }
    await ctx.reply(`I could not match that request safely. Please specify the action and any exact league, market, number of picks, or target odds. Gemini is optional and was not used for this request.${noStake}`);
  }
});

bot.catch((error) => console.error("Telegram bot error", error.error));
console.log("SportyBet Telegram bot starting in polling mode...");
await bot.start();
