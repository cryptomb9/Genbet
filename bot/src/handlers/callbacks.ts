import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { db } from "../db.js";
import { getOrCreateUserWallet } from "../wallet.js";
import {
  acceptBetOnchain,
  bm,
  cancelBetOnchain,
  createBetOnchain,
  getBalanceWei,
  requestCancelActiveOnchain,
} from "../genlayer.js";
import {
  deadlineHuman,
  escapeHtml,
  genFromWei,
  renderBet,
  shortHash,
} from "../format.js";
import { resolutionLabel } from "../resolution.js";
import { recordTxWatch } from "../status.js";

interface PendingBet {
  id: string;
  chat_id: number;
  creator_tg_id: number;
  creator_handle: string;
  question: string;
  deadline: number;
  creator_yes: number;
  stake_wei: string;
  resolution_url: string;
  target_tg_id: number | null;
  target_handle: string | null;
  contract_address: string;
  status: string;
  onchain_bet_id: number | null;
  created_at: number;
}

function getPending(id: string): PendingBet | undefined {
  return db
    .prepare("SELECT * FROM pending_bets WHERE id = ?")
    .get(id) as PendingBet | undefined;
}

function setPendingStatus(
  id: string,
  status: string,
  onchainId?: number,
  contractAddress?: `0x${string}`,
) {
  if (onchainId !== undefined && contractAddress) {
    db.prepare(
      "UPDATE pending_bets SET status = ?, onchain_bet_id = ?, contract_address = ? WHERE id = ?",
    ).run(status, onchainId, contractAddress, id);
  } else if (onchainId !== undefined) {
    db.prepare(
      "UPDATE pending_bets SET status = ?, onchain_bet_id = ? WHERE id = ?",
    ).run(status, onchainId, id);
  } else {
    db.prepare("UPDATE pending_bets SET status = ? WHERE id = ?").run(
      status,
      id,
    );
  }
}

