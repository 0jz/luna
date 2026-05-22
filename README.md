# Luna Hackathon Demo

Luna is an autonomous marketing agent for creator campaigns. A company sends a product link, campaign budget, and deliverables in Telegram. Luna evaluates fit, negotiates the offer, protects the creator from unpaid creative work, and opens a Solana devnet escrow before revealing final hooks, captions, shot list, voiceover, and video generation prompts.

## Demo Flow

1. Start the bot with `/start`.
2. Send a normal outreach message:
   `Merit Great Skin Instant Glow Serum product: https://www.sephora.com/product/merit-great-skin-instant-glow-serum-with-niacinamide-hyaluronic-acid-P502966 | budget $80 | need 1 reel only | usage organic only | escrow on Solflare devnet`
3. Luna analyzes the offer and returns a strategy preview plus teaser hooks.
4. Negotiate with `/offer 100` or accept with `/accept`.
5. Luna sends a Solflare devnet escrow link.
6. Sign the transaction and paste `/confirm TX_SIGNATURE`.
7. Luna unlocks final deliverables.
8. Send `/video` to get the handoff prompt for Artlist / Runway / Veo.
9. Send `/approve` to simulate release after delivery.

## Smart Contract Escrow

The Anchor program in `programs/luna_escrow` models the production escrow:

- `open_campaign`: brand locks campaign funds in escrow.
- `mark_delivered`: Luna marks that deliverables are ready.
- `approve_and_release`: brand approves and funds release to Luna.
- `refund_after_deadline`: brand can recover funds if delivery/approval rules fail.
- `dispute`: brand flags manual review.

The bot supports two modes:

- Smart-contract mode: set `ESCROW_PROGRAM_ID` and `PUBLIC_BASE_URL`. Luna sends a Solana Pay transaction-request link that builds an `open_campaign` instruction for Solflare devnet.
- Fallback mode: if the program is not deployed yet, Luna sends a direct Solflare devnet payment link and verifies the onchain transaction before unlocking deliverables.

## Env

Copy `.env.example` to `.env` and fill in:

```env
TELEGRAM_BOT_TOKEN=...
ANTHROPIC_API_KEY=...
SOLANA_RPC_URL=https://api.devnet.solana.com
LUNA_WALLET_ADDRESS=...
REVIEW_FEE_SOL=0.01
ESCROW_SOL=0.05
ANTHROPIC_MODEL=claude-sonnet-4-20250514
ESCROW_PROGRAM_ID=
PUBLIC_BASE_URL=
TRANSACTION_REQUEST_PORT=3001
```

For local smart-contract Solana Pay testing, expose port `3001` with a tunnel such as ngrok and set `PUBLIC_BASE_URL` to the HTTPS tunnel URL.

## Why This Fits The Marketing Agent Track

Luna markets a service and brings in clients: she handles inbound sponsorship outreach, evaluates campaign fit, writes counteroffers, and moves accepted deals into escrow.

Luna sells a product by testing what works: she generates preview hooks and, after escrow, full creative packages with captions, shot lists, voiceover, and image/video prompts.

Luna grows an audience and turns attention into revenue: she protects creator trust by refusing bad-fit products and only monetizing campaigns that fit the audience.

The AI is load-bearing because Luna has to reason about product fit, audience fit, safety, scope, pricing, creative angles, and negotiation. The chain is not the pitch; it is the trust layer that lets a brand pay an autonomous agent without giving the agent unconditional control of funds.
