import type { Bot, Context } from "grammy";
import { isAddress } from "viem";
import { config } from "../config.js";
import { db } from "../db.js";
import { getOrCreateUserWallet, importUserWallet } from "../wallet.js";
import {
  bm,
  cancelBetOnchain,
  estimateNativeTransferFeeWei,
  getBalanceWei,
  requestCancelActiveOnchain,
  resolveBetOnchain,
  transferGen,
} from "../genlayer.js";
import {
  escapeHtml,
  genFromWei,
  genToWei,
  renderBet,
  shortAddr,
  shortHash,
} from "../format.js";
import { recordTxWatch, renderStatusReport } from "../status.js";
import { acquireLock } from "../locks.js";

const FAUCET_URL = "https://testnet-faucet.genlayer.foundation";
const ONCHAIN_RETRY_ATTEMPTS = 3;
const DEFAULT_WITHDRAW_GAS_RESERVE_WEI = 21000n * 1_000_000_000n * 2n;

async function retryOnchain<T>(
  opName: string,
  run: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ONCHAIN_RETRY_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[retry] ${opName} attempt ${attempt}/${ONCHAIN_RETRY_ATTEMPTS} failed: ${msg}`,
      );
      if (attempt === ONCHAIN_RETRY_ATTEMPTS) break;
      const delayMs = 2000 * attempt;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function ensureUser(ctx: Context) {
  const u = ctx.from;
  if (!u) throw new Error("No sender");
  return getOrCreateUserWallet(u.id, u.username || u.first_name || null);
}

function isLiveBet(status: string): boolean {
  return status === "open" || status === "active";
}

function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

async function requirePrivateChat(ctx: Context, command: string): Promise<boolean> {
  if (isPrivateChat(ctx)) return true;
  await ctx.reply(
    `For wallet safety, use /${command} only in my private DM, not in a group.`,
  );
  return false;
}

export function registerCommands(bot: Bot, getContract: () => `0x${string}`) {
  bot.command("start", async (ctx) => {
    const w = ensureUser(ctx);
    await ctx.reply(
      [
        "<b>Welcome to Genbet</b>",
        "",
        "I run AI-resolved peer-to-peer bets on the GenLayer testnet.",
        "",
        `Your wallet: <code>${w.address}</code>`,
        `Network: <b>${config.network}</b>`,
        `Contract: <code>${getContract()}</code>`,
        "",
        "<b>How to bet</b>",
        "In a group, tag me with a challenge:",
        `  <i>"@${ctx.me.username} I bet 5 GEN the Lakers beat the Bulls Thursday - anyone?"</i>`,
        "I'll post a confirm card. Once you stake, anyone can take the other side.",
        "",
        "<b>Commands</b>",
        "/wallet - show your address &amp; balance",
        "/deposit - how to fund your wallet",
        "/withdraw &lt;address&gt; &lt;amount|all&gt; - move GEN out of your bot wallet",
        "/exportwallet - show your private key in DM",
        "/importwallet &lt;private_key&gt; CONFIRM - restore a wallet in DM",
        "/mybets - your open/active bets in this chat",
        "/mybetsall - your full bet history across all chats",
        "/openbets - list bets waiting for an opponent",
        "/leaderboard - top earners",
        "/refund &lt;id&gt; - cancel open bet or request mutual refund",
        "/resolve &lt;id&gt; - settle a bet whose deadline has passed",
        "/status &lt;id&gt; - show bet and transaction finality status",
        "/contract - show the deployed contract address",
        "/help - show this message",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "<b>Commands</b>",
        "/wallet, /deposit, /withdraw &lt;address&gt; &lt;amount|all&gt;, /exportwallet, /importwallet &lt;private_key&gt; CONFIRM, /mybets, /mybetsall, /openbets, /leaderboard, /refund &lt;id&gt;, /resolve &lt;id&gt;, /status &lt;id&gt;, /contract",
        "",
        "<b>Placing a bet (in groups)</b>",
        `Tag me with a YES/NO claim and a stake, e.g.\n@${ctx.me.username} 5 GEN the Lakers beat the Bulls tonight`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("wallet", async (ctx) => {
    const w = ensureUser(ctx);
    let balText = "(unable to read balance)";
    try {
      const bal = await getBalanceWei(w.address);
      balText = `${genFromWei(bal)} GEN`;
    } catch {
      // ignore
    }
    await ctx.reply(
      [
        "<b>Your wallet</b>",
        `<code>${w.address}</code>`,
        `Balance: <b>${balText}</b>`,
        "",
        `Network: ${config.network}`,
        `Fund from the faucet: ${FAUCET_URL}`,
      ].join("\n"),
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  });

  bot.command("deposit", async (ctx) => {
    const w = ensureUser(ctx);
    await ctx.reply(
      [
        "<b>Deposit GEN</b>",
        `Send GEN on <b>${config.network}</b> to:`,
        `<code>${w.address}</code>`,
        "",
        "Need testnet GEN? Use the faucet:",
        FAUCET_URL,
      ].join("\n"),
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  });

  bot.command("exportwallet", async (ctx) => {
    if (!(await requirePrivateChat(ctx, "exportwallet"))) return;
    const w = ensureUser(ctx);
    await ctx.reply(
      [
        "<b>Your Genbet wallet backup</b>",
        "",
        `Address: <code>${w.address}</code>`,
        `Private key: <code>${w.privateKey}</code>`,
        "",
        "Keep this private. Anyone with this key can spend the wallet balance.",
        "There is no seed phrase for this bot wallet; this private key is the backup.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("importwallet", async (ctx) => {
    if (!(await requirePrivateChat(ctx, "importwallet"))) return;
    const arg = (ctx.match as string | undefined)?.trim();
    const parts = arg ? arg.split(/\s+/) : [];
    const privateKey = parts[0] || "";
    const confirmed = parts[1]?.toUpperCase() === "CONFIRM";
    if (!privateKey) {
      await ctx.reply("Usage: /importwallet <private_key> CONFIRM");
      return;
    }
    if (!confirmed) {
      await ctx.reply(
        [
          "This will replace the wallet Genbet uses for your Telegram account.",
          "Bets and funds attached to the old wallet will not move automatically.",
          "",
          "Run again as:",
          "<code>/importwallet &lt;private_key&gt; CONFIRM</code>",
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }

    try {
      const username = ctx.from?.username || ctx.from?.first_name || null;
      const w = importUserWallet(ctx.from!.id, username, privateKey);
      const bal = await getBalanceWei(w.address).catch(() => null);
      await ctx.reply(
        [
          "<b>Wallet imported</b>",
          `<code>${w.address}</code>`,
          bal === null ? "" : `Balance: <b>${genFromWei(bal)} GEN</b>`,
        ].filter(Boolean).join("\n"),
        { parse_mode: "HTML" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Import failed: ${escapeHtml(msg)}`, {
        parse_mode: "HTML",
      });
    }
  });

  bot.command("withdraw", async (ctx) => {
    if (!(await requirePrivateChat(ctx, "withdraw"))) return;
    const w = ensureUser(ctx);
    const arg = (ctx.match as string | undefined)?.trim();
    const parts = arg ? arg.split(/\s+/) : [];
    const to = parts[0] as `0x${string}` | undefined;
    const amountText = parts[1];

    if (!to || !amountText || !isAddress(to)) {
      await ctx.reply("Usage: /withdraw <0x_address> <amount|all>");
      return;
    }

    const balance = await getBalanceWei(w.address);
    const gasReserve =
      (await estimateNativeTransferFeeWei().catch(() => DEFAULT_WITHDRAW_GAS_RESERVE_WEI)) * 2n;
    let amountWei: bigint;

    try {
      if (amountText.toLowerCase() === "all") {
        if (balance <= gasReserve) {
          await ctx.reply(
            `Balance is too low to withdraw after gas reserve. Balance: ${genFromWei(balance)} GEN`,
          );
          return;
        }
        amountWei = balance - gasReserve;
      } else {
        amountWei = genToWei(amountText);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Invalid amount: ${escapeHtml(msg)}`, {
        parse_mode: "HTML",
      });
      return;
    }

    if (amountWei <= 0n) {
      await ctx.reply("Withdraw amount must be greater than 0.");
      return;
    }
    if (amountWei + gasReserve > balance) {
      await ctx.reply(
        [
          "Not enough free balance for that withdrawal plus gas.",
          `Balance: <b>${genFromWei(balance)} GEN</b>`,
          `Requested: <b>${genFromWei(amountWei)} GEN</b>`,
          `Estimated gas reserve: <b>${genFromWei(gasReserve)} GEN</b>`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }

    await ctx.reply(`Submitting withdrawal of ${genFromWei(amountWei)} GEN...`);
    try {
      const hash = await transferGen(w.privateKey, to, amountWei);
      await ctx.reply(
        [
          "<b>Withdrawal submitted</b>",
          `Amount: <b>${genFromWei(amountWei)} GEN</b>`,
          `To: <code>${to}</code>`,
          `tx: <code>${shortHash(hash)}</code>`,
          "",
          "If this wallet already has a queued transaction, this transfer may queue behind it.",
        ].join("\n"),
        { parse_mode: "HTML" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Withdraw failed: ${escapeHtml(msg)}`, {
        parse_mode: "HTML",
      });
    }
  });

  bot.command("contract", async (ctx) => {
    await ctx.reply(
      `<b>BetMarket contract</b>\n<code>${getContract()}</code>\nNetwork: ${config.network}`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("mybets", async (ctx) => {
    const w = ensureUser(ctx);
    const bets = await bm.myBets(getContract(), w.address, 20);
    const inGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
    const scoped = inGroup
      ? bets.filter((b) => String(b.chat_id) === String(ctx.chat.id))
      : bets;
    const visible = scoped.filter((b) => isLiveBet(b.status));

    if (visible.length === 0) {
      await ctx.reply(
        inGroup
          ? "You have no open or active bets in this group."
          : "You have no open or active bets.",
      );
      return;
    }
    await ctx.reply(visible.map(renderBet).join("\n\n"), { parse_mode: "HTML" });
  });

  bot.command("mybetsall", async (ctx) => {
    const w = ensureUser(ctx);
    const bets = await bm.myBets(getContract(), w.address, 10);
    if (bets.length === 0) {
      await ctx.reply("You have no bets yet. Tag me in a group to start one.");
      return;
    }
    await ctx.reply(bets.map(renderBet).join("\n\n"), { parse_mode: "HTML" });
  });

  bot.command("openbets", async (ctx) => {
    const bets = await bm.listBets(getContract(), "open", 10);
    if (bets.length === 0) {
      await ctx.reply("No open bets right now.");
      return;
    }
    await ctx.reply(bets.map(renderBet).join("\n\n"), { parse_mode: "HTML" });
  });

  bot.command("leaderboard", async (ctx) => {
    const rows = await bm.leaderboard(getContract(), 10);
    if (rows.length === 0) {
      await ctx.reply("No resolved bets yet.");
      return;
    }
    const lines = ["<b>Leaderboard</b>"];
    rows.forEach((r, i) => {
      const name = r.handle ? `@${escapeHtml(r.handle)}` : shortAddr(r.address);
      lines.push(
        `${i + 1}. ${name} - <b>+${genFromWei(r.profit_wei)} GEN</b> (${r.wins}W / ${r.losses}L)`,
      );
    });
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("refund", async (ctx) => {
    const w = ensureUser(ctx);
    const arg = (ctx.match as string | undefined)?.trim();
    const id = arg ? Number(arg) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      await ctx.reply("Usage: /refund <bet_id>");
      return;
    }

    const bet = await bm.getBet(getContract(), id);
    if (!bet) {
      await ctx.reply(`Bet #${id} not found.`);
      return;
    }

    const userAddr = w.address.toLowerCase();
    const isCreator = bet.creator.toLowerCase() === userAddr;
    const isAccepter = bet.accepter.toLowerCase() === userAddr;

    if (bet.status === "open") {
      if (!isCreator) {
        await ctx.reply("Only the bet creator can cancel an open bet.");
        return;
      }
      const release = acquireLock(`cancel:${getContract()}:${id}`);
      if (!release) {
        await ctx.reply(`Bet #${id} is already being cancelled.`);
        return;
      }
      await ctx.reply(`Cancelling open bet #${id}... refund will arrive after GenLayer finality.`);
      try {
        const hash = await retryOnchain("cancel_bet", () =>
          cancelBetOnchain(getContract(), w.privateKey, id),
        );
        recordTxWatch({
          txHash: hash,
          contract: getContract(),
          betId: id,
          chatId: ctx.chat.id,
          kind: "cancel_bet",
        });
        db.prepare(
          `UPDATE pending_bets
             SET status = 'cancelled', contract_address = ?
           WHERE onchain_bet_id = ?
             AND (contract_address = ? OR contract_address = '')`,
        ).run(getContract(), id, getContract());
        await ctx.reply(
          `Bet #${id} cancelled. Refund queued until finality. tx: <code>${shortHash(hash)}</code>`,
          { parse_mode: "HTML" },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Cancel failed: ${escapeHtml(msg)}`, {
          parse_mode: "HTML",
        });
      } finally {
        release();
      }
      return;
    }

    if (bet.status !== "active") {
      await ctx.reply(`Bet #${id} cannot be refunded now (status: ${bet.status}).`);
      return;
    }
    if (!isCreator && !isAccepter) {
      await ctx.reply("Only one of the two bettors can request this refund.");
      return;
    }

    const release = acquireLock(`refund:${getContract()}:${id}:${ctx.from?.id ?? w.address}`);
    if (!release) {
      await ctx.reply(`Your refund request for bet #${id} is already being processed.`);
      return;
    }
    await ctx.reply(
      `Requesting mutual refund for bet #${id}... the other bettor must also run /refund ${id}.`,
    );
    try {
      const hash = await retryOnchain("request_cancel_active", () =>
        requestCancelActiveOnchain(getContract(), w.privateKey, id),
      );
      recordTxWatch({
        txHash: hash,
        contract: getContract(),
        betId: id,
        chatId: ctx.chat.id,
        kind: "request_cancel_active",
      });
      const updated = await bm.getBet(getContract(), id);
      if (updated?.status === "cancelled") {
        db.prepare(
          `UPDATE pending_bets
             SET status = 'cancelled', contract_address = ?
           WHERE onchain_bet_id = ?
             AND (contract_address = ? OR contract_address = '')`,
        ).run(getContract(), id, getContract());
        await ctx.reply(
          `Both sides agreed. Bet #${id} cancelled. Refunds queued until finality. tx: <code>${shortHash(hash)}</code>`,
          { parse_mode: "HTML" },
        );
        return;
      }
      const tail = updated ? `\n\n${renderBet(updated)}` : "";
      await ctx.reply(`Refund request recorded. tx: <code>${shortHash(hash)}</code>${tail}`, {
        parse_mode: "HTML",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Refund request failed: ${escapeHtml(msg)}`, {
        parse_mode: "HTML",
      });
    } finally {
      release();
    }
  });

  bot.command("resolve", async (ctx) => {
    const w = ensureUser(ctx);
    const arg = (ctx.match as string | undefined)?.trim();
    const id = arg ? Number(arg) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      await ctx.reply("Usage: /resolve <bet_id>");
      return;
    }
    const bet = await bm.getBet(getContract(), id);
    if (!bet) {
      await ctx.reply(`Bet #${id} not found.`);
      return;
    }
    if (bet.status !== "active") {
      await ctx.reply(`Bet #${id} is not active (status: ${bet.status}).`);
      return;
    }
    if (bet.deadline > Math.floor(Date.now() / 1000)) {
      await ctx.reply(
        `Bet #${id} deadline hasn't passed yet (deadline: ${new Date(
          bet.deadline * 1000,
        ).toISOString()}).`,
      );
      return;
    }
    const release = acquireLock(`resolve:${getContract()}:${id}`);
    if (!release) {
      await ctx.reply(`Bet #${id} is already being resolved.`);
      return;
    }
    await ctx.reply(`Resolving bet #${id}... this may take 1-2 minutes.`);
    try {
      const hash = await retryOnchain("resolve", () =>
        resolveBetOnchain(getContract(), w.privateKey, id),
      );
      recordTxWatch({
        txHash: hash,
        contract: getContract(),
        betId: id,
        chatId: ctx.chat.id,
        kind: "resolve",
      });
      const updated = await bm.getBet(getContract(), id);
      if (updated?.status === "resolved") {
        db.prepare(
          `UPDATE pending_bets
             SET status = 'resolved', contract_address = ?
           WHERE onchain_bet_id = ?
             AND question = ?
             AND deadline = ?
             AND stake_wei = ?
             AND (contract_address = ? OR contract_address = '')`,
        ).run(
          getContract(),
          id,
          updated.question,
          updated.deadline,
          updated.stake,
          getContract(),
        );
      }
      const tail = updated ? `\n\n${renderBet(updated)}` : "";
      await ctx.reply(`Resolved. tx: <code>${shortHash(hash)}</code>${tail}`, {
        parse_mode: "HTML",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Resolve failed: ${escapeHtml(msg)}`);
    } finally {
      release();
    }
  });

  bot.command("status", async (ctx) => {
    const arg = (ctx.match as string | undefined)?.trim();
    const id = arg ? Number(arg) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      await ctx.reply("Usage: /status <bet_id>");
      return;
    }
    try {
      await ctx.reply(await renderStatusReport(getContract(), id), {
        parse_mode: "HTML",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Status check failed: ${escapeHtml(msg)}`, {
        parse_mode: "HTML",
      });
    }
  });
}
