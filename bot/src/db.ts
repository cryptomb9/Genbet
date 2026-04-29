import Database from "better-sqlite3";
import { config } from "./config.js";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username    TEXT,
    address     TEXT NOT NULL,
    enc_pk      TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pending_bets (
    id              TEXT PRIMARY KEY,         -- short id used in callback data
    chat_id         INTEGER NOT NULL,
    creator_tg_id   INTEGER NOT NULL,
    creator_handle  TEXT NOT NULL,
    question        TEXT NOT NULL,
    deadline        INTEGER NOT NULL,         -- unix seconds
    creator_yes     INTEGER NOT NULL,         -- 1/0
    stake_wei       TEXT NOT NULL,
    resolution_url  TEXT NOT NULL DEFAULT '',
    target_tg_id    INTEGER,                  -- if proposed to a specific user
    target_handle   TEXT,
    status          TEXT NOT NULL DEFAULT 'awaiting',
    -- 'awaiting'   : creator must confirm staking
    -- 'open'       : on-chain, awaiting opponent
    -- 'active'     : both sides locked, on-chain bet_id set
    -- 'cancelled'  : creator cancelled before staking / before accept
    onchain_bet_id  INTEGER,                  -- set when create_bet succeeds
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export function getSetting(key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
