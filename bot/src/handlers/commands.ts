import type { Bot, Context } from "grammy";
import { config } from "../config.js";
import { getOrCreateUserWallet } from "../wallet.js";
import { bm, getBalanceWei, resolveBetOnchain } from "../genlayer.js";
import {
  escapeHtml,
  genFromWei,
  renderBet,
  shortAddr,
} from "../format.js";

const FAUCET_URL = "https://testnet-faucet.genlayer.foundation";

function ensureUser(ctx: Context) {
  const u = ctx.from;
  if (!u) throw new Error("No sender");
  return getOrCreateUserWallet(u.id, u.username || u.first_name || null);
}

export function registerCommands(bot: Bot, getContract: () => `0x${string}`) {
  bot.command("start", async (ctx) => {
    const w = ensureUser(ctx);
    await ctx.reply(
      [
        `<b>Welcome to BetBot</b> 🎲`,
        ``,
        `I run AI-resolved peer-to-peer bets on the GenLayer testnet.`,
        ``,
        `Your wallet: <code>${w.address}</code>`,
        `Network: <b>${config.network}</b>`,
        `Contract: <code>${getContract()}</code>`,
        ``,
        `<b>How to bet</b>`,
        `In a group, tag me with a challenge:`,
        `  <i>"@${ctx.me.username} I bet 5 GEN the Lakers beat the Bulls Thursday — anyone?"</i>`,
        `I'll post a confirm card. Once you stake, anyone can take the other side.`,
        ``,
        `<b>Commands</b>`,
        `/wallet — show your address &amp; balance`,
        `/deposit — how to fund your wallet`,
        `/mybets — list bets you're in`,
        `/openbets — list bets waiting for an opponent`,
        `/leaderboard — top earners`,
        `/resolve &lt;id&gt; — settle a bet whose deadline has passed`,
        `/contract — show the deployed contract address`,
        `/help — show this message`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "<b>Commands</b>",
        "/wallet, /deposit, /mybets, /openbets, /leaderboard, /resolve &lt;id&gt;, /contract",
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
        `<b>Your wallet</b>`,
        `<code>${w.address}</code>`,
        `Balance: <b>${balText}</b>`,
        ``,
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
        `<b>Deposit GEN</b>`,
        `Send GEN on <b>${config.network}</b> to:`,
        `<code>${w.address}</code>`,
        ``,
        `Need testnet GEN? Use the faucet:`,
        FAUCET_URL,
      ].join("\n"),
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  });

  bot.command("contract", async (ctx) => {
    await ctx.reply(
      `<b>BetMarket contract</b>\n<code>${getContract()}</code>\nNetwork: ${config.network}`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("mybets", async (ctx) => {
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
    const lines = ["<b>🏆 Leaderboard</b>"];
    rows.forEach((r, i) => {
      const name = r.handle ? `@${escapeHtml(r.handle)}` : shortAddr(r.address);
      lines.push(
        `${i + 1}. ${name} — <b>+${genFromWei(r.profit_wei)} GEN</b> (${r.wins}W / ${r.losses}L)`,
      );
    });
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
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
    await ctx.reply(`Resolving bet #${id}… this may take 1–2 minutes.`);
    try {
      const hash = await resolveBetOnchain(getContract(), w.privateKey, id);
      const updated = await bm.getBet(getContract(), id);
      const tail = updated ? `\n\n${renderBet(updated)}` : "";
      await ctx.reply(`✅ Resolved. tx: <code>${hash}</code>${tail}`, {
        parse_mode: "HTML",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Resolve failed: ${escapeHtml(msg)}`);
    }
  });
}
