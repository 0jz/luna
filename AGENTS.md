# AGENTS.md — CulturSync Luna

Telegram bot (Telegraf + Claude) that prices UGC campaigns, escrows payment on Solana devnet via an Anchor program, and delivers creative + Kling video.

## Commands
- Install: `npm install`
- Build: `npm run build` (`tsc` → `dist/`)
- Run: `npm start` (`node dist/index.js`) — build first; there is no ts-node.
- Watch-compile: `npm run dev` (`tsc --watch`; does not run the bot)
- Anchor program: `anchor build`, `anchor deploy --provider.cluster devnet`
- Tests / lint: none configured for the bot. `Anchor.toml` maps `test` to `cargo test`; no tests are written.

## Where logic lives
- `src/index.ts` — everything (~1600 lines): env/config (top ~lines 93–121), Claude prompts, campaign state machine (`CampaignState.stage`), Solana Pay + escrow transaction builders, HTTP checkout server (`/pay`, `/release`, `/api/escrow/open`, `/api/escrow/release`), Kling/fal video, Telegram commands (bottom of file).
- `programs/luna_escrow/src/lib.rs` — Anchor program; `declare_id!` must match `Anchor.toml` and `ESCROW_PROGRAM_ID`.
- Instruction discriminators are computed in TS (`anchorDiscriminator('mark_delivered')`); renaming an instruction in Rust breaks the bot.

## Conventions
- CommonJS TypeScript, `strict: true`, target ES2016.
- Required env: `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `LUNA_WALLET_ADDRESS` (bot throws at startup if missing). Everything else has a default or disables a feature.
- Default model `claude-sonnet-4-5-20250929` (override with `ANTHROPIC_MODEL`).
- State is an in-memory `Map` keyed by Telegram user id.

## Do not touch / commit
- `.env` / `.env.*` (gitignored except `.env.example`).
- The keypair file at `LUNA_CREATOR_KEYPAIR_PATH` and `~/.config/solana/id.json`.
- `target/`, `.anchor/`, `dist/` (build output, gitignored).

## Gotchas
- Escrow checkout requires `PUBLIC_BASE_URL` (HTTPS tunnel) **and** `ESCROW_PROGRAM_ID`; otherwise the server isn't started and payments fall back to a plain Solana Pay transfer.
- `/approve` silently skips on-chain `mark_delivered` if `LUNA_CREATOR_KEYPAIR_PATH` is unset; the keypair must match `LUNA_WALLET_ADDRESS`.
- Video: official Kling credentials take priority over `FAL_KEY`.
- Error replies mention `bot.err.log`, but the code doesn't create it — it's whatever stderr was redirected to.

Humans: see README.md
