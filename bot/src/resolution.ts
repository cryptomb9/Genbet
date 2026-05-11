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

export interface ResolutionPlan {
  resolutionUrl: string;
  label: string;
}

export function planResolution(
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

export function resolutionLabel(resolutionUrl: string): string {
  if (!resolutionUrl) return "";
  if (!resolutionUrl.startsWith("crypto:")) return resolutionUrl;

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
