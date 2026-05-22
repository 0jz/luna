import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { createHash, createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { Telegraf } from 'telegraf';

type DealStage =
  | 'IDLE'
  | 'AWAITING_REVIEW_FEE'
  | 'PREVIEW_READY'
  | 'NEGOTIATING'
  | 'AWAITING_ESCROW'
  | 'DELIVERED'
  | 'AWAITING_RELEASE'
  | 'APPROVED'
  | 'RELEASED';

type CampaignState = {
  stage: DealStage;
  brief?: string;
  productImageFileId?: string;
  reviewPaid?: boolean;
  escrowPaid?: boolean;
  quotedPriceUsd?: number;
  acceptedPriceUsd?: number;
  preview?: CampaignPreview;
  delivery?: CampaignDelivery;
  lastTxSignature?: string;
  reviewReference?: string;
  escrowReference?: string;
  escrowMode?: 'direct' | 'program';
  escrowPda?: string;
  brandWallet?: string;
  deliveredOnchain?: boolean;
  releaseTxSignature?: string;
};

type CampaignPreview = {
  fit_score: number;
  decision: 'ACCEPT' | 'REJECT' | 'COUNTER';
  fit_reasoning: string;
  brand_safety_notes: string;
  recommended_format: string;
  strategy_preview: string;
  preview_hooks: string[];
  hidden_until_escrow: string[];
  quote_usd: number;
  counteroffer_reasoning: string;
};

type VideoBrief = {
  selected_market: string;
  localized_idea: string;
  production_status: 'WIP_NEEDS_GENAI_MODEL';
  recommended_tool: 'Artlist AI Suite';
  recommended_model: string;
  aspect_ratio: '9:16';
  duration_seconds: number;
  input_assets: {
    product_image_required: boolean;
    voiceover_required: boolean;
    music_required: boolean;
  };
  image_prompt: string;
  video_prompt: string;
  voiceover_script: string;
  caption: string;
  style_notes: string[];
  negative_prompt: string;
  after_render_steps: string[];
};
type CampaignDelivery = {
  hooks: string[];
  caption: string;
  cta: string;
  shot_list: string[];
  voiceover_script: string;
  image_prompt: string;
  video_prompt: string;
  creator_direction: string;
};

const requiredEnv = ['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'LUNA_WALLET_ADDRESS'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`Missing ${key}. Copy .env.example to .env and fill it in.`);
  }
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', 'confirmed');
const lunaWallet = new PublicKey(process.env.LUNA_WALLET_ADDRESS!);
const reviewFeeSol = Number(process.env.REVIEW_FEE_SOL || '0.01');
const escrowSol = Number(process.env.ESCROW_SOL || '0.05');
const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
const escrowProgramId = process.env.ESCROW_PROGRAM_ID ? new PublicKey(process.env.ESCROW_PROGRAM_ID) : undefined;
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
const transactionRequestPort = Number(process.env.TRANSACTION_REQUEST_PORT || '3001');
const falKey = process.env.FAL_KEY;
const falKlingTextEndpoint = process.env.FAL_KLING_TEXT_ENDPOINT || 'https://fal.run/fal-ai/kling-video/v2.6/pro/text-to-video';
const falKlingImageEndpoint = process.env.FAL_KLING_IMAGE_ENDPOINT || 'https://fal.run/fal-ai/kling-video/v2.6/pro/image-to-video';
const videoStartImageUrl = process.env.VIDEO_START_IMAGE_URL;
const klingAccessKey = process.env.KLING_ACCESS_KEY;
const klingSecretKey = process.env.KLING_SECRET_KEY;
const klingBaseUrl = (process.env.KLING_BASE_URL || 'https://api.klingai.com').replace(/\/$/, '');
const klingModelName = process.env.KLING_MODEL_NAME || 'kling-v2-6';
const klingMode = (process.env.KLING_MODE || 'pro').toLowerCase() === 'std' ? 'std' : 'pro';
const klingEnableAudio = process.env.KLING_ENABLE_AUDIO === 'true';
const klingDurationSeconds = process.env.KLING_DURATION_SECONDS || '5';
const creatorKeypairPath = process.env.LUNA_CREATOR_KEYPAIR_PATH;
const states = new Map<number, CampaignState>();
const demoBrief = 'Merit Great Skin Instant Glow Serum product: https://www.sephora.com/product/merit-great-skin-instant-glow-serum-with-niacinamide-hyaluronic-acid-P502966 | markets: US, Japan, Brazil | budget $80 | need 1 reel only | usage organic only | escrow on Solflare devnet';

function getState(userId: number): CampaignState {
  const existing = states.get(userId);
  if (existing) return existing;
  const next: CampaignState = { stage: 'IDLE' };
  states.set(userId, next);
  return next;
}

function money(amount: number): string {
  return `$${amount.toFixed(0)}`;
}

function createPaymentReference(): string {
  return Keypair.generate().publicKey.toBase58();
}

function loadCreatorKeypair(): Keypair | undefined {
  if (!creatorKeypairPath) return undefined;
  const secret = JSON.parse(readFileSync(creatorKeypairPath, 'utf8')) as number[];
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
  if (!keypair.publicKey.equals(lunaWallet)) {
    throw new Error(`LUNA_CREATOR_KEYPAIR_PATH belongs to ${keypair.publicKey.toBase58()}, but LUNA_WALLET_ADDRESS is ${lunaWallet.toBase58()}.`);
  }
  return keypair;
}

function solanaPayLink(amountSol: number, purpose: string, reference: string): string {
  const params = new URLSearchParams({
    amount: amountSol.toString(),
    reference,
    label: 'CulturSync AI',
    message: `${purpose} for CulturSync campaign escrow`,
    memo: `Luna ${purpose}`,
  });

  return `solana:${lunaWallet.toBase58()}?${params.toString()}`;
}


function briefHash(brief: string): Buffer {
  return createHash('sha256').update(brief).digest();
}

function escrowSeedHash(state: CampaignState): Buffer {
  return briefHash(`${state.brief || 'No brief provided.'}|escrow:${state.escrowReference || 'no-reference'}`);
}

function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function writeU64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function writeI64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(BigInt(value));
  return buffer;
}

function escrowDeadlineSeconds(): number {
  return Math.floor(Date.now() / 1000) + 48 * 60 * 60;
}

function escrowPdaFor(brand: PublicKey, hash: Buffer): PublicKey {
  if (!escrowProgramId) throw new Error('ESCROW_PROGRAM_ID is not configured.');
  return PublicKey.findProgramAddressSync(
    [Buffer.from('campaign'), brand.toBuffer(), hash],
    escrowProgramId,
  )[0];
}

function smartContractEscrowLink(chatId: number): string | undefined {
  if (!publicBaseUrl || !escrowProgramId) return undefined;
  const params = new URLSearchParams({ chatId: chatId.toString() });
  return `${publicBaseUrl}/pay?${params.toString()}`;
}

