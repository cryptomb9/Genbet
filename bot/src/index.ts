import { Bot } from "grammy";
import { config } from "./config.js";
import { ensureContractDeployed } from "./deploy.js";
import { registerCommands } from "./handlers/commands.js";
import { registerGroupHandler } from "./handlers/group.js";
import { registerCallbacks } from "./handlers/callbacks.js";

async function main() {
  console.log(`[bot] Starting on network=${config.network}`);
  console.log(`[bot] House fee: ${config.houseFeeBps} bps -> ${config.houseAddress}`);

  let contract: `0x${string}`;
  try {
    contract = await ensureContractDeployed();
    console.log(`[bot] Using BetMarket at ${contract}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n[bot] Could not get a contract address yet:\n${msg}\n`);
    console.error(
      "[bot] The bot will exit. Fund the operator wallet shown above and start me again.",
    );
    process.exit(1);
  }

  const bot = new Bot(config.telegramToken);
  const getContract = () => contract;

  registerCommands(bot, getContract);
  registerCallbacks(bot, getContract);
  registerGroupHandler(bot, getContract);

  bot.catch((err) => {
    console.error("[bot] handler error:", err);
  });

  // Make sure we receive group messages and callback queries.
  await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});

  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());

  await bot.start({
    allowed_updates: ["message", "callback_query", "edited_message"],
    onStart: (info) => {
      console.log(`[bot] @${info.username} listening (long polling).`);
      console.log(
        "[bot] Add me to a group, grant message access, then tag me with a bet!",
      );
    },
  });
}

main().catch((err) => {
  console.error("[bot] fatal:", err);
  process.exit(1);
});
