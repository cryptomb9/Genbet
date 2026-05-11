import fs from "node:fs";
import { config } from "../config.js";
import { db } from "../db.js";

function main() {
  db.prepare("DELETE FROM settings WHERE key = ?").run("contract_address");

  if (fs.existsSync(config.contractAddrPath)) {
    fs.rmSync(config.contractAddrPath, { force: true });
  }

  console.log("Cleared cached contract address from SQLite and legacy file.");
}

main();

