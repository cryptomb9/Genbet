import { createClient, createAccount } from "genlayer-js";
import { testnetAsimov, testnetBradbury, localnet } from "genlayer-js/chains";
import {
  ExecutionResult,
  TransactionStatus,
  type Address as GLAddress,
  type CalldataEncodable,
  type Hash,
} from "genlayer-js/types";
import { config } from "./config.js";

export function chain() {
  if (config.network === "localnet") return localnet;
  if (config.network === "testnet-bradbury") return testnetBradbury;
  return testnetAsimov;
}

type GLClient = ReturnType<typeof createClient>;
const ZERO = "0x" + "0".repeat(40);

function newClient(privateKey?: `0x${string}`): GLClient {
  const account = createAccount(privateKey);
  return createClient({ chain: chain(), account });
}

export async function getBalanceWei(
  address: `0x${string}`,
): Promise<bigint> {
  const client = newClient();
  const bal = await client.getBalance({ address: address as GLAddress });
  return BigInt(bal as unknown as bigint);
}

export async function deployBetMarket(
  operatorPrivateKey: `0x${string}`,
  contractCode: string,
): Promise<`0x${string}`> {
  const client = newClient(operatorPrivateKey);
  const hash = (await client.deployContract({
    code: contractCode,
    args: [config.houseAddress, config.houseFeeBps] as CalldataEncodable[],
    leaderOnly: false,
  })) as Hash;
  console.log(`[deploy] tx hash: ${hash}`);

  const isAddr = (s: unknown): s is string =>
    typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s) && s !== ZERO;
  const isTerminalFailure = (statusName: string) =>
    ["CANCELED", "LEADER_TIMEOUT", "VALIDATORS_TIMEOUT"].includes(statusName);
  const isReadableBetMarket = async (candidate: string): Promise<boolean> => {
    try {
      await client.readContract({
        address: candidate as GLAddress,
        functionName: "stats",
        args: [],
      });
      return true;
    } catch {
      return false;
    }
  };

  // Do not cache the deployment address until the contract is actually
  // readable. Bradbury can expose the recipient before the deploy has landed.
  for (let i = 0; i < 120; i++) {
    try {
      const tx = (await client.getTransaction({ hash })) as Record<
        string,
        unknown
      >;
      const status = Number(tx.status ?? 0);
      const statusName = String(tx.statusName ?? "");
      const recipient = tx.recipient;
      const decoded = tx.txDataDecoded as
        | { contractAddress?: unknown }
        | undefined;
      const candidate = isAddr(recipient)
        ? recipient
        : isAddr(decoded?.contractAddress)
          ? (decoded!.contractAddress as string)
          : null;

      if (i === 0 || i % 4 === 0) {
        console.log(
          `[deploy] poll ${i}: status=${status} (${statusName}) recipient=${recipient ?? "none"}`,
        );
      }
      if (candidate && (await isReadableBetMarket(candidate))) {
        console.log(`[deploy] contract address: ${candidate}`);
        return candidate as `0x${string}`;
      }
      if (isTerminalFailure(statusName)) {
        throw new Error(`Deploy failed on-chain: ${statusName}`);
      }
    } catch (e) {
      console.log(`[deploy] poll ${i} err:`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  void TransactionStatus.ACCEPTED;
  throw new Error(
    `Deploy did not produce a readable contract within 10 minutes for hash ${hash}`,
  );
}

export interface OnchainBet {
  id: number;
  creator: string;
  creator_handle: string;
  accepter: string;
  accepter_handle: string;
  creator_yes: boolean;
  question: string;
  resolution_url: string;
  stake: string; // wei as decimal string
  deadline: number;
  status: "open" | "active" | "resolved" | "cancelled" | string;
  outcome: "" | "YES" | "NO" | "UNCLEAR" | string;
  winner: string;
  created_at: number;
  chat_id: string;
  reasoning: string;
  cancel_requested_by?: string;
}

async function read<T>(
  contract: `0x${string}`,
  functionName: string,
  args: unknown[] = [],
): Promise<T> {
  const client = newClient();
  return (await client.readContract({
    address: contract as GLAddress,
    functionName,
    args: args as CalldataEncodable[],
  })) as T;
}

export const bm = {
  async getBet(contract: `0x${string}`, id: number): Promise<OnchainBet | null> {
    const r = await read<Record<string, unknown> | OnchainBet>(
      contract,
      "get_bet",
      [id],
    );
    if (!r || Object.keys(r as Record<string, unknown>).length === 0) {
      return null;
    }
    return r as OnchainBet;
  },
  async listBets(
    contract: `0x${string}`,
    status: "open" | "active" | "resolved",
    limit = 20,
  ): Promise<OnchainBet[]> {
    return read<OnchainBet[]>(contract, "list_bets", [status, limit]);
  },
  async myBets(
    contract: `0x${string}`,
    address: `0x${string}`,
    limit = 20,
  ): Promise<OnchainBet[]> {
    return read<OnchainBet[]>(contract, "my_bets", [address, limit]);
  },
  async leaderboard(contract: `0x${string}`, limit = 10) {
    return read<
      Array<{
        address: string;
        handle: string;
        wins: number;
        losses: number;
        profit_wei: string;
      }>
    >(contract, "leaderboard", [limit]);
  },
  async stats(contract: `0x${string}`) {
    return read<{
      total_bets: number;
      open: number;
      active: number;
      resolved: number;
      house: string;
      fee_bps: number;
    }>(contract, "stats");
  },
};

async function writeAndWait(
  client: GLClient,
  args: {
    address: `0x${string}`;
    functionName: string;
    args: unknown[];
    value: bigint;
  },
  retries = 80,
): Promise<{ hash: `0x${string}`; receipt: unknown }> {
  const hash = (await client.writeContract({
    address: args.address as GLAddress,
    functionName: args.functionName,
    args: args.args as CalldataEncodable[],
    value: args.value,
  })) as `0x${string}`;
  console.log(
    `[onchain] submitted ${args.functionName} tx=${hash} contract=${args.address}`,
  );

  let receipt: unknown;
  try {
    receipt = await client.waitForTransactionReceipt({
      hash: hash as Hash,
      status: TransactionStatus.ACCEPTED,
      retries,
      interval: 5000,
    });
  } catch (err) {
    const base = err instanceof Error ? err.message : String(err);
    try {
      const tx = (await client.getTransaction({ hash: hash as Hash })) as {
        status?: string | number;
        statusName?: string;
        txExecutionResultName?: string;
      };
      throw new Error(
        `GenLayer ${args.functionName} failed: tx=${hash}, status=${String(
          tx.statusName ?? tx.status ?? "unknown",
        )}, execution=${String(tx.txExecutionResultName ?? "unknown")}, cause=${base}`,
      );
    } catch {
      throw new Error(
        `GenLayer ${args.functionName} failed: tx=${hash}, cause=${base}`,
      );
    }
  }

  const tx = receipt as {
    txExecutionResultName?: ExecutionResult | string;
    statusName?: TransactionStatus | string;
    consensus_data?: {
      leader_receipt?: Array<{
        error?: string | null;
        execution_result?: string;
        result?: string;
      }>;
    };
  };
  if (tx.txExecutionResultName !== ExecutionResult.FINISHED_WITH_RETURN) {
    const leader = tx.consensus_data?.leader_receipt?.[0];
    const detail =
      leader?.error ||
      leader?.execution_result ||
      leader?.result ||
      tx.txExecutionResultName ||
      "unknown execution result";
    throw new Error(
      `GenLayer ${args.functionName} execution failed: tx=${hash}, status=${String(
        tx.statusName ?? "unknown",
      )}, detail=${detail}`,
    );
  }

  console.log(
    `[onchain] accepted ${args.functionName} tx=${hash} execution=${String(
      tx.txExecutionResultName ?? "unknown",
    )}`,
  );

  return { hash, receipt };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sameAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isExpectedCreatedBet(
  bet: OnchainBet | null,
  creatorAddress: `0x${string}`,
  payload: {
    question: string;
    deadline: number;
    creatorYes: boolean;
    resolutionUrl: string;
    stakeWei: bigint;
  },
): bet is OnchainBet {
  if (!bet) return false;
  return (
    sameAddr(bet.creator, creatorAddress) &&
    bet.question === payload.question &&
    Number(bet.deadline) === payload.deadline &&
    Boolean(bet.creator_yes) === payload.creatorYes &&
    String(bet.stake) === payload.stakeWei.toString() &&
    (bet.resolution_url || "") === (payload.resolutionUrl || "") &&
    sameAddr(bet.winner, ZERO)
  );
}

function extractNumericReturn(receipt: unknown): number {
  const tx = receipt as {
    data?: Record<string, unknown>;
    consensus_data?: {
      leader_receipt?: Array<{
        execution_result?: unknown;
        result?: unknown;
      }>;
    };
  };
  const candidates = [
    tx.data?.execution_result,
    tx.data?.result,
    tx.data?.return_value,
    tx.consensus_data?.leader_receipt?.[0]?.execution_result,
    tx.consensus_data?.leader_receipt?.[0]?.result,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isInteger(c) && c > 0) return c;
    if (typeof c === "string") {
      const trimmed = c.trim();
      if (/^\d+$/.test(trimmed)) return Number(trimmed);
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0) {
          return parsed;
        }
      } catch {
        // not JSON
      }
    }
  }
  return 0;
}

