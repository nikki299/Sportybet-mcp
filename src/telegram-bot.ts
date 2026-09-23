import { Bot, type Context } from "grammy";
import { loadConfig } from "./config.js";
import { SportyBetClient } from "./client.js";
import type { SportyBetBooking, SportyBetBookingLeg, SportyBetSelection } from "./types.js";
import { calcCombinedOdds } from "./odds.js";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required. Add it to a local .env file or environment variable.");
}

const client = new SportyBetClient(loadConfig());
const bot = new Bot(token);

const noStake = "\n\nNo wager was placed. This bot only reads and prepares non-staking SportyBet booking codes.";
const codePattern = /^[A-Z0-9]{4,12}$/i;

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

async function randomTargetTicket(target: number): Promise<string> {
  if (!Number.isFinite(target) || target <= 1 || target > 10000) throw new Error("Target odds must be between 1 and 10000.");
  const fixtures = (await client.getFixtures({ timelineHours: 168, maxPages: 10 })).filter(
    (fixture) => fixture.matchStatus === "Not start" && fixture.startTimeMs > Date.now(),
  );
  const candidates = fixtures.map((fixture) => {
    const options = fixture.markets.flatMap((market) => market.outcomes
      .filter((outcome) => outcome.isActive && Number.isFinite(outcome.odds) && outcome.odds > 1.05 && outcome.odds <= 8)
      .map((outcome) => ({ eventId: fixture.eventId, marketId: market.marketId, outcomeId: outcome.outcomeId, specifier: market.specifier, odds: outcome.odds })));
    return options.length ? options[Math.floor(Math.random() * options.length)] : null;
  }).filter((value): value is NonNullable<typeof value> => value != null);
  if (candidates.length < 2) throw new Error("SportyBet returned too few suitable upcoming games.");

  let best: SportyBetSelection[] = [];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3000; attempt++) {
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    const count = Math.min(Math.max(2, Math.floor(Math.random() * 8) + 2), shuffled.length);
    const sample = shuffled.slice(0, count);
    const value = calcCombinedOdds(sample.map((item) => item.odds ?? 0));
    const distance = Math.abs(Math.log(value / target));
    if (distance < bestDistance) {
      best = sample;
      bestDistance = distance;
    }
    if (value >= target * 0.9 && value <= target * 1.1) break;
  }
  if (!best.length) throw new Error("Could not find a random ticket near the requested target.");
  const created = await client.createBooking(best);
  return `RANDOM BETSLIP TARGET ${target}\n${describe(created)}\n\nThis was selected randomly from live upcoming SportyBet markets. Actual combined odds may differ if prices move.${noStake}`;
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
    await ctx.reply(results.join("\n\n====================\n\n"));
    return;
  }

  if (command === "/inspect" || (args.length === 0 && codePattern.test(command.slice(1)))) {
    const booking = await loadCode(command === "/inspect" ? args[0] ?? "" : command.slice(1));
    await ctx.reply(describe(booking));
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
    await ctx.reply(await createCode(legs));
    return;
  }

  if (command === "/split") {
    const booking = await loadCode(args[0] ?? "");
    const count = Math.min(Math.max(Number(args[1] ?? 2), 2), 3);
    const groups = chunks(booking.legs, count);
    const results: string[] = [];
    for (const [index, group] of groups.entries()) results.push(`Slip ${index + 1}\n${await createCode(group)}`);
    await ctx.reply(results.join("\n\n--------------------\n\n"));
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
    await ctx.reply(results.join("\n\n--------------------\n\n"));
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
    await ctx.reply(await createCode(chosen));
    return;
  }

  if (command === "/random") {
    const booking = await loadCode(args[0] ?? "");
    const count = Math.min(Math.max(Number(args[1] ?? 3), 1), booking.legs.length);
    const shuffled = [...booking.legs].sort(() => Math.random() - 0.5).slice(0, count);
    await ctx.reply(await createCode(shuffled));
    return;
  }

  if (command === "/random-target") {
    await ctx.reply(await randomTargetTicket(Number(args[0])));
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
    await ctx.reply(await createCode(legs));
    return;
  }

  if (command === "/market") {
    const booking = await loadCode(args[0] ?? "");
    const target = args.slice(1).join(" ").toLowerCase();
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
  return [...new Set((text.toUpperCase().match(/\b[A-Z0-9]{4,12}\b/g) ?? []).filter((value) => !["BUILD", "RANDOM", "BETSLIP", "AROUND", "ODDS", "TODAY", "TICKET", "SPLIT", "COMBINE", "REMOVE", "MARKET", "CHANGE", "TARGET", "FIRST", "LAST", "INTO", "WITH", "FROM"].includes(value)))];
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
  if (/(change|switch|convert|replace).*(market|markets)/.test(lower) && codes[0]) {
    const target = text.replace(/.*?(?:to|into)\s+/i, "").trim();
    await handleCommand(ctx, `/market ${codes[0]} ${target}`);
    return true;
  }
  if (/(research|today|fresh|new tickets?|build.*from scratch)/.test(lower) && !codes[0]) {
    await handleCommand(ctx, "/research all");
    return true;
  }
  return false;
}

bot.command(["start", "help", "today", "research", "inspect", "combine", "split", "regroup", "trim", "random", "random-target", "remove", "market"], async (ctx) => {
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
    const targetMatch = /(?:random|randomly|build|make).*?(?:around|near|target).*?(\d+(?:\.\d+)?)\s*odds?/i.exec(text) ?? /(?:random|randomly).*?(\d+(?:\.\d+)?)\s*odds?/i.exec(text);
    if (targetMatch?.[1]) {
      try {
        await ctx.reply(await randomTargetTicket(Number(targetMatch[1])));
      } catch (error) {
        await ctx.reply(`Could not build that random betslip: ${error instanceof Error ? error.message : String(error)}${noStake}`);
      }
      return;
    }
    try {
      if (await handleNaturalLanguage(ctx, text)) return;
    } catch (error) {
      await ctx.reply(`Could not complete that ticket request: ${error instanceof Error ? error.message : String(error)}${noStake}`);
      return;
    }
    await ctx.reply("Send a SportyBet booking code or /help for commands.");
  }
});

bot.catch((error) => console.error("Telegram bot error", error.error));
console.log("SportyBet Telegram bot starting in polling mode...");
await bot.start();
