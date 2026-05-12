# Genbet - AI-resolved Telegram betting on GenLayer

Genbet lets Telegram groups create peer-to-peer YES/NO bets that escrow and settle on GenLayer. Users talk to the bot in a group, confirm a bet, another user accepts the other side, and the contract resolves the outcome after the deadline using web evidence plus GenLayer validator consensus.

## What It Does

- Parses natural-language bet proposals from Telegram group messages.
- Creates one wallet per Telegram user and checks their Bradbury GEN balance.
- Locks the creator stake with `create_bet`.
- Lets another user match the stake with `accept_bet`.
- Resolves the bet after the deadline with `resolve`.
- Supports typed crypto price bets through Coinbase candle data.
- Supports structured sports and public-news/political bets with category-specific settlement rules.
- Pays the winner, or refunds both sides when the result is unclear or both active bettors agree to cancel.

## How Settlement Works

1. A user tags the bot in a group with a claim, stake, and deadline.
2. The bot asks the creator to confirm before staking.
3. `create_bet` locks the creator stake in the GenLayer contract.
4. Another user accepts and `accept_bet` locks the matching stake.
5. After the deadline, `/resolve <id>` asks the contract to settle the claim.
6. Crypto price bets use Coinbase 1-minute candles when the claim has a clear trigger such as `BTC touches 80500`.
7. Sports bets encode the event, picked side, and settlement rule. If the match is still live, delayed, in extra time/penalties, or not officially final, the contract returns `PENDING` and keeps the bet active.
8. Public-news/political bets encode a concrete claim, deadline, and settlement rule. The contract uses a short post-deadline source-update buffer before trying to settle.
9. Other supported public-fact bets fetch evidence from the creator's source URL when provided, otherwise they search the web.
10. A GenLayer resolver returns `YES`, `NO`, `PENDING`, or `UNCLEAR`, and validators compare the verdict through GenLayer consensus.
11. `YES` or `NO` pays the winning side 90 percent of the pot and sends 10 percent to the house wallet.
12. `PENDING` does not pay or refund; anyone can retry `/resolve <id>` later.
13. `UNCLEAR` refunds both bettors with no house fee.
14. Payout/refund messages are queued by the contract at resolution/cancellation time, then the GEN transfer lands after the GenLayer transaction successfully finalizes on Bradbury.

## Refunds And Cancellations

- Before creator confirmation: the Telegram proposal can be cancelled without any on-chain action.
- After creator confirmation but before acceptance: the creator can cancel and the contract refunds their stake.
- After acceptance: either bettor can run `/refund <id>` to request a mutual refund.
- The active bet only cancels after the other bettor also runs `/refund <id>`.
- After the deadline, `/resolve <id>` settles normally.

This is the same basic shape used by GenLayer claim-market projects such as Proven: claim creation, escrow, evidence sourcing, AI judgment, validator agreement, then on-chain settlement.

## Why It Stays GenLayer-native

The settlement decision is made inside the GenLayer intelligent contract, not by the Telegram bot. The bot only prepares user actions and sends transactions. Funds are escrowed by the contract, and final payout/refund logic runs on-chain.

## Network

The default network is Bradbury:

```env
GENLAYER_NETWORK=testnet-bradbury
BET_MARKET_ADDRESS=0xD1cE92a23F0F6114a39B13E01808967025CA1afE
```

The submission contract is pinned to `0xD1cE92a23F0F6114a39B13E01808967025CA1afE` on Bradbury. Keep `BET_MARKET_ADDRESS` set when deploying so the hosted bot uses the known working contract instead of deploying a new one.

The bot also caches the deployed contract address in SQLite under `settings.contract_address` and may use `data/.contract_address` for older runs.

Do not clear the cache or remove `BET_MARKET_ADDRESS` while users still care about active bets on the current contract. A redeploy starts a new contract with its own bet IDs.

## Commands

- `/start` - show wallet, network, contract, and usage.
- `/wallet` - show your generated wallet and balance.
- `/deposit` - show funding instructions.
- `/withdraw <address> <amount|all>` - move free GEN out of your bot wallet.
- `/exportwallet` - DM-only wallet private-key backup.
- `/importwallet <private_key> CONFIRM` - DM-only wallet restore.
- `/mybets` - show your open/active bets in the current group.
- `/mybetsall` - show your full bet history across all groups.
- `/openbets` - show bets waiting for an opponent.
- `/leaderboard` - show resolved-bet winners.
- `/refund <id>` - cancel an open bet or request mutual refund on an active bet.
- `/resolve <id>` - settle an active bet after its deadline.
- `/status <id>` - show bet state and tracked transaction finality.
- `/contract` - show the active contract address.

## Development

Install dependencies from the repo root:

```bash
pnpm install
```

Run the bot:

```bash
pnpm --filter @workspace/bot run start
```

Run TypeScript validation:

```bash
pnpm --filter @workspace/bot run typecheck
```

Compile-check the contract:

```bash
python -m py_compile bot\contracts\bet_market.py
```

## Known Testnet Behavior

Bradbury can take several minutes to accept and finalize transactions, especially resolver transactions that trigger validator work. Explorer indexing can lag behind the actual chain state. Always treat the contract read state as the source of truth.

Payouts are not immediate at `resolve` time. The contract emits the winner/refund/house transfer messages, but balances move only after the transaction reaches successful finalization. The bot should describe this as "payout queued until finality" instead of "paid instantly."

Transactions from the same wallet can queue behind each other at the chain nonce/RPC layer. One user's queued transaction should not stop the Telegram bot from responding, but a second transaction from the same wallet may wait behind the first one.

## Wallet Persistence

User private keys are stored in SQLite under `DATA_DIR`. On Railway, attach a Volume and mount it to the same path used by `DATA_DIR`, for example `/app/bot/data`. Without a volume, Railway redeploys can lose SQLite data and create new wallets.

Set a stable `SESSION_SECRET` and preferably `WALLET_SEED_SECRET` in hosting variables. Existing wallets from SQLite still take priority, but new wallets can be regenerated from the stable seed if the database is lost.

Users can run `/exportwallet` in a private DM to back up their private key. `/withdraw <address> <amount|all>` moves free wallet balance out of the bot wallet. Funds currently locked in active/open bets remain controlled by the GenLayer contract until cancel/resolve finality.

## Status Tracking

The bot records GenLayer transaction hashes for bet creation, acceptance, cancellation, refund requests, and resolution in SQLite. A background watcher polls those transactions and posts a Telegram update when a tracked transaction finalizes. Users can also run `/status <id>` to see the current bet state and the known transaction finality state.

If a transaction is accepted but the bet is still active, inspect the transaction hash and triggered validator transactions. If the contract code changed locally after deployment, the existing on-chain contract will not pick up that change; clear the contract cache and redeploy for new tests.

## Security Model

This is testnet software. The bot stores generated wallet keys locally in SQLite, so do not run it with real funds. Keep `.env` private and never commit bot tokens, API keys, or private keys.