function smartContractReleaseLink(chatId: number): string | undefined {
  if (!publicBaseUrl || !escrowProgramId) return undefined;
  const params = new URLSearchParams({ chatId: chatId.toString() });
  return `${publicBaseUrl}/release?${params.toString()}`;
}

function hasSmartContractEscrow(): boolean {
  return Boolean(publicBaseUrl && escrowProgramId);
}
function paymentText(amountSol: number, purpose: string, reference: string): string {
  return [
    `${purpose}`,
    '',
    `Open this Solana Pay link in Solflare while your wallet is on devnet:`,
    solanaPayLink(amountSol, purpose, reference),
    '',
    `Amount: ${amountSol} devnet SOL`,
    `Recipient: ${lunaWallet.toBase58()}`,
    `Reference: ${reference}`,
    '',
    'After signing, send:',
    '/confirm YOUR_TRANSACTION_SIGNATURE',
    '',
    'Manual fallback: send the same amount to the recipient address above, then paste the transaction signature. For production this becomes USDC escrow under the hood.',
  ].join('\n');
}

function escrowPaymentText(state: CampaignState, chatId: number): string {
  const contractLink = smartContractEscrowLink(chatId);
  if (contractLink && escrowProgramId) {
    state.escrowMode = 'program';
    return [
      'Campaign escrow - Solana smart contract',
      '',
      'Open this web checkout page. It connects to the Solflare browser extension, builds the smart-contract escrow transaction, and sends it on devnet:',
      contractLink,
      '',
      `Amount locked: ${escrowSol} devnet SOL`,
      `Escrow program: ${escrowProgramId.toBase58()}`,
      '',
      'After signing, send:',
      '/confirm YOUR_TRANSACTION_SIGNATURE',
      '',
      'The page opens a campaign escrow account in the CulturSync smart contract. CulturSync/Luna only generates the full campaign after this onchain escrow transaction is confirmed.',
    ].join('\n');
  }

  state.escrowMode = 'direct';
  return [
    paymentText(escrowSol, 'Campaign escrow - Solflare devnet fallback', state.escrowReference!),
    '',
    'Smart-contract mode is available when ESCROW_PROGRAM_ID and PUBLIC_BASE_URL are configured. For the hackathon fallback, this still proves a live devnet payment before Luna unlocks delivery.',
  ].join('\n');
}
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model output.');
  }
  return JSON.parse(raw.slice(start, end + 1));
}

async function askJson<T>(system: string, user: string, retry = true): Promise<T> {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 1800,
    temperature: 0.7,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  try {
    return extractJson(text) as T;
  } catch (error) {
    console.error('JSON parse failed:', error, text);
    if (!retry) throw error;
    return askJson<T>(
      system,
      `${user}\n\nYour previous answer was not valid JSON. Return only valid JSON with no markdown.`,
      false,
    );
  }
}

function fallbackPreview(brief: string): CampaignPreview {
  const budgetMatch = brief.match(/\$\s*(\d+)/);
  const budget = budgetMatch ? Number(budgetMatch[1]) : 80;
  const quote = Math.max(90, Math.round(budget * 1.4));

  return {
    fit_score: 7,
    decision: budget >= quote * 0.85 ? 'ACCEPT' : 'COUNTER',
    fit_reasoning: 'Fallback analysis: the brief has enough campaign context to continue the demo, but CulturSync would normally enrich this with live AI cultural reasoning.',
    brand_safety_notes: 'Avoid medical guarantees, before/after claims, and exaggerated performance promises. Keep the campaign creator-native and trust-first.',
    recommended_format: '1 short-form reel + 2 story frames',
    strategy_preview: 'Position the product with market-aware messaging. Keep the preview high-level before escrow so the brand sees the CulturSync strategy without receiving the full creative package.',
    preview_hooks: [
      'I almost skipped this, but it fixed the one part of my routine I kept ignoring.',
      'If your routine is doing too much, this is the reset I would test first.',
      'This is for the days when you want the result without the 10-step ritual.',
    ],
    hidden_until_escrow: ['final hooks', 'caption', 'shot list', 'voiceover', 'video production prompt'],
    quote_usd: quote,
    counteroffer_reasoning: `The proposed budget looks like ${money(budget)}. CulturSync/Luna would counter near ${money(quote)} to cover creative strategy, usage rights, and production-ready deliverables.`,
  };
}

