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
      "/market CODE Over 2.5 — change legs to an available market",
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

bot.command(["start", "help", "today", "inspect", "combine", "split", "regroup", "trim", "random", "remove", "market"], async (ctx) => {
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
    await ctx.reply("Send a SportyBet booking code or /help for commands.");
  }
});

bot.catch((error) => console.error("Telegram bot error", error.error));
console.log("SportyBet Telegram bot starting in polling mode...");
await bot.start();
