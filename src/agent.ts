export type AgentIntent =
  | { kind: "inspect"; codes: string[] }
  | { kind: "split"; codes: string[]; count: number }
  | { kind: "regroup"; codes: string[]; mode: "league" | "date" | "kickoff" }
  | { kind: "combine"; codes: string[] }
  | { kind: "trim"; codes: string[]; target: number }
  | { kind: "remove"; codes: string[]; filter: string }
  | { kind: "random_existing"; codes: string[]; count: number }
  | { kind: "random_target"; target: number }
  | { kind: "market"; codes: string[]; market: string }
  | { kind: "league_market"; league: string; market: string }
  | { kind: "research"; style: "all" | "conservative" | "balanced" | "high" }
  | { kind: "help" };

const schema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["inspect", "split", "regroup", "combine", "trim", "remove", "random_existing", "random_target", "market", "league_market", "research", "help"] },
    codes: { type: "array", items: { type: "string" } },
    count: { type: "integer" },
    target: { type: "number" },
    mode: { type: "string", enum: ["league", "date", "kickoff"] },
    filter: { type: "string" },
    market: { type: "string" },
    league: { type: "string" },
    style: { type: "string", enum: ["all", "conservative", "balanced", "high"] },
  },
  required: ["kind"],
};

const system = `You are the intent parser for a SportyBet ticket assistant. Return JSON only matching the schema. Never invent booking codes: copy only codes explicitly present in the user message. The assistant only prepares non-staking share codes and never places bets. Interpret natural language precisely. Use random_target for requests like “build me a random betslip around 20” even when the user omits the word odds. Use league_market for requests like “book today’s Eredivisie games over 2.5”. Use research for today/fresh games when no league and market are specified. Resolve football shorthand exactly: GG or BTTS means GG/NG Yes, 1X and X2 mean the corresponding Double Chance outcome, DNB means Draw No Bet, HT/FT home/home means Half Time/Full Time Home/Home, and home team over 1.5 means Home Team Goals Over 1.5. Preserve other market wording such as totals, handicaps, halves, combos, corners, cards, and correct score. For remove, put a concise filter such as first, last, team=Arsenal, market=Over 2.5, or date=2026-09-22. For market, put only the requested target market in market.`;

export async function interpretWithGemini(text: string): Promise<AgentIntent | null> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const configuredModel = process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash";
  const model = configuredModel === "gemini-2.5-flash" ? "gemini-3.6-flash" : configuredModel;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: schema },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini agent request failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }
  const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error("Gemini agent returned no structured intent.");
  return JSON.parse(raw) as AgentIntent;
}