function normalizePreview(preview: CampaignPreview, brief: string): CampaignPreview {
  const fallback = fallbackPreview(brief);
  return {
    ...fallback,
    ...preview,
    preview_hooks: Array.isArray(preview.preview_hooks) && preview.preview_hooks.length > 0
      ? preview.preview_hooks
      : fallback.preview_hooks,
    hidden_until_escrow: Array.isArray(preview.hidden_until_escrow) && preview.hidden_until_escrow.length > 0
      ? preview.hidden_until_escrow
      : fallback.hidden_until_escrow,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}
async function createPreview(brief: string): Promise<CampaignPreview> {
  console.log('Creating strategy preview for brief:', brief);
  return askJson<CampaignPreview>(
    [
      'You are CulturSync AI, an autonomous global marketing agent. Luna is your execution agent for creator campaign negotiation, escrow, and final creative delivery.',
      'You protect market fit, cultural relevance, brand trust, creator economics, and the client relationship.',
      'You can work across niches and countries. Evaluate product fit, cultural fit, safety, scope, budget, usage rights, and delivery risk. If markets are provided, adapt the strategy by market using cultural reasoning.',
      'PREVIEW MODE: research the product from the brief/link context, then reveal only 3 short preview hooks. Do not reveal full captions, scripts, shot lists, or exact execution details.',
      'If the budget is too low, decision should be COUNTER and quote_usd should be a fair counteroffer.',
      'Return only valid JSON matching the requested schema.',
    ].join('\n'),
    [
      'Evaluate this brand campaign brief after the paid review fee.',
      '',
      brief,
      '',
      'Return JSON:',
      '{',
      '  "fit_score": 8,',
      '  "decision": "ACCEPT" | "REJECT" | "COUNTER",',
      '  "fit_reasoning": "short explanation",',
      '  "brand_safety_notes": "claim, trust, or category risks",',
      '  "recommended_format": "reel/story/post/bundle",',
      '  "strategy_preview": "high-level angle and product research summary",',
      '  "preview_hooks": ["short teaser hook 1", "short teaser hook 2", "short teaser hook 3"],',
      '  "hidden_until_escrow": ["final hooks", "caption", "shot list", "voiceover", "video production prompt"],',
      '  "quote_usd": 120,',
      '  "counteroffer_reasoning": "why the price/scope is fair"',
      '}',
    ].join('\n'),
  );
}

async function createDelivery(brief: string, preview: CampaignPreview): Promise<CampaignDelivery> {
  console.log('Creating final campaign deliverables.');
  return askJson<CampaignDelivery>(
    [
      'You are CulturSync AI, an autonomous global marketing agent. Luna is your execution agent for creator campaign negotiation, escrow, and final creative delivery.',
      'DELIVERY MODE: escrow is confirmed, so you may reveal the full creative package.',
      'Generate practical UGC deliverables for a short-form social campaign.',
      'Keep the tone creator-native: specific, credible, not overhyped, not too salesy.',
      'Avoid unsafe medical, financial, or guaranteed-result claims.',
      'Return only valid JSON matching the schema.',
    ].join('\n'),
    [
      'Campaign brief:',
      brief,
      '',
      'Approved preview:',
      JSON.stringify(preview),
      '',
      'Return JSON:',
      '{',
      '  "hooks": ["hook 1", "hook 2", "hook 3"],',
      '  "caption": "Instagram/TikTok caption",',
      '  "cta": "call to action",',
      '  "shot_list": ["scene 1", "scene 2", "scene 3"],',
      '  "voiceover_script": "15-25 second voiceover",',
      '  "image_prompt": "prompt for product/lifestyle ad image generator",',
      '  "video_prompt": "prompt for image-to-video generator",',
      '  "creator_direction": "tone, pacing, creator performance notes"',
      '}',
    ].join('\n'),
  );
}

async function verifyPayment(signature: string, expectedSol: number, expectedReference?: string): Promise<boolean> {
  console.log(`Verifying payment ${signature} for ${expectedSol} SOL.`);
  const tx = await connection.getParsedTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (!tx || tx.meta?.err) return false;

  const expectedLamports = Math.round(expectedSol * LAMPORTS_PER_SOL);
  const accountKeys = tx.transaction.message.accountKeys;
  const lunaIndex = accountKeys.findIndex((account) => account.pubkey.equals(lunaWallet));
  if (lunaIndex < 0 || !tx.meta?.preBalances || !tx.meta?.postBalances) return false;

  if (expectedReference) {
    const referenceKey = new PublicKey(expectedReference);
    const hasReference = accountKeys.some((account) => account.pubkey.equals(referenceKey));
    if (!hasReference) {
      console.warn(`Payment amount matched, but reference ${expectedReference} was not found in tx ${signature}.`);
    }
  }

  const receivedLamports = tx.meta.postBalances[lunaIndex] - tx.meta.preBalances[lunaIndex];
  return receivedLamports >= expectedLamports;
}

async function replyLong(ctx: { reply: (message: string) => Promise<unknown> }, message: string): Promise<void> {
  const maxLength = 3500;
  const sections = message.split('\n\n');
  let chunk = '';

  for (const section of sections) {
    const next = chunk ? `${chunk}\n\n${section}` : section;
    if (next.length > maxLength && chunk) {
      await ctx.reply(chunk);
      chunk = section;
    } else {
      chunk = next;
    }
  }

  if (chunk) {
    while (chunk.length > maxLength) {
      await ctx.reply(chunk.slice(0, maxLength));
      chunk = chunk.slice(maxLength);
    }
    if (chunk) await ctx.reply(chunk);
  }
}
function formatPreview(preview: CampaignPreview): string {
  return [
    '*CulturSync Strategy Preview*',
    '',
    `*Decision:* ${preview.decision}`,
    `*Fit score:* ${preview.fit_score}/10`,
    `*Recommended format:* ${preview.recommended_format}`,
    `*Quote:* ${money(preview.quote_usd)}`,
    '',
    '*Reasoning*',
    preview.fit_reasoning,
    '',
    '*Brand safety*',
    preview.brand_safety_notes,
    '',
    '*Product research + angle*',
    preview.strategy_preview,
    '',
    '*Preview hooks*',
    preview.preview_hooks.map((hook, index) => `${index + 1}. ${hook}`).join('\n'),
    '',
    '*Hidden until escrow*',
    preview.hidden_until_escrow.map((item) => `- ${item}`).join('\n'),
    '',
    '*Counteroffer logic*',
    preview.counteroffer_reasoning,
  ].join('\n');
}

function extractMarkets(brief?: string): string[] {
  if (!brief) return ['US', 'Japan', 'Brazil'];
  const match = brief.match(/markets?\s*:\s*([^|]+)/i);
  if (!match) return ['US', 'Japan', 'Brazil'];
  return match[1]
    .split(/,|\/| and /i)
    .map((market) => market.trim())
    .filter(Boolean);
}

type FalVideoResult = {
  video?: {
    url?: string;
    content_type?: string;
    file_name?: string;
  };
};

type KlingVideo = {
  url?: string;
  duration?: string;
  id?: string;
};

type KlingTaskResponse = {
  code?: number;
  message?: string;
  task_id?: string;
  id?: string;
  status?: string;
  task_status?: string;
  task_status_msg?: string;
  video?: {
    url?: string;
  };
  data?: {
    task_id?: string;
    task_status?: string;
    task_status_msg?: string;
    task_result?: {
      videos?: KlingVideo[];
      video?: {
        url?: string;
      };
    };
    videos?: KlingVideo[];
    video?: {
      url?: string;
    };
  };
};

function hasKlingOfficialCredentials(): boolean {
  return Boolean(klingAccessKey && klingSecretKey);
}

function hasAutomaticVideoRenderer(): boolean {
  return hasKlingOfficialCredentials() || Boolean(falKey);
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createKlingJwt(): string {
  if (!klingAccessKey || !klingSecretKey) {
    throw new Error('KLING_ACCESS_KEY and KLING_SECRET_KEY are not configured.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: klingAccessKey,
    exp: now + 1800,
    nbf: now - 5,
  }));
  const signature = createHmac('sha256', klingSecretKey)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${header}.${payload}.${signature}`;
}

function buildVideoPrompt(videoBrief: VideoBrief): string {
  const prompt = [
    videoBrief.video_prompt,
    '',
    `Localized market: ${videoBrief.selected_market}`,
    `Localized idea: ${videoBrief.localized_idea}`,
    '',
    'TikTok-style vertical UGC ad, realistic phone footage, creator-native, not overproduced.',
  ];

  if (klingEnableAudio) {
    prompt.push(
      'Include natural creator voice, subtle room ambience, clean product handling sounds, and upbeat social ad pacing.',
      '',
      `Voiceover script: ${videoBrief.voiceover_script}`,
    );
  } else {
    prompt.push(
      'Silent product showcase: no spoken dialogue, no generated voiceover, no lip-sync. Focus on product close-ups, texture, hands applying the serum, natural phone-camera movement, and caption-safe visual storytelling.',
    );
  }

  return prompt.join('\n');
}

function extractKlingTaskId(result: KlingTaskResponse): string | undefined {
  return result.data?.task_id || result.task_id || result.id;
}

function extractKlingStatus(result: KlingTaskResponse): string | undefined {
  return result.data?.task_status || result.task_status || result.status;
}

function extractKlingError(result: KlingTaskResponse): string | undefined {
  return result.data?.task_status_msg || result.task_status_msg || result.message;
}

function extractKlingVideoUrl(result: KlingTaskResponse): string | undefined {
  return (
    result.data?.task_result?.videos?.[0]?.url ||
    result.data?.task_result?.video?.url ||
    result.data?.videos?.[0]?.url ||
    result.data?.video?.url ||
    result.video?.url
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Kling returned non-JSON response: ${response.status} ${body}`);
  }

  if (!response.ok) {
    throw new Error(`Kling API failed: ${response.status} ${body}`);
  }

  return parsed as T;
}

