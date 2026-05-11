import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import crypto from "node:crypto";
import { db } from "../db.js";
import { getOrCreateUserWallet } from "../wallet.js";
import { parseBetFromText } from "../parser.js";
import {
  createBetOnchain,
  getBalanceWei,
} from "../genlayer.js";
import {
  deadlineHuman,
  escapeHtml,
  genFromWei,
  genToWei,
} from "../format.js";
import { planResolution, resolutionLabel } from "../resolution.js";

function shortId(): string {
  return crypto.randomBytes(4).toString("hex");
}

const MIN_DEADLINE_BUFFER_SECONDS = 10 * 60;

function botMentioned(ctx: Context): boolean {
  const text = ctx.message?.text || ctx.message?.caption;
  if (!text) return false;
  const me = ctx.me.username?.toLowerCase();
  if (!me) return false;
  return text.toLowerCase().includes(`@${me}`);
}

export function registerGroupHandler(
  bot: Bot,
  getContract: () => `0x${string}`,
) {
  bot.on("message", async (ctx, next) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
      return next();
    }
    const text = ctx.message.text || ctx.message.caption;
    if (!text) return next();
    if (text.startsWith("/")) return next();
    if (!botMentioned(ctx)) return next();

    const from = ctx.from;
    if (!from) return;
    const handle = from.username || from.first_name || `user_${from.id}`;

    // Strip @bot from the text
    const cleaned = text
      .replace(new RegExp(`@${ctx.me.username}`, "gi"), "")
      .trim();
    if (!cleaned) {
      await ctx.reply(
        `Hi! Tag me with a YES/NO bet, e.g. "@${ctx.me.username} 5 GEN the Lakers beat the Bulls tonight"`,
        { reply_parameters: { message_id: ctx.message.message_id } },
      );
      return;
    }

    const thinking = await ctx.reply("Parsing your bet… 🤔", {
      reply_parameters: { message_id: ctx.message.message_id },
    });

    const parsed = await parseBetFromText(cleaned, new Date().toISOString());
    if (!parsed.ok) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        thinking.message_id,
        `I couldn't read that as a bet: ${parsed.reason || "unknown error"}\n\nTry: <i>"@${ctx.me.username} 5 GEN the Lakers beat the Bulls tonight"</i>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    // Ensure creator wallet exists & check balance.
    const w = getOrCreateUserWallet(from.id, handle);
    let stakeWei: bigint;
    try {
      stakeWei = genToWei(parsed.stake_gen!);
    } catch {
      await ctx.api.editMessageText(
        ctx.chat.id,
        thinking.message_id,
        "Stake amount looked invalid.",
      );
      return;
    }
    const bal = await getBalanceWei(w.address).catch(() => 0n);
    if (bal < stakeWei) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        thinking.message_id,
        [
          `<b>Not enough GEN to stake.</b>`,
          `You need <b>${parsed.stake_gen} GEN</b>; your wallet has <b>${genFromWei(bal)} GEN</b>.`,
          ``,
          `Your address: <code>${w.address}</code>`,
          `Top up via /deposit, then try again.`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }

    // Persist a pending bet awaiting creator confirmation.
    const id = shortId();
    const minDeadlineUnix =
      Math.floor(Date.now() / 1000) + MIN_DEADLINE_BUFFER_SECONDS;
    const parsedDeadlineUnix = Math.floor(
      Date.parse(parsed.deadline_iso!) / 1000,
    );
    const deadlineUnix = Math.max(parsedDeadlineUnix, minDeadlineUnix);
    const createdAtUnix = Math.floor(Date.now() / 1000);
    const plannedResolution = planResolution(
      parsed.question!,
      createdAtUnix,
      deadlineUnix,
    );
    if (plannedResolution && "error" in plannedResolution) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        thinking.message_id,
        plannedResolution.error,
      );
      return;
    }
    const resolutionUrl =
      plannedResolution?.resolutionUrl || parsed.resolution_url || "";
    db.prepare(
      `INSERT INTO pending_bets (
         id, chat_id, creator_tg_id, creator_handle, question, deadline,
         creator_yes, stake_wei, resolution_url, target_tg_id, target_handle,
         contract_address, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting', ?)`,
    ).run(
      id,
      ctx.chat.id,
      from.id,
      handle,
      parsed.question!,
      deadlineUnix,
      parsed.creator_yes ? 1 : 0,
      stakeWei.toString(),
      resolutionUrl,
      null,
      parsed.opponent_handle || null,
      getContract(),
      createdAtUnix,
    );

    const yesSide = parsed.creator_yes ? "YES" : "NO";
    const noSide = parsed.creator_yes ? "NO" : "YES";
    const card = [
      `<b>📝 Bet proposal</b>`,
      `📌 ${escapeHtml(parsed.question!)}`,
      ``,
      `<b>@${escapeHtml(handle)}</b> stakes <b>${parsed.stake_gen} GEN</b> on <b>${yesSide}</b>`,
      parsed.opponent_handle
        ? `🎯 Challenging: <b>@${escapeHtml(parsed.opponent_handle)}</b> (or anyone) — must match on <b>${noSide}</b>`
        : `Open to anyone willing to take <b>${noSide}</b>`,
      `⏰ Deadline: ${deadlineHuman(deadlineUnix)}`,
      resolutionUrl
        ? `🔗 Source: ${escapeHtml(resolutionLabel(resolutionUrl))}`
        : "",
      ``,
      `<i>@${escapeHtml(handle)} — confirm to lock your stake on-chain.</i>`,
    ]
      .filter(Boolean)
      .join("\n");

    const kb = new InlineKeyboard()
      .text("✅ Confirm & stake", `confirm:${id}`)
      .text("❌ Cancel", `cancel:${id}`);

    await ctx.api.editMessageText(ctx.chat.id, thinking.message_id, card, {
      parse_mode: "HTML",
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    });
  });
}
