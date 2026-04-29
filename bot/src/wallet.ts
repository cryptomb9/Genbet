import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem";
import { db } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";

export interface UserWallet {
  telegramId: number;
  username: string | null;
  address: `0x${string}`;
  privateKey: `0x${string}`;
}

export function getOrCreateUserWallet(
  telegramId: number,
  username: string | null,
): UserWallet {
  const existing = db
    .prepare(
      "SELECT telegram_id, username, address, enc_pk FROM users WHERE telegram_id = ?",
    )
    .get(telegramId) as
    | { telegram_id: number; username: string | null; address: string; enc_pk: string }
    | undefined;

  if (existing) {
    // Update username if it changed
    if (username && username !== existing.username) {
      db.prepare("UPDATE users SET username = ? WHERE telegram_id = ?").run(
        username,
        telegramId,
      );
    }
    return {
      telegramId,
      username: username ?? existing.username,
      address: existing.address as `0x${string}`,
      privateKey: decrypt(existing.enc_pk) as `0x${string}`,
    };
  }

  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  db.prepare(
    "INSERT INTO users (telegram_id, username, address, enc_pk, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(telegramId, username, account.address, encrypt(pk), Math.floor(Date.now() / 1000));

  return {
    telegramId,
    username,
    address: account.address,
    privateKey: pk,
  };
}

export function getUserWallet(telegramId: number): UserWallet | undefined {
  const row = db
    .prepare(
      "SELECT telegram_id, username, address, enc_pk FROM users WHERE telegram_id = ?",
    )
    .get(telegramId) as
    | { telegram_id: number; username: string | null; address: string; enc_pk: string }
    | undefined;
  if (!row) return undefined;
  return {
    telegramId: row.telegram_id,
    username: row.username,
    address: row.address as `0x${string}`,
    privateKey: decrypt(row.enc_pk) as `0x${string}`,
  };
}

export function userAccount(w: UserWallet): Account {
  return privateKeyToAccount(w.privateKey);
}