async function generateOfficialKlingVideo(videoBrief: VideoBrief): Promise<string> {
  const useImageToVideo = Boolean(videoStartImageUrl);
  const endpoint = useImageToVideo ? '/v1/videos/image2video' : '/v1/videos/text2video';
  const prompt = buildVideoPrompt(videoBrief);
  const token = createKlingJwt();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const payload: Record<string, unknown> = {
    model_name: klingModelName,
    prompt: useImageToVideo ? prompt : `${prompt}\n\nOpening frame / image direction: ${videoBrief.image_prompt}`,
    duration: klingDurationSeconds,
    aspect_ratio: '9:16',
    mode: klingMode,
    negative_prompt: videoBrief.negative_prompt,
    enable_audio: klingEnableAudio,
  };

  if (useImageToVideo) {
    payload.image = videoStartImageUrl;
  }

  console.log('Submitting Kling render', {
    endpoint,
    model_name: klingModelName,
    mode: klingMode,
    duration: klingDurationSeconds,
    enable_audio: klingEnableAudio,
    useImageToVideo,
  });

  const createResponse = await fetch(`${klingBaseUrl}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const created = await readJsonResponse<KlingTaskResponse>(createResponse);
  const immediateUrl = extractKlingVideoUrl(created);
  if (immediateUrl) return immediateUrl;

  const taskId = extractKlingTaskId(created);
  if (!taskId) {
    throw new Error(`Kling response did not include task_id: ${JSON.stringify(created)}`);
  }

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    await wait(10_000);
    const pollResponse = await fetch(`${klingBaseUrl}${endpoint}/${taskId}`, { headers });
    const statusResult = await readJsonResponse<KlingTaskResponse>(pollResponse);
    const status = extractKlingStatus(statusResult);
    console.log('Kling task status', { taskId, attempt, status });

    const videoUrl = extractKlingVideoUrl(statusResult);
    if (videoUrl) return videoUrl;

    if (status === 'failed' || status === 'error') {
      throw new Error(`Kling render failed: ${extractKlingError(statusResult) || JSON.stringify(statusResult)}`);
    }
  }

  throw new Error(`Kling render is still processing after 5 minutes. Task id: ${taskId}`);
}

async function generateKlingVideo(videoBrief: VideoBrief): Promise<string> {
  if (hasKlingOfficialCredentials()) {
    return generateOfficialKlingVideo(videoBrief);
  }

  if (!falKey) {
    throw new Error('No video renderer is configured. Add KLING_ACCESS_KEY + KLING_SECRET_KEY or FAL_KEY to .env.');
  }

  const useImageToVideo = Boolean(videoStartImageUrl);
  const endpoint = useImageToVideo ? falKlingImageEndpoint : falKlingTextEndpoint;
  const prompt = buildVideoPrompt(videoBrief);

  const payload = useImageToVideo
    ? {
        prompt,
        start_image_url: videoStartImageUrl,
        duration: klingDurationSeconds,
        negative_prompt: videoBrief.negative_prompt,
        generate_audio: klingEnableAudio,
      }
    : {
        prompt: `${prompt}\n\nOpening frame / image direction: ${videoBrief.image_prompt}`,
        duration: klingDurationSeconds,
        aspect_ratio: '9:16',
        negative_prompt: videoBrief.negative_prompt,
        cfg_scale: 0.5,
        generate_audio: klingEnableAudio,
      };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Kling render failed: ${response.status} ${body}`);
  }

  const result = JSON.parse(body) as FalVideoResult;
  const videoUrl = result.video?.url;
  if (!videoUrl) {
    throw new Error(`Kling response did not include a video URL: ${body}`);
  }

  return videoUrl;
}
function buildVideoBrief(state: CampaignState, selected: { market: string; idea: string }): VideoBrief {
  const delivery = state.delivery!;
  return {
    selected_market: selected.market,
    localized_idea: selected.idea,
    production_status: 'WIP_NEEDS_GENAI_MODEL',
    recommended_tool: 'Artlist AI Suite',
    recommended_model: `Kling ${klingModelName}, ${klingDurationSeconds}s, vertical 9:16, ${klingMode} mode${klingEnableAudio ? ', native audio enabled' : ''}.`,
    aspect_ratio: '9:16',
    duration_seconds: Number(klingDurationSeconds),
    input_assets: {
      product_image_required: true,
      voiceover_required: klingEnableAudio,
      music_required: false,
    },
    image_prompt: delivery.image_prompt,
    video_prompt: delivery.video_prompt,
    voiceover_script: delivery.voiceover_script,
    caption: delivery.caption,
    style_notes: [
      'Make it feel like a real creator filmed it on a phone, not like a polished TV ad.',
      'Use natural handheld motion, real skin texture, and soft imperfect lighting.',
      'Keep product visibility clear for at least one close-up shot.',
      `Localize the pacing and emotional tone for ${selected.market}.`,
      'No hard claims, no medical guarantees, no exaggerated before/after transformation.',
    ],
    negative_prompt: 'overly cinematic, luxury perfume commercial, plastic skin, heavy beauty filter, fake before and after, unreadable label, distorted hands, extra fingers, aggressive sales text, medical claims, unrealistic glow',
    after_render_steps: [
      'Generate the video in Kling using the product image and video prompt.',
      klingEnableAudio
        ? 'Use native audio so the rendered clip includes voice, ambience, and product handling sounds.'
        : 'Generate or upload the voiceover using the voiceover_script.',
      'Export the short vertical clip.',
      'Upload the rendered clip back to Telegram or save it as the campaign preview.',
      'Send /approve only after the brand accepts the rendered preview.',
    ],
  };
}
function pickVideoMarketIdea(brief?: string): { market: string; idea: string } {
  const markets = extractMarkets(brief);
  const market = markets[Math.floor(Math.random() * markets.length)] || 'US';
  const normalized = market.toLowerCase();

  if (normalized.includes('japan')) {
    return { market, idea: 'A calm morning ritual video built around trust, product texture, ingredient respect, and low-pressure proof rather than hype.' };
  }

  if (normalized.includes('brazil')) {
    return { market, idea: 'A warm lifestyle reel built around social glow, confidence, movement, and expressive creator energy.' };
  }

  if (normalized.includes('us') || normalized.includes('america')) {
    return { market, idea: 'A direct creator-style before-the-day-starts reel focused on visible outcome, simplicity, and personal confidence.' };
  }

  return { market, idea: `A localized creator reel tailored to ${market}, using CulturSync's market strategy and avoiding generic translation-only messaging.` };
}
function formatDelivery(delivery: CampaignDelivery): string {
  return [
    '*Final Campaign Deliverables*',
    '',
    '*Hooks*',
    delivery.hooks.map((hook, index) => `${index + 1}. ${hook}`).join('\n'),
    '',
    '*Caption*',
    delivery.caption,
    '',
    '*CTA*',
    delivery.cta,
    '',
    '*Shot list*',
    delivery.shot_list.map((shot, index) => `${index + 1}. ${shot}`).join('\n'),
    '',
    '*Voiceover script*',
    delivery.voiceover_script,
    '',
    '*Image prompt*',
    delivery.image_prompt,
    '',
    '*Video generation status*',
    'WIP: CulturSync has prepared the video brief, but rendering requires a connected GenAI video model such as Veo, Runway, Kling, or Artlist. For this demo, the prompt below is the handoff to that model.',
    '',
    '*Video prompt*',
    delivery.video_prompt,
    '',
    '*Creator direction*',
    delivery.creator_direction,
  ].join('\n');
}

