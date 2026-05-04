import { createClient, createAccount } from "genlayer-js";
import { chain } from "../genlayer.js";
const client = createClient({ chain: chain(), account: createAccount() });
const ADDR = (process.argv[2] ??
  "0x735D05fe4d5B5239c9da4689Ed0C1e49b5AC275a") as `0x${string}`;
try {
  const r = await client.readContract({
    address: ADDR,
    functionName: "stats",
    args: [],
  });
  console.log("OK stats=", r);
} catch (e) {
  console.log("READ FAIL:", (e as Error).message?.slice(0, 500));
}