async function recoverCreateBetId(
  contract: `0x${string}`,
  creatorAddress: `0x${string}`,
  payload: {
    question: string;
    deadline: number;
    creatorYes: boolean;
    resolutionUrl: string;
    stakeWei: bigint;
  },
): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const mine = await bm.myBets(contract, creatorAddress, 30);
      const match = mine.find((b) => isExpectedCreatedBet(b, creatorAddress, payload));
      if (match?.id && Number.isInteger(match.id) && match.id > 0) {
        return match.id;
      }
    } catch {
      // ignore transient read failures
    }

    try {
      const stats = await bm.stats(contract);
      if (stats.total_bets > 0) {
        const tail = await bm.getBet(contract, stats.total_bets);
        if (isExpectedCreatedBet(tail, creatorAddress, payload)) {
          return stats.total_bets;
        }
      }
    } catch {
      // ignore transient read failures
    }

    await sleep(2500 + attempt * 1000);
  }
  return 0;
}

export async function createBetOnchain(
  contract: `0x${string}`,
  signerPk: `0x${string}`,
  payload: {
    question: string;
    deadline: number;
    creatorYes: boolean;
    resolutionUrl: string;
    chatId: string;
    creatorHandle: string;
    stakeWei: bigint;
  },
): Promise<{ hash: `0x${string}`; betId: number }> {
  const client = newClient(signerPk);
  const creatorAddress = createAccount(signerPk).address as `0x${string}`;
  const { hash, receipt } = await writeAndWait(client, {
    address: contract,
    functionName: "create_bet",
    args: [
      payload.question,
      payload.deadline,
      payload.creatorYes,
      payload.resolutionUrl,
      payload.chatId,
      payload.creatorHandle,
    ],
    value: payload.stakeWei,
  });

  let betId = extractNumericReturn(receipt);
  if (betId > 0) {
    const byId = await bm.getBet(contract, betId).catch(() => null);
    if (!isExpectedCreatedBet(byId, creatorAddress, payload)) {
      betId = 0;
    }
  }
  if (!betId) {
    betId = await recoverCreateBetId(contract, creatorAddress, payload);
  }
  if (!Number.isInteger(betId) || betId <= 0) {
    throw new Error(
      `create_bet accepted but bet id could not be recovered from chain state, tx=${hash}`,
    );
  }
  return { hash, betId };
}

