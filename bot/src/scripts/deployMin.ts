import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, createAccount } from "genlayer-js";
import { testnetAsimov } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { loadOperatorKey } from "../deploy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODE = fs.readFileSync(
  path.resolve(__dirname, "../../contracts/_min.py"),
  "utf8",
);

const account = createAccount(loadOperatorKey());
const client = createClient({ chain: testnetAsimov, account });
console.log("operator:", account.address);

const hash = await client.deployContract({
  code: CODE,
  args: ["BetBot", 1000n],
  leaderOnly: false,
});
console.log("hash:", hash);

for (let i = 0; i < 60; i++) {
  const tx = (await client.getTransaction({ hash })) as Record<string, unknown>;
  const sn = String(tx.statusName ?? "");
  console.log(
    `[${i}] status=${tx.status} (${sn}) result=${tx.txExecutionResult ?? "?"} (${tx.txExecutionResultName ?? ""}) recipient=${tx.recipient}`,
  );
  if (
    ["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED", "LEADER_TIMEOUT"]
      .includes(sn)
  ) {
    if (Number(tx.txExecutionResult) === 0 || tx.txExecutionResultName === "SUCCESS") {
      console.log("DEPLOY OK at", tx.recipient);
      // try a read
      try {
        const r = await client.readContract({
          address: tx.recipient as `0x${string}`,
          functionName: "get_name",
          args: [],
        });
        console.log("get_name=", r);
      } catch (e) {
        console.log("read err:", (e as Error).message?.slice(0, 200));
      }
    } else {
      console.log("DEPLOY FAILED ON-CHAIN");
      console.log(
        "eqBlocksOutputs:",
        JSON.stringify((tx as Record<string, unknown>).eqBlocksOutputs),
      );
    }
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.log("timed out");
void TransactionStatus.ACCEPTED;
