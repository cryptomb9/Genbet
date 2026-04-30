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
  "deadline_iso": string,           // ISO 8601 UTC; choose a sensible cutoff after the event
  "resolution_url": string,         // URL the speaker pasted, or "" if none
  "opponent_handle": string         // @username they challenged, without the @, or ""
}

Rules:
- If the message isn't a bet, set ok=false with a short reason.
- If stake or deadline are missing, infer reasonable defaults: stake=1, deadline = end of day UTC tomorrow.
- The "question" must be a specific factual YES/NO claim, e.g. "Lakers beat Bulls in the NBA game on 2026-04-30".
- Strip emojis, mentions and chat noise from "question".
- "creator_yes" should be true unless the speaker is clearly betting AGAINST the claim.
- "deadline_iso" must be in the future relative to "today".`;

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
    return obj;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Parser error: ${msg}` };
  }
}
