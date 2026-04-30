import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount } from "genlayer-js";
import { testnetAsimov } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { config } from "../config.js";
import { loadOperatorKey } from "../deploy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(__dirname, "../../contracts/bet_market.py");

async function main() {
  const pk = loadOperatorKey();
  const account = createAccount(pk);
  const client = createClient({ chain: testnetAsimov, account });
  console.log("operator:", account.address);
  const code = fs.readFileSync(CONTRACT_PATH, "utf8");

  console.log("submitting deploy...");
  const hash = await client.deployContract({
    code,
    args: [config.houseAddress, config.houseFeeBps],
    leaderOnly: false,
  });
  console.log("hash:", hash);

  console.log("polling receipt...");
  const receipt = (await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.ACCEPTED,
    retries: 120,
    interval: 4000,
    fullTransaction: true,
  })) as Record<string, unknown>;
  console.log("--- RECEIPT KEYS ---");
  console.log(Object.keys(receipt));
  console.log("--- RECIPIENT ---", receipt.recipient);
  console.log("--- txDataDecoded ---", JSON.stringify(receipt.txDataDecoded, null, 2));
  console.log("--- statusName ---", receipt.statusName ?? receipt.status_name);
  console.log("--- status ---", receipt.status);
  console.log("--- FULL (truncated) ---");
  const s = JSON.stringify(receipt, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  console.log(s.length > 6000 ? s.slice(0, 6000) + "\n…[truncated]" : s);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
