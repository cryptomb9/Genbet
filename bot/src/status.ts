import type { Bot } from "grammy";
import { createAccount, createClient } from "genlayer-js";
import type { Hash } from "genlayer-js/types";
import { db } from "./db.js";
import { bm, chain } from "./genlayer.js";
import {
  deadlineHuman,
  escapeHtml,
  genFromWei,
  renderBet,
  shortAddr,
  shortHash,
} from "./format.js";

type TxMessage = {
  recipient: string;
  value: bigint;
  onAcceptance: boolean;
};

type TxSummary = {
  statusName: string;
  executionName: string;
  messages: TxMessage[];
};

type TxWatchRow = {
  tx_hash: string;
  contract_address: string;
  onchain_bet_id: number | null;
  chat_id: number;
  kind: string;
  status: string;
  execution: string;
  message: string;
  notified_at: number | null;
  created_at: number;
  updated_at: number;
};

const FINAL_STATUSES = new Set([
  "FINALIZED",
  "CANCELED",
  "LEADER_TIMEOUT",
  "VALIDATORS_TIMEOUT",
]);

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function isFinalStatus(status: string): boolean {
  return FINAL_STATUSES.has(status.toUpperCase());
}

function payoutLine(messages: TxMessage[]): string {
  const payouts = messages.filter((m) => BigInt(m.value) > 0n);
  if (payouts.length === 0) return "";
  return payouts
    .map(
      (m) =>
        `${genFromWei(m.value)} GEN -> <code>${shortAddr(m.recipient)}</code>${
          m.onAcceptance ? "" : " after finality"
        }`,
    )
    .join("\n");
}

export function recordTxWatch(args: {
  txHash: `0x${string}`;
  contract: `0x${string}`;
  betId?: number | null;
  chatId: number;
  kind: string;
  message?: string;
}): void {
  db.prepare(
    `INSERT INTO tx_watches
      (tx_hash, contract_address, onchain_bet_id, chat_id, kind, status, message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ACCEPTED', ?, ?, ?)
     ON CONFLICT(tx_hash) DO UPDATE SET
       contract_address = excluded.contract_address,
       onchain_bet_id = COALESCE(excluded.onchain_bet_id, tx_watches.onchain_bet_id),
       chat_id = excluded.chat_id,
       kind = excluded.kind,
       message = excluded.message,
       updated_at = excluded.updated_at`,
  ).run(
    args.txHash,
    args.contract,
    args.betId ?? null,
    args.chatId,
    args.kind,
    args.message ?? "",
    now(),
    now(),
  );
}

async function getTxSummary(txHash: string): Promise<TxSummary> {
  const client = createClient({ chain: chain(), account: createAccount() });
  const tx = (await client.getTransaction({ hash: txHash as Hash })) as {
    statusName?: string;
    status?: string | number;
    txExecutionResultName?: string;
    messages?: TxMessage[];
  };
  return {
    statusName: String(tx.statusName ?? tx.status ?? "unknown"),
    executionName: String(tx.txExecutionResultName ?? ""),
    messages: tx.messages ?? [],
  };
}

async function updateWatch(row: TxWatchRow): Promise<TxSummary> {
  const summary = await getTxSummary(row.tx_hash);
  const payouts = payoutLine(summary.messages);
  db.prepare(
    `UPDATE tx_watches
       SET status = ?, execution = ?, message = ?, updated_at = ?
     WHERE tx_hash = ?`,
  ).run(
    summary.statusName,
    summary.executionName,
    payouts,
    now(),
    row.tx_hash,
  );
  return summary;
}

function watchedRowsForBet(
  contract: `0x${string}`,
  betId: number,
): TxWatchRow[] {
  return db
    .prepare(
      `SELECT * FROM tx_watches
       WHERE contract_address = ? AND onchain_bet_id = ?
       ORDER BY created_at ASC`,
    )
    .all(contract, betId) as TxWatchRow[];
}

export async function renderStatusReport(
  contract: `0x${string}`,
  betId: number,
): Promise<string> {
  const bet = await bm.getBet(contract, betId);
  if (!bet) return `Bet #${betId} not found.`;

  const lines = [`<b>Status for Bet #${betId}</b>`, "", renderBet(bet)];

  if (bet.status === "active") {
    if (bet.deadline > now()) {
      lines.push("", `Resolvable: ${deadlineHuman(bet.deadline)}`);
    } else {
      lines.push("", "Resolvable now with /resolve.");
    }
  }

  const rows = watchedRowsForBet(contract, betId);
  if (rows.length === 0) {
    lines.push(
      "",
      "<b>Transactions</b>",
      "No tracked txs for this bet yet. Older txs made before status tracking was added may not appear here.",
    );
    return lines.join("\n");
  }

  lines.push("", "<b>Transactions</b>");
  for (const row of rows) {
    let summary: TxSummary | null = null;
    try {
      summary = await updateWatch(row);
    } catch {
      // Keep the last stored status if the RPC flakes.
    }
    const status = escapeHtml(summary?.statusName ?? row.status);
    const execution = summary?.executionName || row.execution;
    const payouts = summary ? payoutLine(summary.messages) : row.message;
    lines.push(
      `${escapeHtml(row.kind)}: <code>${shortHash(row.tx_hash)}</code> - <b>${status}</b>${
        execution ? ` (${escapeHtml(execution)})` : ""
      }`,
    );
    if (payouts) lines.push(payouts);
  }

  return lines.join("\n");
}

export function startTxStatusWatcher(bot: Bot): void {
  const tick = async () => {
    const rows = db
      .prepare(
        `SELECT * FROM tx_watches
         WHERE notified_at IS NULL
           AND status NOT IN ('FINALIZED', 'CANCELED', 'LEADER_TIMEOUT', 'VALIDATORS_TIMEOUT')
         ORDER BY created_at ASC
         LIMIT 30`,
      )
      .all() as TxWatchRow[];

    for (const row of rows) {
      try {
        const summary = await updateWatch(row);
        if (!isFinalStatus(summary.statusName)) continue;

        db.prepare(
          "UPDATE tx_watches SET notified_at = ?, updated_at = ? WHERE tx_hash = ?",
        ).run(now(), now(), row.tx_hash);

        const payouts = payoutLine(summary.messages);
        const lines = [
          `<b>GenLayer tx finalized</b>`,
          `${escapeHtml(row.kind)}${
            row.onchain_bet_id ? ` for bet #${row.onchain_bet_id}` : ""
          }`,
          `tx: <code>${shortHash(row.tx_hash)}</code>`,
          `status: <b>${escapeHtml(summary.statusName)}</b>`,
        ];
        if (payouts) {
          lines.push("", "<b>Payout/refund messages</b>", payouts);
        }
        await bot.api.sendMessage(row.chat_id, lines.join("\n"), {
          parse_mode: "HTML",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[status] watcher failed for ${row.tx_hash}: ${msg}`);
      }
    }
  };

  void tick();
  setInterval(() => void tick(), 60_000);
}