const MIN_DEADLINE_BUFFER_SECONDS = 10 * 60;
const ONCHAIN_RETRY_ATTEMPTS = 3;

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
      const delayMs = 1500 * attempt;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function registerCallbacks(
  bot: Bot,
  getContract: () => `0x${string}`,
) {
  bot.callbackQuery(/^confirm:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const pb = getPending(id);
    if (!pb) {
      await ctx.answerCallbackQuery({ text: "Bet expired or not found." });
      return;
    }
    if (pb.status !== "awaiting") {
      await ctx.answerCallbackQuery({ text: `Already ${pb.status}.` });
      return;
    }
    if (ctx.from.id !== pb.creator_tg_id) {
      await ctx.answerCallbackQuery({
        text: "Only the bet's creator can confirm.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Locking your stake on-chain…" });
    const w = getOrCreateUserWallet(
      ctx.from.id,
      ctx.from.username || ctx.from.first_name || pb.creator_handle,
    );
    const stakeWei = BigInt(pb.stake_wei);
    const bal = await getBalanceWei(w.address).catch(() => 0n);
    if (bal < stakeWei) {
      await ctx.editMessageText(
        `❌ Wallet balance dropped below stake. Top up via /deposit and try again.\n\nWallet: <code>${w.address}</code>\nNeed: ${genFromWei(stakeWei)} GEN, have: ${genFromWei(bal)} GEN`,
        { parse_mode: "HTML" },
      );
      setPendingStatus(id, "cancelled");
      return;
    }

    try {
      const minDeadlineUnix =
        Math.floor(Date.now() / 1000) + MIN_DEADLINE_BUFFER_SECONDS;
      if (pb.deadline < minDeadlineUnix) {
        throw new Error(
          "Bet deadline is too close for GenLayer testnet settlement. Create it again with at least 10 minutes before resolution.",
        );
      }
      const { hash, betId } = await createBetOnchain(
        getContract(),
        w.privateKey,
        {
          question: pb.question,
          deadline: pb.deadline,
          creatorYes: pb.creator_yes === 1,
          resolutionUrl: pb.resolution_url,
          chatId: String(pb.chat_id),
          creatorHandle: pb.creator_handle,
          stakeWei,
        },
      );
      setPendingStatus(id, "open", betId, getContract());
      recordTxWatch({
        txHash: hash,
        contract: getContract(),
        betId,
        chatId: ctx.chat!.id,
        kind: "create_bet",
      });

      const yesSide = pb.creator_yes === 1 ? "YES" : "NO";
      const noSide = pb.creator_yes === 1 ? "NO" : "YES";
      const card = [
        `<b>🎲 Bet #${betId} — open</b>`,
        `📌 ${escapeHtml(pb.question)}`,
        ``,
        `<b>@${escapeHtml(pb.creator_handle)}</b> on <b>${yesSide}</b>, ${genFromWei(stakeWei)} GEN locked`,
        pb.target_handle
          ? `🎯 Looking for <b>@${escapeHtml(pb.target_handle)}</b> (or anyone) on <b>${noSide}</b>`
          : `Open — anyone can take <b>${noSide}</b>`,
        `⏰ Deadline: ${deadlineHuman(pb.deadline)}`,
        pb.resolution_url
          ? `Source: ${escapeHtml(resolutionLabel(pb.resolution_url))}`
          : "",
        `tx: <code>${shortHash(hash)}</code>`,
      ].filter(Boolean).join("\n");

      const kb = new InlineKeyboard()
        .text(`Take ${noSide} — stake ${genFromWei(stakeWei)} GEN`, `accept:${id}`)
        .row()
        .text("Cancel & refund", `cancel:${id}`);

      await ctx.editMessageText(card, {
        parse_mode: "HTML",
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const concise = msg.length > 800 ? `${msg.slice(0, 800)}...` : msg;
      await ctx.editMessageText(
        `❌ On-chain create_bet failed:\n<code>${escapeHtml(concise)}</code>`,
        { parse_mode: "HTML" },
      );
      setPendingStatus(id, "cancelled");
    }
  });

  bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const pb = getPending(id);
    if (!pb) {
      await ctx.answerCallbackQuery({ text: "Not found." });
      return;
    }
    if (ctx.from.id !== pb.creator_tg_id) {
      await ctx.answerCallbackQuery({
        text: "Only the creator can cancel.",
        show_alert: true,
      });
      return;
    }
    if (pb.status === "awaiting") {
      setPendingStatus(id, "cancelled");
      await ctx.answerCallbackQuery({ text: "Cancelled." });
      await ctx.editMessageText("❌ Bet cancelled before staking.");
      return;
    }
    if (pb.status === "open" && pb.onchain_bet_id) {
      // Cancel on-chain (refunds creator)
      await ctx.answerCallbackQuery({ text: "Cancelling on-chain…" });
      const w = getOrCreateUserWallet(ctx.from.id, ctx.from.username || null);
      try {
        const hash = await cancelBetOnchain(
          getContract(),
          w.privateKey,
          pb.onchain_bet_id,
        );
        recordTxWatch({
          txHash: hash,
          contract: getContract(),
          betId: pb.onchain_bet_id,
          chatId: ctx.chat!.id,
          kind: "cancel_bet",
        });
        setPendingStatus(id, "cancelled");
        await ctx.editMessageText(
          `❌ Bet #${pb.onchain_bet_id} cancelled. Refund queued until finality. tx: <code>${shortHash(hash)}</code>`,
          { parse_mode: "HTML" },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`Cancel failed: ${escapeHtml(msg)}`, {
          parse_mode: "HTML",
        });
      }
      return;
    }
    await ctx.answerCallbackQuery({ text: `Cannot cancel (${pb.status}).` });
  });

  bot.callbackQuery(/^refund:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const pb = getPending(id);
    if (!pb || !pb.onchain_bet_id) {
      await ctx.answerCallbackQuery({ text: "Bet not found." });
      return;
    }
    if (pb.status !== "active") {
      await ctx.answerCallbackQuery({ text: `Bet is ${pb.status}.` });
      return;
    }

    const handle =
      ctx.from.username || ctx.from.first_name || `user_${ctx.from.id}`;
    const w = getOrCreateUserWallet(ctx.from.id, handle);
    const bet = await bm.getBet(getContract(), pb.onchain_bet_id);
    const addr = w.address.toLowerCase();
    if (
      !bet ||
      (bet.creator.toLowerCase() !== addr && bet.accepter.toLowerCase() !== addr)
    ) {
      await ctx.answerCallbackQuery({
        text: "Only one of the two bettors can request this refund.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Sending refund request on-chain..." });
    try {
      const hash = await retryOnchain("request_cancel_active", () =>
        requestCancelActiveOnchain(getContract(), w.privateKey, pb.onchain_bet_id!),
      );
      recordTxWatch({
        txHash: hash,
        contract: getContract(),
        betId: pb.onchain_bet_id,
        chatId: ctx.chat!.id,
        kind: "request_cancel_active",
      });
      const updated = await bm.getBet(getContract(), pb.onchain_bet_id);
      if (updated?.status === "cancelled") {
        setPendingStatus(id, "cancelled");
        await ctx.reply(
          `Refund accepted by both sides. Bet #${pb.onchain_bet_id} cancelled. tx: <code>${shortHash(hash)}</code>`,
          { parse_mode: "HTML" },
        );
        return;
      }
      await ctx.reply(
        `Refund requested for bet #${pb.onchain_bet_id}. The other bettor must also request refund. tx: <code>${shortHash(hash)}</code>`,
        { parse_mode: "HTML" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Refund request failed: ${escapeHtml(msg)}`, {
        parse_mode: "HTML",
      });
    }
  });

  bot.callbackQuery(/^accept:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const pb = getPending(id);
    if (!pb) {
      await ctx.answerCallbackQuery({ text: "Not found." });
      return;
    }
    if (pb.status !== "open" || !pb.onchain_bet_id) {
      await ctx.answerCallbackQuery({ text: `Bet is ${pb.status}.` });
      return;
    }
    if (ctx.from.id === pb.creator_tg_id) {
      await ctx.answerCallbackQuery({
        text: "You can't accept your own bet.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Matching stake on-chain…" });
    const handle =
      ctx.from.username || ctx.from.first_name || `user_${ctx.from.id}`;
    const w = getOrCreateUserWallet(ctx.from.id, handle);
    const stakeWei = BigInt(pb.stake_wei);
    const bal = await getBalanceWei(w.address).catch(() => 0n);
    if (bal < stakeWei) {
      await ctx.reply(
        `<b>@${escapeHtml(handle)}</b> — not enough GEN to take this bet.\nWallet: <code>${w.address}</code>\nNeed ${genFromWei(stakeWei)} GEN, have ${genFromWei(bal)} GEN.\nFund via /deposit.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    try {
      const hash = await retryOnchain("accept_bet", () =>
        acceptBetOnchain(
          getContract(),
          w.privateKey,
          pb.onchain_bet_id!,
          handle,
          stakeWei,
        ),
      );
      recordTxWatch({
        txHash: hash,
        contract: getContract(),
        betId: pb.onchain_bet_id,
        chatId: ctx.chat!.id,
        kind: "accept_bet",
      });
      setPendingStatus(id, "active");
      const updated = await bm.getBet(getContract(), pb.onchain_bet_id);
      const body = updated
        ? renderBet({ ...updated, status: "active" })
        : `Bet #${pb.onchain_bet_id} is now active.`;
      await ctx.editMessageText(
        `🤝 <b>@${escapeHtml(handle)}</b> took the other side! tx: <code>${shortHash(hash)}</code>\n\n${body}`,
        { parse_mode: "HTML" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Accept failed: ${escapeHtml(msg)}`, {
        parse_mode: "HTML",
      });
    }
  });
}