function paymentPage(chatId: string, action: 'open' | 'release' = 'open'): string {
  const safeChatId = chatId.replace(/[^0-9]/g, '');
  const isRelease = action === 'release';
  const title = isRelease ? 'CulturSync Escrow Release' : 'CulturSync Escrow Checkout';
  const description = isRelease
    ? 'This page uses your Solflare browser extension to approve the delivered campaign and release the devnet escrow to the CulturSync/Luna creator agent.'
    : 'This page uses your Solflare browser extension to open the deployed CulturSync escrow contract on Solana devnet.';
  const buttonText = isRelease ? 'Connect Solflare and release escrow' : 'Connect Solflare and fund escrow';
  const endpoint = isRelease ? '/api/escrow/release' : '/api/escrow/open';
  const buildingText = isRelease ? 'Building release transaction...' : 'Building escrow transaction...';
  const doneText = isRelease
    ? 'Release transaction sent. Paste the command below into Telegram.'
    : 'Escrow transaction sent. Paste the command below into Telegram.';
  const command = isRelease ? '/confirmrelease ' : '/confirm ';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <script src="https://unpkg.com/@solana/web3.js@1.98.4/lib/index.iife.min.js"></script>
  <style>
    body { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #101216; color: #f5f7fb; }
    main { max-width: 680px; margin: 0 auto; padding: 48px 20px; }
    .panel { border: 1px solid #2b3039; border-radius: 8px; padding: 24px; background: #181b22; }
    h1 { font-size: 28px; margin: 0 0 12px; }
    p { color: #c9ced8; line-height: 1.55; }
    button { appearance: none; border: 0; border-radius: 6px; padding: 14px 18px; background: #8df0cc; color: #101216; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    code, pre { background: #0b0d11; border: 1px solid #303642; border-radius: 6px; color: #d9ffe9; }
    code { padding: 2px 5px; }
    pre { padding: 14px; overflow: auto; white-space: pre-wrap; }
    .ok { color: #8df0cc; }
    .err { color: #ff9c9c; }
  </style>
</head>
<body>
  <main>
    <div class="panel">
      <h1>${title}</h1>
      <p>${description}</p>
      <p><strong>Amount:</strong> ${escrowSol} devnet SOL<br><strong>Program:</strong> ${escrowProgramId?.toBase58() || ''}</p>
      <button id="pay">${buttonText}</button>
      <p id="status"></p>
      <pre id="result" style="display:none"></pre>
    </div>
  </main>
  <script>
    const chatId = "${safeChatId}";
    const statusEl = document.getElementById('status');
    const resultEl = document.getElementById('result');
    const button = document.getElementById('pay');

    function setStatus(message, kind) {
      statusEl.className = kind || '';
      statusEl.textContent = message;
    }

    function bytesFromBase64(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }

    async function getProvider() {
      if (window.solflare) return window.solflare;
      if (window.solana?.isSolflare) return window.solana;
      throw new Error('Solflare extension not found. Install/open Solflare in this browser and switch it to devnet.');
    }

    button.addEventListener('click', async () => {
      button.disabled = true;
      resultEl.style.display = 'none';
      try {
        setStatus('Connecting Solflare...', '');
        const provider = await getProvider();
        await provider.connect();
        const account = provider.publicKey?.toString();
        if (!account) throw new Error('Solflare did not return a public key.');

        setStatus('${buildingText}', '');
        const response = await fetch('${endpoint}?chatId=' + encodeURIComponent(chatId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.transaction) throw new Error(payload.error || 'Could not build transaction.');

        const tx = solanaWeb3.Transaction.from(bytesFromBase64(payload.transaction));
        let signature;
        if (provider.signAndSendTransaction) {
          const result = await provider.signAndSendTransaction(tx);
          signature = typeof result === 'string' ? result : result.signature;
        } else {
          setStatus('Signing transaction...', '');
          const signed = await provider.signTransaction(tx);
          const connection = new solanaWeb3.Connection('https://api.devnet.solana.com', 'confirmed');
          signature = await connection.sendRawTransaction(signed.serialize());
          await connection.confirmTransaction(signature, 'confirmed');
        }

        setStatus('${doneText}', 'ok');
        resultEl.style.display = 'block';
        resultEl.textContent = '${command}' + signature;
      } catch (error) {
        console.error(error);
        setStatus(error.message || String(error), 'err');
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
function startTransactionRequestServer(): void {
  if (!publicBaseUrl || !escrowProgramId) {
    console.log('Smart-contract escrow links disabled. Set ESCROW_PROGRAM_ID and PUBLIC_BASE_URL to enable Solana Pay transaction requests.');
    return;
  }

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://localhost:${transactionRequestPort}`);
    if (requestUrl.pathname === '/pay' && req.method === 'GET') {
      const chatId = requestUrl.searchParams.get('chatId') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(paymentPage(chatId));
      return;
    }

    if (requestUrl.pathname === '/release' && req.method === 'GET') {
      const chatId = requestUrl.searchParams.get('chatId') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(paymentPage(chatId, 'release'));
      return;
    }

    const isOpenRequest = requestUrl.pathname === '/api/escrow/open';
    const isReleaseRequest = requestUrl.pathname === '/api/escrow/release';
    if (!isOpenRequest && !isReleaseRequest) {
      res.writeHead(404).end('Not found');
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        label: 'CulturSync AI',
        icon: 'https://placehold.co/128x128/png?text=Luna',
      }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end('Method not allowed');
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const chatId = Number(requestUrl.searchParams.get('chatId'));
        const state = states.get(chatId);
        if (!state?.brief) throw new Error('No campaign state found for this chat.');

        const payload = JSON.parse(body || '{}') as { account?: string };
        if (!payload.account) throw new Error('Wallet account missing from transaction request.');

        const brand = new PublicKey(payload.account);
        if (isReleaseRequest) {
          if (!state.escrowPda) throw new Error('No escrow account is stored for this chat.');
          if (state.brandWallet && state.brandWallet !== brand.toBase58()) {
            throw new Error('Connected wallet does not match the brand wallet that funded escrow.');
          }

          const transaction = new Transaction().add(new TransactionInstruction({
            programId: escrowProgramId!,
            keys: [
              { pubkey: brand, isSigner: true, isWritable: true },
              { pubkey: lunaWallet, isSigner: false, isWritable: true },
              { pubkey: new PublicKey(state.escrowPda), isSigner: false, isWritable: true },
            ],
            data: anchorDiscriminator('approve_and_release'),
          }));
          transaction.feePayer = brand;
          transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;

          const serialized = transaction.serialize({ requireAllSignatures: false }).toString('base64');
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
            transaction: serialized,
            message: 'Approve campaign delivery and release CulturSync escrow on Solana devnet',
          }));
          return;
        }

        state.escrowReference = state.escrowReference || createPaymentReference();
        let hash = escrowSeedHash(state);
        let escrowPda = escrowPdaFor(brand, hash);
        let existingEscrow = await connection.getAccountInfo(escrowPda, 'confirmed');
        if (existingEscrow) {
          console.warn('Escrow PDA already exists; rotating demo escrow reference.', { escrowPda: escrowPda.toBase58() });
          state.escrowReference = createPaymentReference();
          hash = escrowSeedHash(state);
          escrowPda = escrowPdaFor(brand, hash);
          existingEscrow = await connection.getAccountInfo(escrowPda, 'confirmed');
          if (existingEscrow) throw new Error('Could not find a fresh escrow PDA for this demo campaign.');
        }
        const amountLamports = Math.round(escrowSol * LAMPORTS_PER_SOL);
        const deadline = escrowDeadlineSeconds();
        const data = Buffer.concat([
          anchorDiscriminator('open_campaign'),
          writeU64(amountLamports),
          hash,
          writeI64(deadline),
        ]);

        state.escrowPda = escrowPda.toBase58();
        state.brandWallet = brand.toBase58();

        const transaction = new Transaction().add(new TransactionInstruction({
          programId: escrowProgramId!,
          keys: [
            { pubkey: brand, isSigner: true, isWritable: true },
            { pubkey: lunaWallet, isSigner: false, isWritable: true },
            { pubkey: escrowPda, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data,
        }));
        transaction.feePayer = brand;
        transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;

        const serialized = transaction.serialize({ requireAllSignatures: false }).toString('base64');
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          transaction: serialized,
          message: 'Open CulturSync campaign escrow on Solana devnet',
        }));
      } catch (error) {
        console.error('Transaction request failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Could not build escrow transaction.' }));
      }
    });
  });

  server.listen(transactionRequestPort, () => {
    console.log(`Solana Pay transaction request server running on port ${transactionRequestPort}.`);
  });
}

