import { formatEther } from "viem";
import type { OnchainBet } from "./genlayer.js";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function genFromWei(weiStr: string | bigint): string {
  const wei = typeof weiStr === "bigint" ? weiStr : BigInt(weiStr);
  // formatEther returns up to 18 decimals; trim trailing zeros for display
  const s = formatEther(wei);
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "") || "0";
}

export function genToWei(gen: number | string): bigint {
  const n = typeof gen === "string" ? Number(gen) : gen;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("Invalid GEN amount");
  }
  // Avoid float precision: split into whole + frac
  const [whole, fracRaw = ""] = String(n).split(".");
  const frac = (fracRaw + "000000000000000000").slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(frac || "0");
}

export function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function shortHash(h: string): string {
  if (!h) return "";
  return `${h.slice(0, 10)}…`;
}

export function deadlineHuman(unix: number): string {
  const d = new Date(unix * 1000);
  const ms = d.getTime() - Date.now();
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60000);
  const rel =
    mins < 60
      ? `${mins}m`
      : mins < 60 * 24
      ? `${Math.round(mins / 60)}h`
      : `${Math.round(mins / 60 / 24)}d`;
  const when = ms >= 0 ? `in ${rel}` : `${rel} ago`;
  return `${d.toISOString().replace("T", " ").slice(0, 16)} UTC (${when})`;
}

export function renderBet(b: OnchainBet): string {
  const stake = genFromWei(b.stake);
  const yesSide = b.creator_yes ? "YES" : "NO";
  const noSide = b.creator_yes ? "NO" : "YES";
  const lines: string[] = [];
  lines.push(`<b>Bet #${b.id}</b> — ${stake} GEN/side`);
  lines.push(`📌 ${escapeHtml(b.question)}`);
  lines.push(
    `👤 <b>${escapeHtml(b.creator_handle || shortAddr(b.creator))}</b> (${yesSide}) vs ${
      b.accepter && b.accepter !== "0x0000000000000000000000000000000000000000"
        ? `<b>${escapeHtml(b.accepter_handle || shortAddr(b.accepter))}</b> (${noSide})`
        : `<i>open — anyone can take ${noSide}</i>`
    }`,
  );
  lines.push(`⏰ Deadline: ${deadlineHuman(b.deadline)}`);
  if (b.resolution_url) lines.push(`🔗 Source hint: ${escapeHtml(b.resolution_url)}`);
  if (b.status === "resolved") {
    if (b.outcome === "UNCLEAR") {
      lines.push("⚖️ <b>UNCLEAR</b> — both sides refunded");
    } else {
      lines.push(
        `🏆 Outcome: <b>${b.outcome}</b> — winner: <code>${shortAddr(b.winner)}</code>`,
      );
    }
    if (b.reasoning) lines.push(`💭 <i>${escapeHtml(b.reasoning)}</i>`);
  } else {
    lines.push(`📊 Status: <b>${b.status}</b>`);
  }
  return lines.join("\n");
}
