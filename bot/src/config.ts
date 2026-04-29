import "dotenv/config";
import path from "node:path";
import fs from "node:fs";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  houseAddress: required("HOUSE_FEE_ADDRESS") as `0x${string}`,
  houseFeeBps: Number(process.env.HOUSE_FEE_BPS || "1000"),
  network: (process.env.GENLAYER_NETWORK || "testnet-asimov") as
    | "testnet-asimov"
    | "testnet-bradbury"
    | "localnet",
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, "bot.sqlite"),
  contractAddrPath: path.join(DATA_DIR, ".contract_address"),
  operatorKeyPath: path.join(DATA_DIR, ".operator_key"),
  sessionKeyPath: path.join(DATA_DIR, ".session_key"),
  // Optional overrides
  betMarketAddress: process.env.BET_MARKET_ADDRESS as
    | `0x${string}`
    | undefined,
  operatorPrivateKey: process.env.OPERATOR_PRIVATE_KEY as
    | `0x${string}`
    | undefined,
  sessionSecret: process.env.SESSION_SECRET || "",
  // OpenAI (Replit AI Integrations proxy or your own)
  openaiBaseUrl:
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||
    "https://api.openai.com/v1",
  openaiApiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || "",
} as const;
