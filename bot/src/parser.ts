import OpenAI from "openai";
import { config } from "./config.js";

const client = new OpenAI({
  baseURL: config.openaiBaseUrl,
  apiKey: config.openaiApiKey || "noop",
});

export interface ParsedBet {
  ok: boolean;
  reason?: string;
  question?: string;        // a clean YES/NO claim
  creator_yes?: boolean;    // does the speaker bet YES on the claim?
  stake_gen?: number;       // amount in whole GEN
  deadline_iso?: string;    // ISO-8601 UTC timestamp
  resolution_url?: string;  // optional URL the LLM saw in the message
  opponent_handle?: string; // bare username (no @)
  category?: "crypto" | "sports" | "news" | "generic" | string;
  sport?: string;
  league?: string;
  event_name?: string;
  event_time_iso?: string;
  market?: string;
  selection?: string;
  settlement_rule?: string;
  source_hint?: string;
}

const SYSTEM = `You convert casual group-chat bet challenges into a structured proposal.
Today's date in UTC will be supplied. The user message often pings a bot.

Output STRICT JSON, nothing else. Schema:
{
  "ok": boolean,
  "reason": string,                 // present iff ok=false
  "question": string,               // a precise YES/NO claim, present-tense or future-tense
  "creator_yes": boolean,           // true iff the speaker is asserting the YES side
  "stake_gen": number,              // positive number; whole GEN units (e.g. 10 not 10000000000000000000)
  "deadline_iso": string,           // ISO 8601 UTC; accept/resolve cutoff described in the rules below
  "resolution_url": string,         // URL the speaker pasted, or "" if none
  "opponent_handle": string,        // @username they challenged, without the @, or ""
  "category": "crypto" | "sports" | "news" | "generic",
  "sport": string,                  // sports only, e.g. football, basketball
  "league": string,                 // sports only, if known
  "event_name": string,             // sports only, e.g. "Chelsea vs Arsenal"
  "event_time_iso": string,         // sports only, if the event time is stated or confidently inferable
  "market": string,                 // e.g. match_winner, price_touch, public_fact
  "selection": string,              // sports: team/player picked; news: short YES condition
  "settlement_rule": string,        // exact rule, e.g. "Draw counts as NO"
  "source_hint": string             // pasted URL or named source if mentioned
}

Rules:
- If the message isn't a bet, set ok=false with a short reason.
- If stake or deadline are missing, infer reasonable defaults: stake=1, deadline = end of day UTC tomorrow.
- The "question" must be a specific factual YES/NO claim, e.g. "Lakers beat Bulls in the NBA game on 2026-04-30".
- Strip emojis, mentions and chat noise from "question".
- "creator_yes" should be true unless the speaker is clearly betting AGAINST the claim.
- "deadline_iso" must be in the future relative to "today".
- For sports bets, "deadline_iso" is the cutoff for accepting the bet, normally kickoff/start time or the user's stated pre-event lock time. Do not set it after the result is likely known.
- For sports winner bets, keep the claim as YES/NO: "Will <selection> win ...?". If a draw is possible, settlement_rule should say "Draw counts as NO" unless the user explicitly picked draw/double-chance.
- For news or political bets, rewrite vague language into a concrete deadline and objective condition. Example: "Will the US bomb Iran tonight?" becomes a claim about a confirmed US military strike before a specific UTC deadline.
- If the claim is too vague to resolve fairly, set ok=false and explain what detail is missing.`;

export async function parseBetFromText(
  text: string,
  nowIso: string,
): Promise<ParsedBet> {
  if (!config.openaiApiKey) {
    return { ok: false, reason: "AI parser is not configured (missing API key)." };
  }
  try {
    const res = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Today (UTC): ${nowIso}\n\nMessage:\n${text}`,
        },
      ],
      response_format: { type: "json_object" },
    });
    const raw = res.choices[0]?.message?.content || "{}";
    const obj = JSON.parse(raw) as ParsedBet;
    if (!obj.ok) return obj;
    if (!obj.question || !obj.deadline_iso || !obj.stake_gen) {
      return { ok: false, reason: "Missing required fields after parse." };
    }
    if (Number.isNaN(Number(obj.stake_gen)) || Number(obj.stake_gen) <= 0) {
      return { ok: false, reason: "Stake must be positive." };
    }
    const dl = Date.parse(obj.deadline_iso);
    if (!Number.isFinite(dl) || dl <= Date.now()) {
      return { ok: false, reason: "Deadline must be in the future." };
    }
    obj.creator_yes = obj.creator_yes !== false;
    obj.resolution_url = obj.resolution_url || "";
    obj.opponent_handle = (obj.opponent_handle || "").replace(/^@/, "");
    obj.category = obj.category || "generic";
    obj.sport = obj.sport || "";
    obj.league = obj.league || "";
    obj.event_name = obj.event_name || "";
    obj.event_time_iso = obj.event_time_iso || "";
    obj.market = obj.market || "";
    obj.selection = obj.selection || "";
    obj.settlement_rule = obj.settlement_rule || "";
    obj.source_hint = obj.source_hint || obj.resolution_url || "";
    return obj;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Parser error: ${msg}` };
  }
}
