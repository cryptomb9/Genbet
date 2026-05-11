import { Bot } from "grammy";
import { run } from "@grammyjs/runner";
import { config } from "./config.js";
import { ensureContractDeployed } from "./deploy.js";
import { registerCommands } from "./handlers/commands.js";
import { registerGroupHandler } from "./handlers/group.js";
import { registerCallbacks } from "./handlers/callbacks.js";
import { startTxStatusWatcher } from "./status.js";

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
  startTxStatusWatcher(bot);

  bot.catch((err) => {
    console.error("[bot] handler error:", err);
  });

  // Make sure we receive group messages and callback queries.
  await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});

  await bot.init();
  const info = bot.botInfo;
  console.log(`[bot] @${info.username} listening (concurrent long polling).`);
  console.log(
    "[bot] Add me to a group, grant message access, then tag me with a bet!",
  );

  const runner = run(bot, {
    runner: {
      fetch: {
        allowed_updates: ["message", "callback_query", "edited_message"],
      },
    },
    sink: {
      concurrency: 20,
    },
  });

  process.once("SIGINT", () => void runner.stop());
  process.once("SIGTERM", () => void runner.stop());

  await runner.task();
}

main().catch((err) => {
  console.error("[bot] fatal:", err);
  process.exit(1);
});