async function verifyEscrowProgramTransaction(signature: string): Promise<boolean> {
  if (!escrowProgramId) return false;
  const tx = await connection.getParsedTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || tx.meta?.err) return false;
  return tx.transaction.message.accountKeys.some((account) => account.pubkey.equals(escrowProgramId));
}

async function markCampaignDeliveredOnchain(state: CampaignState): Promise<string | undefined> {
  if (!escrowProgramId || !state.escrowPda || state.deliveredOnchain) return undefined;
  const creator = loadCreatorKeypair();
  if (!creator) {
    console.warn('LUNA_CREATOR_KEYPAIR_PATH is not configured; cannot mark escrow delivered onchain.');
    return undefined;
  }

  const transaction = new Transaction().add(new TransactionInstruction({
    programId: escrowProgramId,
    keys: [
      { pubkey: creator.publicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(state.escrowPda), isSigner: false, isWritable: true },
    ],
    data: anchorDiscriminator('mark_delivered'),
  }));
  transaction.feePayer = creator.publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  transaction.sign(creator);

  const signature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction(signature, 'confirmed');
  state.deliveredOnchain = true;
  console.log('Marked campaign delivered onchain', { signature, escrowPda: state.escrowPda });
  return signature;
}

type CampaignIntakeContext = {
  from: { id: number };
  reply: (message: string) => Promise<unknown>;
};

async function runCampaignIntake(ctx: CampaignIntakeContext, text: string): Promise<void> {
  const state = getState(ctx.from.id);
  state.brief = text;
  state.reviewPaid = true;
  state.escrowPaid = false;
  state.delivery = undefined;
  state.reviewReference = undefined;
  state.escrowReference = undefined;

  console.log('Replying with campaign intake received.');
  await ctx.reply([
    'Campaign intake received.',
    '',
    'CulturSync is checking the product, target markets, cultural positioning, audience fit, safety, creator angle, and whether the proposed budget makes sense.',
  ].join('\n'));

  try {
    state.preview = normalizePreview(await withTimeout(createPreview(text), 25000, 'CulturSync preview'), text);
    state.quotedPriceUsd = state.preview.quote_usd;
    state.stage = state.preview.decision === 'REJECT' ? 'PREVIEW_READY' : 'NEGOTIATING';
    await replyLong(ctx, formatPreview(state.preview));

    if (state.preview.decision === 'REJECT') {
      await ctx.reply('CulturSync would not move this into execution escrow. Send a revised product/brief if you want a reassessment.');
      return;
    }

    await ctx.reply([
      'If the company agrees, send /accept and Luna will create a Solflare devnet escrow payment link.',
      'If they counter, send /offer 100 or another amount.',
      'After escrow confirmation, CulturSync/Luna will generate the full localized caption, shot list, voiceover, and video prompt.',
    ].join('\n'));
  } catch (error) {
    console.error(error);
    state.preview = fallbackPreview(text);
    state.quotedPriceUsd = state.preview.quote_usd;
    state.stage = 'NEGOTIATING';
    await ctx.reply('Claude was slow or returned invalid JSON, so CulturSync switched to demo-safe fallback analysis.');
    await replyLong(ctx, formatPreview(state.preview));
    await ctx.reply('If the company agrees, send /accept and Luna will create a Solflare devnet escrow payment link.');
  }
}

bot.start((ctx) => {
  const state = getState(ctx.from.id);
  state.stage = 'IDLE';
  ctx.reply([
    'CulturSync AI is online.',
    '',
    'Send a product link, target markets, campaign budget, deliverables, and any Solflare/devnet escrow context. CulturSync will build the market strategy first, then Luna handles execution and escrow.',
    '',
    'Example:',
    demoBrief,
    '',
    'For the hackathon demo, send /demo to run this exact Merit serum campaign.',
  ].join('\n'));
});

