import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import { getSetting, setSetting } from "./db.js";
import { bm, deployBetMarket, getBalanceWei } from "./genlayer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(__dirname, "../contracts/bet_market.py");

export function loadOperatorKey(): `0x${string}` {
  if (config.operatorPrivateKey) return config.operatorPrivateKey;
  if (fs.existsSync(config.operatorKeyPath)) {
    return fs.readFileSync(config.operatorKeyPath, "utf8").trim() as `0x${string}`;
  }
  const pk = generatePrivateKey();
  fs.writeFileSync(config.operatorKeyPath, pk, { mode: 0o600 });
  console.warn(
    `[deploy] Generated new operator wallet at ${config.operatorKeyPath}. Back it up!`,
  );
  return pk;
}

async function isUsableBetMarket(addr: string): Promise<boolean> {
  if (!addr.startsWith("0x")) return false;
  try {
    await bm.stats(addr as `0x${string}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[deploy] Ignoring unusable cached contract ${addr}: ${msg}`);
    return false;
  }
}

export async function ensureContractDeployed(): Promise<`0x${string}`> {
  // 1. Explicit override wins.
  if (config.betMarketAddress) {
    if (!(await isUsableBetMarket(config.betMarketAddress))) {
      throw new Error(
        `BET_MARKET_ADDRESS is set but is not readable on ${config.network}: ${config.betMarketAddress}`,
      );
    }
    setSetting("contract_address", config.betMarketAddress);
    return config.betMarketAddress;
  }
  // 2. DB cache.
  const cached = getSetting("contract_address");
  if (cached && (await isUsableBetMarket(cached))) {
    return cached as `0x${string}`;
  }
  // 3. Legacy file cache.
  if (fs.existsSync(config.contractAddrPath)) {
    const a = fs.readFileSync(config.contractAddrPath, "utf8").trim();
    if (await isUsableBetMarket(a)) {
      setSetting("contract_address", a);
      return a as `0x${string}`;
    }
  }

  // Need to deploy.
  const operatorPk = loadOperatorKey();
  const operatorAddr = privateKeyToAccount(operatorPk).address;

  const balance = await getBalanceWei(operatorAddr).catch(() => 0n);
  if (balance < 1_000_000_000_000_000n /* 0.001 GEN */) {
    throw new Error(
      [
        "BetMarket contract is not deployed yet and the operator wallet has no balance.",
        `  Operator address: ${operatorAddr}`,
        `  Network:          ${config.network}`,
        "  Fund it from the GenLayer testnet faucet:",
        "    https://testnet-faucet.genlayer.foundation",
        "  Then restart the bot.",
      ].join("\n"),
    );
  }

  console.log(`[deploy] Deploying BetMarket from operator ${operatorAddr}...`);
  const code = fs.readFileSync(CONTRACT_PATH, "utf8");
  const addr = await deployBetMarket(operatorPk, code);
  console.log(`[deploy] BetMarket deployed at ${addr}`);

  setSetting("contract_address", addr);
  fs.writeFileSync(config.contractAddrPath, addr);
  return addr;
}
