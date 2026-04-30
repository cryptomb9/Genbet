import { abi } from "genlayer-js";

const args = ["0x03A74b6701C5646373C5c408DeF0CE01e2c404D8", 1000];
console.log("abi keys:", Object.keys(abi));
// abi.calldata.{n,encode,decode}
// @ts-ignore
const cd = (abi as any).calldata;
console.log("calldata keys:", Object.keys(cd));
const obj = cd.makeCalldataObject(undefined, args, undefined);
console.log("calldata object:", obj);
const encoded = cd.encode(obj);
console.log("encoded length:", encoded.length, "hex:", Buffer.from(encoded).toString("hex"));
const decoded = cd.decode(encoded);
console.log("round-trip decoded:", decoded);
