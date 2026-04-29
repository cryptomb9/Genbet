import { createClient, createAccount } from "genlayer-js";
import { testnetAsimov, localnet } from "genlayer-js/chains";
import {
  TransactionStatus,
  type Address as GLAddress,
  type CalldataEncodable,
  type Hash,
} from "genlayer-js/types";
import { config } from "./config.js";

function chain() {
  return config.network === "localnet" ? localnet : testnetAsimov;
}

type GLClient = ReturnType<typeof createClient>;

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
  const hash = await client.deployContract({
    code: contractCode,
    args: [config.houseAddress, config.houseFeeBps] as CalldataEncodable[],
    leaderOnly: false,
  });
  const receipt = await client.waitForTransactionReceipt({
    hash: hash as Hash,
    status: TransactionStatus.ACCEPTED,
    retries: 80,
    interval: 5000,
  });
  const data = (receipt as unknown as { data?: { contract_address?: string } })
    .data;
  const addr = data?.contract_address;
  if (!addr) throw new Error("Deploy receipt missing contract_address");
  return addr as `0x${string}`;
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
  const receipt = await client.waitForTransactionReceipt({
    hash: hash as Hash,
    status: TransactionStatus.ACCEPTED,
    retries,
    interval: 5000,
  });
  return { hash, receipt };
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

  let betId = 0;
  const data = (receipt as { data?: Record<string, unknown> })?.data;
  if (data) {
    const candidates = [
      data.execution_result,
      data.result,
      data.return_value,
    ];
    for (const c of candidates) {
      if (typeof c === "number") {
        betId = c;
        break;
      }
      if (typeof c === "string" && /^\d+$/.test(c)) {
        betId = Number(c);
        break;
      }
    }
  }
  if (!betId) {
    const stats = await bm.stats(contract);
    betId = stats.total_bets;
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
