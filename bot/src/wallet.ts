import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem";
import crypto from "node:crypto";
import { db } from "./db.js";
import { config } from "./config.js";
import { encrypt, decrypt } from "./crypto.js";

export interface UserWallet {
  telegramId: number;
  username: string | null;
  address: `0x${string}`;
  privateKey: `0x${string}`;
}

export function normalizePrivateKey(raw: string): `0x${string}` {
  const trimmed = raw.trim();
  const pk = (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error("Private key must be 64 hex characters, with or without 0x.");
  }
  privateKeyToAccount(pk);
  return pk;
}

function derivePrivateKey(telegramId: number): `0x${string}` | null {
  const secret = config.walletSeedSecret.trim();
  if (!secret) return null;

  for (let counter = 0; counter < 10; counter++) {
    const digest = crypto
      .createHmac("sha256", secret)
      .update(`genbet:user-wallet:${telegramId}:${counter}`)
      .digest("hex");
    try {
      return normalizePrivateKey(digest);
    } catch {
      // Extremely unlikely: HMAC output was not a valid secp256k1 key.
    }
  }
  throw new Error("Could not derive a valid wallet key.");
}

function newUserPrivateKey(telegramId: number): `0x${string}` {
  return derivePrivateKey(telegramId) || generatePrivateKey();
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

  const pk = newUserPrivateKey(telegramId);
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

export function importUserWallet(
  telegramId: number,
  username: string | null,
  privateKey: string,
): UserWallet {
  const pk = normalizePrivateKey(privateKey);
  const account = privateKeyToAccount(pk);
  db.prepare(
    `INSERT INTO users (telegram_id, username, address, enc_pk, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET
       username = excluded.username,
       address = excluded.address,
       enc_pk = excluded.enc_pk`,
  ).run(
    telegramId,
    username,
    account.address,
    encrypt(pk),
    Math.floor(Date.now() / 1000),
  );

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