bot.command('demo', async (ctx) => {
  console.log('Received /demo from', ctx.from.id);
  await runCampaignIntake(ctx, demoBrief);
});

bot.on('photo', async (ctx) => {
  const state = getState(ctx.from.id);
  const photos = ctx.message.photo;
  state.productImageFileId = photos[photos.length - 1]?.file_id;
  await ctx.reply('Product image received. Send /brief with the campaign details when ready.');
});

bot.command('brief', async (ctx) => {
  const state = getState(ctx.from.id);
  const brief = ctx.message.text.replace(/^\/brief/i, '').trim();

  if (!brief) {
    await ctx.reply('Send a brief like:\n`/brief Glow serum | 1 reel + 2 stories | budget $60 | audience women 25-35`');
    return;
  }

  state.brief = brief;
  state.stage = 'AWAITING_REVIEW_FEE';
  state.reviewPaid = false;
  state.escrowPaid = false;
  state.preview = undefined;
  state.delivery = undefined;
  state.reviewReference = createPaymentReference();
  state.escrowReference = undefined;

  await ctx.reply([
    '*Brief received.*',
    '',
    'I will not reveal the full creative yet. First, I run a paid campaign assessment: fit, risk, scope, and a high-level strategy preview.',
    '',
    paymentText(reviewFeeSol, 'Review fee', state.reviewReference!),
  ].join('\n'));
});

bot.command('confirm', async (ctx) => {
  const state = getState(ctx.from.id);
  const signature = ctx.message.text.replace(/^\/confirm/i, '').trim();

  if (!signature) {
    await ctx.reply('Send /confirm followed by the transaction signature.');
    return;
  }

  try {
    const expectedSol = state.stage === 'AWAITING_ESCROW' ? escrowSol : reviewFeeSol;
    const expectedReference = state.stage === 'AWAITING_ESCROW' ? state.escrowReference : state.reviewReference;
    let ok = state.stage === 'AWAITING_ESCROW' && state.escrowMode === 'program'
      ? await verifyEscrowProgramTransaction(signature)
      : await verifyPayment(signature, expectedSol, expectedReference);

    if (!ok && state.stage === 'AWAITING_ESCROW' && state.escrowMode === 'program') {
      console.warn('Program escrow verification failed. Trying direct devnet payment fallback for demo reliability.');
      ok = await verifyPayment(signature, expectedSol, expectedReference);
    }
    if (!ok) {
      await ctx.reply('I could not verify that payment yet. Check the signature, recipient, amount, and devnet network.');
      return;
    }

    state.lastTxSignature = signature;

    if (state.stage === 'AWAITING_REVIEW_FEE') {
      state.reviewPaid = true;
      await ctx.reply('Review fee verified. CulturSync is analyzing market fit, safety, scope, and pricing now.');
      state.preview = normalizePreview(await withTimeout(createPreview(state.brief || 'No brief provided.'), 25000, 'CulturSync preview'), state.brief || 'No brief provided.');
      state.quotedPriceUsd = state.preview.quote_usd;
      state.stage = state.preview.decision === 'REJECT' ? 'PREVIEW_READY' : 'NEGOTIATING';
      await replyLong(ctx, formatPreview(state.preview));
      if (state.preview.decision !== 'REJECT') {
        await ctx.reply('You can negotiate with `/offer 100`, accept with `/accept`, or stop here.');
      }
      return;
    }

    if (state.stage === 'AWAITING_ESCROW') {
      state.escrowPaid = true;
      state.stage = 'DELIVERED';
      await ctx.reply('Escrow payment verified. CulturSync/Luna is unlocking the final localized creative package.');
      state.delivery = await createDelivery(state.brief || 'No brief provided.', state.preview!);
      await replyLong(ctx, formatDelivery(state.delivery));
      if (state.escrowMode === 'program') {
        try {
          const deliveredSignature = await markCampaignDeliveredOnchain(state);
          if (deliveredSignature) {
            await ctx.reply(`Delivery marked onchain. Mark-delivered tx: ${deliveredSignature}`);
          }
        } catch (error) {
          console.error('Could not mark delivery onchain:', error);
          await ctx.reply('Final delivery is ready, but the onchain delivered marker failed. /approve will try again before creating the release transaction.');
        }
      }
      await ctx.reply('When the brand approves delivery, send `/approve` to open the Solflare release transaction.');
      return;
    }

    await ctx.reply('Payment verified, but there is no payment currently pending for this campaign.');
  } catch (error) {
    console.error(error);
    await ctx.reply('Something failed after /confirm. If the tx was confirmed, the most likely issue is message formatting or delivery generation. Check bot.err.log for details.');
  }
});

bot.command('confirmrelease', async (ctx) => {
  const state = getState(ctx.from.id);
  const signature = ctx.message.text.replace(/^\/confirmrelease/i, '').trim();

  if (!signature) {
    await ctx.reply('Send /confirmrelease followed by the release transaction signature.');
    return;
  }

  try {
    const ok = await verifyEscrowProgramTransaction(signature);
    if (!ok) {
      await ctx.reply('I could not verify the release transaction yet. Check that it is confirmed on Solana devnet.');
      return;
    }

    state.releaseTxSignature = signature;
    state.stage = 'RELEASED';
    await ctx.reply([
      '*Escrow released on devnet.*',
      '',
      `Release tx: ${signature}`,
      `Creator wallet: ${lunaWallet.toBase58()}`,
      '',
      'Demo story: the brand approved the generated reel, then Solana released the escrow to the CulturSync/Luna execution agent.',
    ].join('\n'));
  } catch (error) {
    console.error(error);
    await ctx.reply('Release verification failed. Check bot.err.log for details.');
  }
});

bot.command('offer', async (ctx) => {
  const state = getState(ctx.from.id);
  const offerText = ctx.message.text.replace(/^\/offer/i, '').trim();
  const offeredUsd = Number(offerText.replace(/[^0-9.]/g, ''));

  if (!state.preview || state.stage !== 'NEGOTIATING') {
    await ctx.reply('There is no active negotiation. Send /brief and confirm the review fee first.');
    return;
  }

  if (!Number.isFinite(offeredUsd) || offeredUsd <= 0) {
    await ctx.reply('Send an offer like /offer 120');
    return;
  }

  const minimum = Math.max(50, Math.round(state.preview.quote_usd * 0.85));
  if (offeredUsd >= minimum) {
    state.acceptedPriceUsd = offeredUsd;
    await ctx.reply([
      '*Offer accepted.*',
      '',
      `Accepted price: *${money(offeredUsd)}*`,
      'Terms: one revision, organic usage, no whitelisting unless renegotiated.',
      '',
      'Send `/accept` to receive the escrow payment instructions.',
    ].join('\n'));
    return;
  }

  await ctx.reply([
    '*Counteroffer from CulturSync/Luna*',
    '',
    `CulturSync/Luna cannot accept ${money(offeredUsd)} for this scope.`,
    `My floor is *${money(minimum)}* because the campaign includes strategy, creative direction, and production-ready deliverables.`,
    '',
    `Send /offer ${minimum} or reduce scope.`,
  ].join('\n'));
});

