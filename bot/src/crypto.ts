import crypto from "node:crypto";
import fs from "node:fs";
import { config } from "./config.js";

function loadOrCreateKey(): Buffer {
  if (config.sessionSecret) {
    const raw = config.sessionSecret.trim();
    // Accept hex (64 chars) or any string -> hash to 32 bytes
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
    return crypto.createHash("sha256").update(raw).digest();
  }
  if (fs.existsSync(config.sessionKeyPath)) {
    return Buffer.from(fs.readFileSync(config.sessionKeyPath, "utf8"), "hex");
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(config.sessionKeyPath, key.toString("hex"), {
    mode: 0o600,
  });
  console.warn(
    `[crypto] Generated new encryption key at ${config.sessionKeyPath}. Back this up!`,
  );
  return key;
}

const KEY = loadOrCreateKey();

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
    "utf8",
  );
}
