# Project: BetBot — Telegram bot for AI-resolved P2P bets on GenLayer

A single workspace package, `bot/`, that runs a Telegram bot which posts and
settles peer-to-peer YES/NO bets on the GenLayer testnet (Asimov). Bets are
parsed from natural language with OpenAI, locked on-chain in a Python
intelligent contract, and resolved automatically after the deadline by reading
the web and asking an LLM (consensus via `gl.eq_principle.strict_eq`).

## Layout

- `bot/` — Node.js + TypeScript Telegram bot (grammY, genlayer-js, better-sqlite3, openai, viem)
  - `contracts/bet_market.py` — GenLayer Python intelligent contract (BetMarket)
  - `src/` — bot source
  - `data/` — SQLite + cached operator key + cached contract address (gitignored)
- `lib/`, `scripts/` — pre-existing workspace scaffolding (unused by the bot)

The `artifacts/` directory is empty — this project ships only the bot, no UI.

## Workflows

| Name | Command | Purpose |
| --- | --- | --- |
| Telegram Bot | `pnpm --filter @workspace/bot run dev` | Long-polling Telegram bot |

## Required env vars (already set)

- `TELEGRAM_BOT_TOKEN`
- `HOUSE_FEE_ADDRESS` (10 % cut destination)
- `HOUSE_FEE_BPS` (default `1000` = 10 %)
- `GENLAYER_NETWORK` (`testnet-asimov`)
- `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`
  (auto-set by Replit AI Integrations for bet parsing)

Optional:

- `OPERATOR_PRIVATE_KEY` — overrides the auto-generated operator wallet
- `BET_MARKET_ADDRESS` — skip auto-deploy and reuse an existing contract
- `SESSION_SECRET` — overrides the auto-generated AES-256-GCM key for user wallets

## First-run flow

1. Bot starts → generates operator wallet at `bot/data/.operator_key`.
2. Operator wallet must be funded via the Asimov faucet
   (`https://testnet-faucet.genlayer.foundation`).
3. On next start the bot deploys `bot/contracts/bet_market.py`,
   caches the contract address in SQLite, and starts serving.

## Telegram setup

After creating the bot via @BotFather, **disable Privacy Mode** so the bot can
read group messages: `/mybots → Bot Settings → Group Privacy → Turn off`.

## Recent changes

- 2026-04-29 — Initial scaffold: BetMarket contract, full bot, auto-deploy,
  per-user encrypted wallets, OpenAI parser, group + DM handlers, README.
- Removed unused `artifacts/api-server` and `artifacts/mockup-sandbox` (not used by this project).