export async function acceptBetOnchain(
  contract: `0x${string}`,
  signerPk: `0x${string}`,
  betId: number,
  accepterHandle: string,
  stakeWei: bigint,
): Promise<`0x${string}`> {
  const client = newClient(signerPk);
  const { hash } = await writeAndWait(client, {
    address: contract,
    functionName: "accept_bet",
    args: [betId, accepterHandle],
    value: stakeWei,
  });
  return hash;
}

export async function cancelBetOnchain(
  contract: `0x${string}`,
  signerPk: `0x${string}`,
  betId: number,
): Promise<`0x${string}`> {
  const client = newClient(signerPk);
  const { hash } = await writeAndWait(client, {
    address: contract,
    functionName: "cancel_bet",
    args: [betId],
    value: 0n,
  });
  return hash;
}

export async function requestCancelActiveOnchain(
  contract: `0x${string}`,
  signerPk: `0x${string}`,
  betId: number,
): Promise<`0x${string}`> {
  const client = newClient(signerPk);
  const { hash } = await writeAndWait(client, {
    address: contract,
    functionName: "request_cancel_active",
    args: [betId],
    value: 0n,
  });
  return hash;
}

export async function resolveBetOnchain(
  contract: `0x${string}`,
  signerPk: `0x${string}`,
  betId: number,
): Promise<`0x${string}`> {
  const client = newClient(signerPk);
  const { hash } = await writeAndWait(
    client,
    {
      address: contract,
      functionName: "resolve",
      args: [betId],
      value: 0n,
    },
    150,
  );
  return hash;
}
