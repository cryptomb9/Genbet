// Manual one-shot deploy. Useful if you want to deploy from CI or from your laptop
// instead of letting the bot auto-deploy on first run.
import { ensureContractDeployed, loadOperatorKey } from "../deploy.js";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";

async function main() {
  const op = loadOperatorKey();
  console.log(`Operator: ${privateKeyToAccount(op).address}`);
  console.log(`Network:  ${config.network}`);
  const addr = await ensureContractDeployed();
  console.log(`\n✅ BetMarket address: ${addr}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