bot.command('accept', async (ctx) => {
  const state = getState(ctx.from.id);
  if (!state.preview || state.preview.decision === 'REJECT') {
    await ctx.reply('There is no acceptable campaign to move into escrow yet.');
    return;
  }

  state.acceptedPriceUsd = state.acceptedPriceUsd || state.preview.quote_usd;
  state.stage = 'AWAITING_ESCROW';
  state.escrowReference = createPaymentReference();
  await ctx.reply([
    '*Deal accepted.*',
    '',
    `Campaign price: *${money(state.acceptedPriceUsd)}*`,
    'The review fee is credited toward the campaign in production. For this demo, send the escrow devnet payment below.',
    '',
    escrowPaymentText(state, ctx.from.id),
  ].join('\n'));
});

bot.command('deliver', async (ctx) => {
  const state = getState(ctx.from.id);
  if (!state.escrowPaid || !state.preview) {
    await ctx.reply('Final delivery unlocks only after escrow payment is verified.');
    return;
  }

  state.delivery = state.delivery || await createDelivery(state.brief || 'No brief provided.', state.preview);
  state.stage = 'DELIVERED';
  await replyLong(ctx, formatDelivery(state.delivery));
});

bot.command('approve', async (ctx) => {
  const state = getState(ctx.from.id);
  if (state.stage !== 'DELIVERED' || !state.delivery) {
    await ctx.reply('There is no delivered campaign awaiting approval.');
    return;
  }

  if (state.escrowMode === 'program') {
    try {
      await markCampaignDeliveredOnchain(state);
    } catch (error) {
      console.error('Could not mark delivery onchain before release:', error);
      await ctx.reply('Could not prepare the onchain release yet because mark_delivered failed. Check bot.err.log, then try /approve again.');
      return;
    }

    const releaseLink = smartContractReleaseLink(ctx.from.id);
    if (!releaseLink) {
      await ctx.reply('Smart-contract release link is not configured. Check PUBLIC_BASE_URL and ESCROW_PROGRAM_ID.');
      return;
    }

    state.stage = 'AWAITING_RELEASE';
    await ctx.reply([
      '*Campaign approved.*',
      '',
      'Open this Solflare devnet page to sign the real escrow release transaction:',
      releaseLink,
      '',
      'After signing, paste:',
      '/confirmrelease YOUR_TRANSACTION_SIGNATURE',
    ].join('\n'));
    return;
  }

  state.stage = 'RELEASED';
  await ctx.reply([
    '*Campaign approved.*',
    '',
    'Direct-payment fallback approved. Smart-contract release is available when escrow was funded through the Solflare smart-contract checkout.',
    '',
    'Next demo step: send /video. CulturSync will randomly select one target country from the strategy and prepare a WIP GenAI video concept for that market.',
  ].join('\n'));
});

bot.command('status', async (ctx) => {
  const state = getState(ctx.from.id);
  await ctx.reply([
    '*Campaign status*',
    '',
    `Stage: *${state.stage}*`,
    `Review fee: ${state.reviewPaid ? 'paid' : 'not paid'}`,
    `Escrow: ${state.escrowPaid ? 'paid' : 'not paid'}`,
    `Quote: ${state.quotedPriceUsd ? money(state.quotedPriceUsd) : 'n/a'}`,
    `Accepted price: ${state.acceptedPriceUsd ? money(state.acceptedPriceUsd) : 'n/a'}`,
  ].join('\n'));
});


bot.command('test', async (ctx) => {
  console.log('Received /test from', ctx.from.id);
  await ctx.reply('Test OK. CulturSync is receiving Telegram messages.');
});

bot.command('debug', async (ctx) => {
  const state = getState(ctx.from.id);
  await ctx.reply([
    'Debug state',
    '',
    `stage: ${state.stage}`,
    `brief: ${state.brief || 'none'}`,
    `reviewPaid: ${state.reviewPaid ? 'yes' : 'no'}`,
    `escrowPaid: ${state.escrowPaid ? 'yes' : 'no'}`,
    `quote: ${state.quotedPriceUsd || 'n/a'}`,
  ].join('\n'));
});

bot.command('video', async (ctx) => {
  const state = getState(ctx.from.id);
  if (!state.delivery) {
    await ctx.reply('Video plan unlocks after CulturSync confirms escrow and generates final deliverables.');
    return;
  }

  const selected = pickVideoMarketIdea(state.brief);
  const videoBrief = buildVideoBrief(state, selected);

  await ctx.reply([
    'Video generation package prepared.',
    '',
    `Random market selected: ${selected.market}`,
    `Localized video idea: ${selected.idea}`,
    '',
    'Structured GenAI video brief JSON:',
  ].join('\n'));

  await replyLong(ctx, JSON.stringify(videoBrief, null, 2));

  if (!hasAutomaticVideoRenderer()) {
    await ctx.reply([
      'Automatic rendering is not enabled yet.',
      '',
      'To render automatically from the bot, add KLING_ACCESS_KEY and KLING_SECRET_KEY to .env. CulturSync will call Kling and send the MP4 back to this chat.',
      '',
      'Until then, use your Artlist subscription manually: paste the image_prompt/video_prompt into Artlist/Kling and upload the exported clip back as the campaign preview.',
    ].join('\n'));
    return;
  }

  try {
    await ctx.reply(`Rendering TikTok-style vertical video with Kling${klingEnableAudio ? ' with native audio' : ''}. This can take a minute or two...`);
    const videoUrl = await generateKlingVideo(videoBrief);
    await ctx.replyWithVideo(videoUrl, {
      caption: `CulturSync generated video preview for ${selected.market}. Next step: brand reviews it, then /approve releases escrow.`,
    });
    await ctx.reply([
      'Video render complete.',
      '',
      'Acquisition next step: upload this clip to the company account or ad account with the generated caption, UTM link, and market-specific CTA. Track clicks/leads, then CulturSync can compare markets and suggest the next creative test.',
    ].join('\n'));
  } catch (error) {
    console.error(error);
    await ctx.reply([
      'Kling automatic render failed.',
      error instanceof Error ? error.message : String(error),
      '',
      'The JSON brief above is still usable in Artlist/Kling manually.',
    ].join('\n'));
  }
});

bot.on('text', async (ctx) => {
  console.log('Received text from', ctx.from.id, ctx.message.text);
  const text = ctx.message.text.trim();
  if (!text || text.startsWith('/')) {
    console.log('Ignoring command/empty text in text handler:', text);
    return;
  }

  await runCampaignIntake(ctx, text);
});
bot.catch((error) => {
  console.error('Bot error:', error);
});

startTransactionRequestServer();
bot.launch();
console.log('CulturSync bot is running.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));





























