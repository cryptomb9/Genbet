import type { ParsedBet } from "./parser.js";

const PRODUCTS: Record<string, string> = {
  BTC: "BTC-USD",
  BITCOIN: "BTC-USD",
  ETH: "ETH-USD",
  ETHEREUM: "ETH-USD",
  SOL: "SOL-USD",
  SOLANA: "SOL-USD",
  XRP: "XRP-USD",
  ADA: "ADA-USD",
  DOGE: "DOGE-USD",
  DOGECOIN: "DOGE-USD",
  AVAX: "AVAX-USD",
  LINK: "LINK-USD",
  LTC: "LTC-USD",
};

const CRYPTO_SYMBOL_RE =
  /\b(BTC|BITCOIN|ETH|ETHEREUM|SOL|SOLANA|XRP|ADA|DOGE|DOGECOIN|AVAX|LINK|LTC|MON|MONAD)\b/i;

const PRICE_TRIGGER_RE =
  /\b(touch(?:es)?|hit(?:s)?|reach(?:es)?|cross(?:es)?|break(?:s)?|above|over|below|under|drop(?:s)?\s+to|fall(?:s)?\s+to)\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)/i;

const SPORTS_RE =
  /\b(match|game|fixture|vs\.?|versus|beat(?:s)?|defeat(?:s)?|draw|extra time|penalties|nba|nfl|mlb|nhl|epl|premier league|champions league|world cup|chelsea|arsenal|lakers|bulls)\b/i;

const NEWS_RE =
  /\b(election|government|president|minister|military|strike|bomb|attack|war|ceasefire|strait|hormuz|iran|israel|russia|ukraine|senate|court|officially confirm|announce)\b/i;

export interface ResolutionPlan {
  resolutionUrl: string;
  label: string;
}

function enc(value: string): string {
  return encodeURIComponent(value.trim());
}

