import { createClient, createAccount } from "genlayer-js";
import { TransactionStatus, type Hash } from "genlayer-js/types";
import { chain } from "../genlayer.js";

const HASH = (process.argv[2] ??
  "0x1f5debf1ea094770049ef2b2d525cdb0ce3325e799435bca1b27e7cfc62da03f") as `0x${string}`;

const client = createClient({ chain: chain(), account: createAccount() });
const r = (await client.waitForTransactionReceipt({
  hash: HASH as Hash,
  status: TransactionStatus.ACCEPTED,
  retries: 1,
  interval: 1000,
})) as Record<string, unknown>;
const replacer = (_k: string, v: unknown) =>
  typeof v === "bigint" ? v.toString() : v;
console.log("--- KEYS ---", Object.keys(r));
console.log("status:", r.status, r.statusName);
console.log("recipient:", r.recipient);
console.log("txExecutionResult:", r.txExecutionResult, r.txExecutionResultName);
console.log("result:", r.result, "resultName:", r.resultName);
console.log("messages:", JSON.stringify(r.messages, replacer));
console.log("eqBlocksOutputs:", JSON.stringify(r.eqBlocksOutputs, replacer)?.slice(0, 500));
console.log("randomSeed:", r.randomSeed);
console.log("activator:", r.activator);
console.log("lastLeader:", r.lastLeader);
console.log("consumedValidators:", JSON.stringify(r.consumedValidators, replacer)?.slice(0, 200));
console.log("--- txCalldata length ---", String((r.txCalldata as string)?.length));
console.log("--- txData length ---", String((r.txData as string)?.length));
