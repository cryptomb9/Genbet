import { createClient, createAccount } from "genlayer-js";
import { TransactionStatus, type Hash } from "genlayer-js/types";
import { loadOperatorKey } from "../deploy.js";
import { chain } from "../genlayer.js";

const HASH = (process.argv[2] ??
  "0x1f5debf1ea094770049ef2b2d525cdb0ce3325e799435bca1b27e7cfc62da03f") as `0x${string}`;

async function main() {
  const account = createAccount(loadOperatorKey());
  const client = createClient({ chain: chain(), account });
  console.log("polling", HASH);

  for (let i = 0; i < 30; i++) {
    try {
      const tx = (await client.getTransaction({ hash: HASH as Hash })) as Record<
        string,
        unknown
      >;
      console.log(
        `[${i}] status=${tx.status} statusName=${tx.statusName} recipient=${tx.recipient}`,
      );
      const status = String(tx.status);
      // Once decided, dump the full receipt and exit.
      if (
        ["ACCEPTED", "FINALIZED", "UNDETERMINED", "CANCELED", "LEADER_TIMEOUT"]
          .includes(String(tx.statusName))
      ) {
        console.log("--- DECIDED ---");
        console.log("recipient:", tx.recipient);
        console.log("txDataDecoded:", JSON.stringify(tx.txDataDecoded, null, 2));
        const r = (await client.waitForTransactionReceipt({
          hash: HASH as Hash,
          status: TransactionStatus.ACCEPTED,
          retries: 1,
          interval: 1000,
        })) as Record<string, unknown>;
        console.log("--- SIMPLIFIED RECEIPT KEYS ---", Object.keys(r));
        console.log("recipient:", r.recipient);
        console.log("txDataDecoded:", JSON.stringify(r.txDataDecoded, null, 2));
        return;
      }
      if (status === "0" || status === "PENDING") {
        // pending — keep polling
      }
    } catch (e) {
      console.log(`[${i}] err`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log("gave up after 30 polls");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