function dec(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function categoryOf(parsed: ParsedBet): string {
  return clean(parsed.category).toLowerCase();
}

function inferSportsSelection(question: string): string {
  const patterns = [
    /\bwill\s+(.+?)\s+(?:beat|defeat|win against|win over)\b/i,
    /\b(.+?)\s+(?:beat|defeat|beats|defeats)\s+.+/i,
    /\b(.+?)\s+(?:to win|wins)\b/i,
  ];
  for (const re of patterns) {
    const m = question.match(re);
    const candidate = m?.[1]?.trim();
    if (candidate && candidate.length <= 80) {
      return candidate.replace(/^the\s+/i, "");
    }
  }
  return "";
}

function planCryptoResolution(
  question: string,
  startUnix: number,
  deadlineUnix: number,
): ResolutionPlan | { error: string } | null {
  const symbolMatch = question.match(CRYPTO_SYMBOL_RE);
  if (!symbolMatch) return null;

  const rawSymbol = symbolMatch[1].toUpperCase();
  const product = PRODUCTS[rawSymbol];
  if (!product) {
    return {
      error:
        "That crypto pair is not supported yet. Supported price bets: BTC, ETH, SOL, XRP, ADA, DOGE, AVAX, LINK, LTC.",
    };
  }

  const priceMatch = question.match(PRICE_TRIGGER_RE);
  if (!priceMatch) {
    return {
      error:
        "Crypto bets must use a clear price trigger like 'BTC touches 80500' or 'ETH goes below 3000'.",
    };
  }

  const trigger = priceMatch[1].toLowerCase();
  const priceText = priceMatch[2].replace(/,/g, "");
  const target = Number(priceText);
  if (!Number.isFinite(target) || target <= 0) {
    return { error: "Crypto price target looked invalid." };
  }

  const comparator =
    trigger.includes("below") ||
    trigger.includes("under") ||
    trigger.includes("drop") ||
    trigger.includes("fall")
      ? "LTE"
      : "GTE";

  const direction = comparator === "GTE" ? "touches or goes above" : "touches or goes below";
  return {
    resolutionUrl: [
      "crypto",
      "coinbase",
      product,
      comparator,
      String(target),
      String(startUnix),
      String(deadlineUnix),
    ].join(":"),
    label: `Coinbase ${product} 1m candles: ${direction} ${target}`,
  };
}

function planSportsResolution(
  parsed: ParsedBet,
  question: string,
  deadlineUnix: number,
): ResolutionPlan | { error: string } {
  const selection = clean(parsed.selection) || inferSportsSelection(question);
  const eventName = clean(parsed.event_name) || question;
  const market = clean(parsed.market) || "match_winner";
  const sport = clean(parsed.sport) || "sport";
  const league = clean(parsed.league);
  const rule =
    clean(parsed.settlement_rule) ||
    "Resolve only when the event source says the match is final. Draw counts as NO unless the selected outcome is draw.";
  const sourceHint = clean(parsed.source_hint) || clean(parsed.resolution_url);

  if (!selection) {
    return {
      error:
        "I can handle sports bets, but I need the picked team/player clearly stated. Try: '1 GEN Chelsea beat Arsenal tonight'.",
    };
  }
  if (!eventName || eventName.length < 4) {
    return {
      error:
        "I could not identify the sports event clearly enough. Include both teams/players and the date or competition.",
    };
  }

  const eventLabel = [league, eventName].filter(Boolean).join(" - ");
  return {
    resolutionUrl: [
      "sports",
      "web",
      "v1",
      String(deadlineUnix),
      enc(market),
      enc(selection),
      enc(`${sport}: ${eventLabel || eventName}`),
      enc(rule),
      enc(sourceHint),
    ].join(":"),
    label: `Sports result: ${eventLabel || eventName}; pick ${selection}`,
  };
}

function planNewsResolution(
  parsed: ParsedBet,
  question: string,
  deadlineUnix: number,
): ResolutionPlan {
  const rule =
    clean(parsed.settlement_rule) ||
    "Resolve from reputable news or official sources after the claim deadline. If reliable sources contradict each other, return UNCLEAR.";
  const sourceHint = clean(parsed.source_hint) || clean(parsed.resolution_url);
  return {
    resolutionUrl: [
      "news",
      "web",
      "v1",
      String(deadlineUnix),
      enc(question),
      enc(rule),
      enc(sourceHint),
    ].join(":"),
    label: `News resolver: ${question}`,
  };
}

export function planResolution(
  parsedOrQuestion: ParsedBet | string,
  startUnix: number,
  deadlineUnix: number,
): ResolutionPlan | { error: string } | null {
  const parsed =
    typeof parsedOrQuestion === "string"
      ? ({ ok: true, question: parsedOrQuestion } as ParsedBet)
      : parsedOrQuestion;
  const question = clean(parsed.question);
  if (!question) return null;

  const cryptoPlan = planCryptoResolution(question, startUnix, deadlineUnix);
  if (cryptoPlan) return cryptoPlan;

  const category = categoryOf(parsed);
  if (category === "sports" || SPORTS_RE.test(question) || clean(parsed.sport)) {
    return planSportsResolution(parsed, question, deadlineUnix);
  }

  if (category === "news" || NEWS_RE.test(question)) {
    return planNewsResolution(parsed, question, deadlineUnix);
  }

  return null;
}

export function resolutionLabel(resolutionUrl: string): string {
  if (!resolutionUrl) return "";

  if (resolutionUrl.startsWith("crypto:")) {
    const parts = resolutionUrl.split(":");
    if (parts.length !== 7 || parts[1] !== "coinbase") {
      return "Crypto price resolver";
    }
    const product = parts[2];
    const comparator = parts[3];
    const target = parts[4];
    const direction = comparator === "LTE" ? "touches or goes below" : "touches or goes above";
    return `Coinbase ${product} 1m candles: ${direction} ${target}`;
  }

  if (resolutionUrl.startsWith("sports:")) {
    const parts = resolutionUrl.split(":");
    if (parts.length < 9) return "Sports result resolver";
    const selection = dec(parts[5]);
    const eventName = dec(parts[6]);
    return `Sports result: ${eventName}; pick ${selection}`;
  }

  if (resolutionUrl.startsWith("news:")) {
    const parts = resolutionUrl.split(":");
    if (parts.length < 7) return "News resolver";
    const claim = dec(parts[4]);
    return `News resolver: ${claim.length > 110 ? `${claim.slice(0, 107)}...` : claim}`;
  }

  return resolutionUrl;
}
