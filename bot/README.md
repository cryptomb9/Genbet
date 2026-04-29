# BetBot — AI-resolved P2P betting on GenLayer

A Telegram bot for **peer-to-peer betting on real-world events**, settled by an
AI-judged Python intelligent contract on the **GenLayer testnet (Asimov)**.

In a group, tag the bot with a YES/NO claim and a stake:

> **@yourbot** I bet 5 GEN the Lakers beat the Bulls tonight — anyone?

The bot parses the bet, posts a confirm card, and once the creator presses
**Confirm & stake** the bet is locked on-chain. Anyone can take the other side
by tapping **Take NO**. After the deadline, anyone can `/resolve <id>` and the
contract reads the web + asks an LLM whether the claim was true. Winner gets
**90 %** of the pot, **10 %** goes to the house wallet.

---

## Features

- 🤖 Natural-language bet parsing (OpenAI / Replit AI Integrations)
- 🐍 Python intelligent contract `BetMarket` deployed once, auto-cached
- 👛 Per-user wallets generated on first interaction, encrypted at rest (AES-256-GCM)
- ⏰ Deadline-gated resolution; `/resolve <id>` is callable by anyone
- 🌐 LLM consensus via `gl.eq_principle.strict_eq` over web evidence
- 🏆 `/leaderboard`, `/mybets`, `/openbets`, `/wallet`, `/deposit`, `/contract`
- 💸 House fee paid to a configurable address (default 10 %, in basis points)
- 🔁 Auto-deploy: first run deploys the contract; address is cached in SQLite

---

## Quick start

### 1. Install

```bash
pnpm install
```

### 2. Configure

Copy `.env.example` → `.env` and fill in:

| Var | What |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | from [@BotFather](https://t.me/BotFather) |
| `HOUSE_FEE_ADDRESS` | wallet that receives the 10 % cut |
| `HOUSE_FEE_BPS` | basis points (1000 = 10 %) |
| `GENLAYER_NETWORK` | `testnet-asimov` (default) |
| `AI_INTEGRATIONS_OPENAI_API_KEY` + `_BASE_URL` | OpenAI proxy creds |

On Replit, the AI Integrations vars are set automatically.

### 3. Fund the operator wallet

The bot generates an **operator wallet** on first run and prints its address.
This wallet pays gas to deploy the contract. Send it some testnet GEN:

> https://testnet-faucet.genlayer.foundation

The address is also saved to `data/.operator_key` (raw private key — back it up
or set `OPERATOR_PRIVATE_KEY` in `.env` instead).

### 4. Start

```bash
pnpm --filter @workspace/bot run dev
```

On first start the bot will:

1. Deploy `contracts/bet_market.py` to GenLayer Asimov.
2. Save the contract address in SQLite (`data/bot.sqlite`) and `data/.contract_address`.
3. Start long-polling Telegram.

Add the bot to a group and **disable Privacy Mode** in @BotFather
(`/mybots → Bot Settings → Group Privacy → Turn off`) so it can read messages.

---

## Bot commands

| Command | Meaning |
| --- | --- |
| `/start`, `/help` | onboarding |
| `/wallet` | your address & balance |
| `/deposit` | how to fund your wallet |
| `/mybets` | bets you're in |
| `/openbets` | bets waiting for an opponent |
| `/leaderboard` | top earners (cumulative profit) |
| `/resolve <id>` | settle a bet whose deadline passed (anyone can call) |
| `/contract` | the deployed `BetMarket` address |

In a group, **tag the bot** with a sentence like
"I bet 3 GEN the SpaceX Starship lands successfully on April 30 — anyone?"
to start a bet. The opponent taps the inline button to lock their stake.

---

## Architecture

```
┌────────────────────┐    long-poll    ┌──────────────────────┐
│  Telegram (groups) │ ─────────────▶  │  bot/ (Node + grammY)│
└────────────────────┘                 │   parser (OpenAI)    │
                                       │   per-user wallets   │
                                       │   SQLite (sessions)  │
                                       └─────────┬────────────┘
                                                 │ genlayer-js
                                                 ▼
                                       ┌──────────────────────┐
                                       │ GenLayer Asimov RPC  │
                                       │  BetMarket (Python)  │
                                       │  - create_bet        │
                                       │  - accept_bet        │
                                       │  - resolve  (LLM)    │
                                       │  - emit_transfer 90/10│
                                       └──────────────────────┘
```

Bet lifecycle:

1. Group message tagged → AI parses → confirm card posted.
2. Creator taps **Confirm & stake** → `create_bet` (payable) on-chain.
3. Opponent taps **Take NO** → `accept_bet` (payable) on-chain.
4. After `deadline`, anyone calls `/resolve <id>` → contract fetches web
   evidence (`gl.nondet.web.get`), asks the LLM
   (`gl.nondet.exec_prompt`), wraps it in `gl.eq_principle.strict_eq`, and
   pays out via `gl.emit_transfer` (winner 90 %, house 10 %).
5. `UNCLEAR` outcomes refund both sides with no fee.

---

## File map

```
bot/
├── contracts/bet_market.py     # GenLayer Python intelligent contract
├── src/
│   ├── index.ts                # bot entrypoint
│   ├── config.ts               # env + paths
│   ├── crypto.ts               # AES-256-GCM key wrap
│   ├── db.ts                   # SQLite (better-sqlite3) schema
│   ├── wallet.ts               # per-user wallet generation
│   ├── genlayer.ts             # genlayer-js client + BetMarket calls
│   ├── deploy.ts               # auto-deploy on first run
│   ├── parser.ts               # OpenAI bet-parsing prompt
│   ├── format.ts               # message rendering helpers
│   ├── handlers/
│   │   ├── commands.ts         # /start /wallet /resolve …
│   │   ├── group.ts            # @bot mentions in groups
│   │   └── callbacks.ts        # Confirm / Cancel / Accept buttons
│   └── scripts/deployContract.ts  # standalone deploy helper
├── data/                        # SQLite + cached keys (gitignored)
├── .env.example
└── README.md
```

---

## Free hosting

The bot uses **long polling** so it works behind any NAT and needs no inbound
ports. Two free paths:

### A. Replit (this template)

Already wired. The "Telegram Bot" workflow runs `pnpm --filter @workspace/bot
run dev`. Keep the Repl alive by deploying it as a Reserved VM or by pinging it
from a free uptime service.

### B. Cloudflare Workers (webhook mode)

grammY supports webhooks out of the box. To switch:

```ts
import { webhookCallback } from "grammy";
export default {
  fetch: webhookCallback(bot, "cloudflare-mod"),
};
```

Then call `bot.api.setWebhook("https://<your-worker>.workers.dev/")` once at
deploy time. SQLite isn't available on Workers — port `db.ts` to D1
(`drizzle-orm/d1`) and `crypto.ts` to Workers' `crypto.subtle` AES-GCM.

---

## Security notes

- Per-user private keys are encrypted with AES-256-GCM under a 32-byte key.
  The key comes from `SESSION_SECRET` (env) or `data/.session_key` (auto-gen).
  **Lose the key → lose the wallets.** Back it up.
- The operator wallet only pays gas + deploys the contract. It does **not**
  hold user stakes.
- Stakes are held by the on-chain `BetMarket` contract until resolution.
- This is a testnet toy. Do not put real money on it.

---

## License

MIT
