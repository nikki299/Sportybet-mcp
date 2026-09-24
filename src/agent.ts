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
  | { kind: "random_market"; market: string }
  | { kind: "research"; style: "all" | "conservative" | "balanced" | "high" }
  | { kind: "help" }
  | { kind: "clarify"; reason: string };

const schema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["inspect", "split", "regroup", "combine", "trim", "remove", "random_existing", "random_target", "market", "league_market", "random_market", "research", "help", "clarify"] },
    codes: { type: "array", items: { type: "string" } },
    count: { type: "integer" },
    target: { type: "number" },
    mode: { type: "string", enum: ["league", "date", "kickoff"] },
    filter: { type: "string" },
    market: { type: "string" },
    league: { type: "string" },
    style: { type: "string", enum: ["all", "conservative", "balanced", "high"] },
    reason: { type: "string" },
  },
  required: ["kind"],
};

const system = `You are a strict production intent router for a SportyBet football utility. Return JSON only matching the schema. Never invent, repair, or infer booking codes: copy only an explicit alphanumeric code from the user, and use clarify if it is missing or ambiguous. Never claim to have scanned the website, checked form, H2H, injuries, or predicted a winner; the application will validate every market and price against live SportyBet data. The application only prepares non-staking share codes and never places bets.

Route precisely: inspect/show contents -> inspect; split/regroup/combine/trim/remove/change market -> the matching operation; “random betslip around 20 odds” -> random_target; “random over corners” (including conner) -> random_market with market “Over corner”; a named league plus market -> league_market; fresh/today games without a precise market -> research. Use clarify instead of research when the user specifies a market, league, odds target, number of picks, or other constraint that cannot be represented exactly. Resolve shorthand exactly: GG or BTTS -> “GG/NG Yes”; 1X or X2 -> the corresponding Double Chance outcome; DNB -> “Draw No Bet”; HT/FT home/home -> “Half Time/Full Time Home/Home”; home team over 1.5 -> “Home Team Goals Over 1.5”. Preserve exact market constraints such as totals, handicaps, halves, combos, corners, cards, and correct score. If the request asks for “good”, “best”, “sure”, guaranteed, or high-probability picks without a defined market, use clarify and explain that live odds are not a guarantee. For clarify, provide a short question or reason rather than guessing.`;

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
  const parsed = JSON.parse(raw) as AgentIntent;
  if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") throw new Error("Gemini returned an invalid intent.");
  return parsed;
}
