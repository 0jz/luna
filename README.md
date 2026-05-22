# CulturSync Luna

Autonomous AI marketing agent that turns product briefs into escrow-backed UGC campaigns and TikTok-style ad creatives.

Luna is the execution agent inside CulturSync. A brand sends a product link, budget, target markets, and deliverables in Telegram. Luna evaluates campaign fit, negotiates the offer, protects the creative work behind escrow, generates campaign assets, and can render a short product showcase video with Kling.

For the hackathon demo, Solana is intentionally under the hood: the user sees a Solflare checkout page, while the bot builds and verifies devnet escrow transactions.

## What It Demonstrates

- Autonomous campaign evaluation and pricing.
- Preview-first strategy so brands cannot take the full idea before payment.
- Solana devnet escrow before final deliverables are unlocked.
- Real onchain release flow after brand approval.
- AI-generated hooks, captions, shot list, creator direction, image prompt, and video prompt.
- Optional Kling API rendering for a silent TikTok-style product showcase.

## Demo Flow

1. Start the bot:
   ```text
   /start
   ```

2. Run the prepared demo brief:
   ```text
   /demo
   ```

   The demo product is Merit Great Skin Instant Glow Serum from Sephora, with one reel as the requested deliverable.

3. Luna returns a strategy preview with fit score, risks, teaser hooks, and quote.

4. Accept the deal:
   ```text
   /accept
   ```

5. Open the Solflare devnet escrow page, fund escrow, then paste:
   ```text
   /confirm YOUR_ESCROW_TX_SIGNATURE
   ```

6. Luna unlocks final campaign deliverables and marks delivery onchain.

7. Generate the video preview:
   ```text
   /video
   ```

8. After the brand accepts the video, approve release:
   ```text
   /approve
   ```

9. Open the release page, sign with Solflare, then paste:
   ```text
   /confirmrelease YOUR_RELEASE_TX_SIGNATURE
   ```

## Why Trust It With Money?

Luna gets paid for accepted work, not promises.

```text
Brief -> Escrow -> Campaign + Video -> Brand Approval -> Payout
```

In the demo, escrow uses devnet SOL. In production, the same flow would use USDC escrow on Solana so a negotiated price, for example 180 USDC, is released only after the brand approves delivery.

## Main Commands

```text
/start              Introduce Luna and show the demo input format
/demo               Run the prepared Sephora/Merit serum demo brief
/accept             Accept Luna's quote and receive escrow instructions
/confirm <tx>       Verify the escrow funding transaction
/video              Generate a structured video brief and call Kling if configured
/approve            Create the Solflare release transaction link
/confirmrelease <tx> Verify escrow release on devnet
/status             Show current campaign state
/debug              Show lightweight local debug state
```

## Local Setup

Install dependencies:

```bash
npm install
```

Copy the environment template:

```bash
cp .env.example .env
```

Fill in the required values:

```env
TELEGRAM_BOT_TOKEN=...
ANTHROPIC_API_KEY=...
SOLANA_RPC_URL=https://api.devnet.solana.com
LUNA_WALLET_ADDRESS=...
REVIEW_FEE_SOL=0.01
ESCROW_SOL=0.05
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929
ESCROW_PROGRAM_ID=
PUBLIC_BASE_URL=
TRANSACTION_REQUEST_PORT=3001
KLING_ACCESS_KEY=
KLING_SECRET_KEY=
KLING_BASE_URL=https://api.klingai.com
KLING_MODEL_NAME=kling-v2-6
KLING_MODE=pro
KLING_ENABLE_AUDIO=false
KLING_DURATION_SECONDS=5
LUNA_CREATOR_KEYPAIR_PATH=
```

Build and run:

```bash
npm run build
npm start
```

For Solflare checkout testing, expose port `3001` with ngrok or another HTTPS tunnel, then set `PUBLIC_BASE_URL` to that tunnel URL.

## Solana Program

The Anchor program lives in `programs/luna_escrow`.

Instructions:

- `open_campaign`: brand locks campaign funds in escrow.
- `mark_delivered`: Luna marks that deliverables are ready.
- `approve_and_release`: brand approves and releases funds to Luna.
- `refund_after_deadline`: brand can recover funds after the approval window.
- `dispute`: brand flags manual review.

Build with Anchor:

```bash
anchor build
```

Deploy to devnet:

```bash
anchor deploy --provider.cluster devnet
```

## Hackathon Positioning

Luna fits the Marketing Agent track because she does more than generate content. She handles the business loop around campaign work: intake, evaluation, negotiation, escrow, delivery, video generation, approval, and release.

The next production step is acquisition. After approval, the brand could connect a Meta account, reserve part of the campaign budget as ad spend, and let Luna launch the approved reel as a paid campaign, track performance, and suggest the next creative test.
