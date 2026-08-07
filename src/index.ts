import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { initializeApp, applicationDefault, getApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { WebClient } from '@slack/web-api';
import { VertexAI } from '@google-cloud/vertexai';
import { Storage } from '@google-cloud/storage';
import Stripe from 'stripe';
import { PostHog } from 'posthog-node';
import { randomUUID } from 'crypto';
import {
  computeCumulativePersonalImpactSnapshot,
  computePerCampaignPersonalImpactSnapshot,
  formatCompactNumber,
  normalizeImpactRangeId,
  type CampaignRow,
  type ContributionRow,
} from './impactMetrics';
import {
  computeCumulativePersonalImpactResponse,
  computePerCampaignPersonalImpactResponse,
  loadSimilarCampaigns,
  publicCampaignSummary,
  sanitizeCampaignImpactMetricsPatch,
} from './impactReport';
import { runCampaignReportDrips, parseCampaignReportDripRequest } from './campaignReportDrips';
import { runCampaignUrgentWindow, parseUrgentWindowRequest } from './campaignUrgentWindow';
import { sendContributionReceipt, AD_AMPLIFICATION_SPLIT } from './contributionReceipt';
import {
  fetchFacebookAdInsights,
  insightsToCampaignPatch,
  syncAllPublishedCampaignFacebookInsights,
  syncCampaignFacebookInsights,
} from './facebookInsights';
import {
  type ImpactShareCardPayload,
  renderImpactOgPng,
} from './impactOgImage';
import {
  getPublishedTrustReport,
  getTrustReportVersion,
  listTrustReportVersions,
  publishTrustReport,
  upsertTrustReport,
} from './trustReport';
import {
  getUutsConfig,
  isUutsPrescreenEnabled,
  isUutsPublishLiveEnabled,
  isUutsSchedulerEnabled,
  resolveUutsModel,
  runUutsPrescreenAndPersist,
  runUutsPrescreenScheduler,
} from './uutsPrescreen';
import {
  extractVertexUsage,
  forceFlushLangfuse,
  initLangfuse,
  metaStr,
  traceGeminiCall,
} from './langfuseInstrumentation';
import {
  dismissPoll,
  getMyPollResponses,
  isPollQuestionId,
  loadPollConfig,
  mergePollConfig,
  resolveRespondent,
  summarizePollAggregates,
  upsertPollAnswer,
} from './campaignPolls';

declare global {
  namespace Express {
    interface Request {
      /** Set when `Authorization: Bearer <Firebase ID token>` is valid */
      firebaseUid?: string;
      firebaseEmail?: string;
    }
  }
}

// Load environment variables
dotenv.config();
initLangfuse();

// Initialize Firebase Admin (uses default credentials on Cloud Run)
initializeApp({
  credential: applicationDefault(),
  projectId: 'unravelreserchagent',
});

/** Named DB: campaigns, ai_prompts, etc. (existing data) */
const db = getFirestore(getApp(), 'unravel');
/** Default DB `(default)`: user profiles */
const usersDb = getFirestore(getApp());

// Initialize Slack client
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// Initialize Vertex AI and Cloud Storage
const vertexAI = new VertexAI({ project: 'unravelreserchagent', location: 'us-central1' });
const storage = new Storage({ projectId: 'unravelreserchagent' });

// Stripe (optional - only if keys are set)
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

// Server-side PostHog (UE-155). Uses the public project key (phc_...) — that is exactly
// what event ingestion needs; the personal/read key is only for the query API. Lazy so
// missing config is a no-op rather than a crash.
let posthogClient: PostHog | null = null;
let posthogInitDone = false;
function getPostHog(): PostHog | null {
  if (posthogInitDone) return posthogClient;
  posthogInitDone = true;
  const key = (process.env.POSTHOG_KEY || process.env.VITE_POSTHOG_KEY || '').trim();
  if (!key) {
    console.warn('[PostHog] POSTHOG_KEY not set — server-side events will be skipped');
    return null;
  }
  const host = (process.env.POSTHOG_HOST || process.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com').trim();
  posthogClient = new PostHog(key, { host, flushAt: 1, flushInterval: 0 });
  return posthogClient;
}

/** Normalized fields for a coupon-tracking backing, from either webhook event. */
interface BackingInput {
  idKey: string; // stable dedup key — the PaymentIntent id (shared by both events)
  campaignId: string | null;
  firebaseUid: string | null;
  distinctId: string | null; // canonical PostHog id (UID or guest distinct_id)
  isGuest: boolean;
  email: string | null;
  stripeCustomerId: string | null;
  promoCode: string | null;
  amountTotal: number; // cents, post-discount
  amountDiscount: number; // cents
  utmSource: string | null;
  utmCampaign: string | null;
  utmMedium: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  source: string; // which event produced this
}

/**
 * UE-155: idempotently persist a `coupon_backings/{idKey}` record and emit exactly one
 * PostHog `backing_completed` event. Keyed on the PaymentIntent id so the primary event
 * (checkout.session.completed) and the backstop (payment_intent.succeeded) collapse to
 * one record + one event. Deliberately does not touch funding_current/contributions.
 */
async function upsertBacking(input: BackingInput): Promise<void> {
  if (!input.idKey) return;
  const ref = db.collection('coupon_backings').doc(input.idKey);

  let isNew = false;
  await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (snap.exists) return; // already processed (retry or the other event) — no double-count
    isNew = true;
    t.set(ref, {
      payment_intent_id: input.idKey,
      campaign_id: input.campaignId,
      firebase_uid: input.firebaseUid,
      posthog_distinct_id: input.distinctId,
      stripe_customer_id: input.stripeCustomerId,
      email: input.email,
      promo_code: input.promoCode,
      is_guest: input.isGuest,
      amount_total: input.amountTotal,
      amount_discount: input.amountDiscount,
      utm_source: input.utmSource,
      utm_campaign: input.utmCampaign,
      utm_medium: input.utmMedium,
      utm_term: input.utmTerm,
      utm_content: input.utmContent,
      source: input.source,
      created_at: new Date().toISOString(),
    });
  });

  if (!isNew) return; // only the first delivery emits the event

  // Best-effort is_first_backing for logged-in users: any earlier coupon backing?
  let isFirstBacking = false;
  if (input.firebaseUid) {
    try {
      const prior = await db
        .collection('coupon_backings')
        .where('firebase_uid', '==', input.firebaseUid)
        .limit(2)
        .get();
      isFirstBacking = prior.size <= 1; // only the one we just wrote
    } catch {
      /* leave false on query error */
    }
  }

  // UE-158 review: stamp the backer's username onto the PostHog person so the
  // dashboard's backer list shows it next to the email. Usernames live only in
  // the Firestore user profile (UE-75) — guests have none, so theirs stays unset.
  let username: string | null = null;
  if (input.firebaseUid) {
    try {
      const userDoc = await usersDb.collection('users').doc(input.firebaseUid).get();
      if (userDoc.exists) {
        username =
          String((userDoc.data() as Record<string, unknown>)?.username || '').trim() || null;
      }
    } catch {
      /* lookup failure — the person simply stays email-only */
    }
  }

  const ph = getPostHog();
  if (ph && input.distinctId) {
    ph.capture({
      distinctId: input.distinctId,
      event: 'backing_completed',
      properties: {
        promo_code: input.promoCode,
        coupon_value: input.amountDiscount,
        amount_total: input.amountTotal,
        amount_discount: input.amountDiscount,
        campaign_id: input.campaignId,
        is_guest: input.isGuest,
        is_first_backing: isFirstBacking,
        utm_source: input.utmSource,
        utm_campaign: input.utmCampaign,
        utm_medium: input.utmMedium,
        utm_term: input.utmTerm,
        utm_content: input.utmContent,
        // $set rides the same event, so the person — and this event's person
        // snapshot — carry the username the moment the backing is ingested.
        ...(username ? { $set: { username } } : {}),
      },
    });
    try {
      await ph.flush();
    } catch {
      /* non-fatal */
    }
  } else {
    console.warn('[webhook] backing_completed not emitted (no PostHog key or distinctId)');
  }
}

const cleanStr = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/** Stripe metadata values are always strings — parse a cents amount safely (0 when absent/bad). */
const parseCents = (v: unknown): number => {
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
};

/** Primary path: full identity + discount available on the session payload. */
async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  if (session.payment_status !== 'paid') return;
  const md = session.metadata || {};
  const firebaseUid = cleanStr(md.firebase_uid) || cleanStr(md.donorUid);
  await upsertBacking({
    // Dedup on the PaymentIntent id (shared with the backstop); fall back to session id.
    idKey: (typeof session.payment_intent === 'string' && session.payment_intent) || session.id,
    campaignId: cleanStr(md.campaign_id) || cleanStr(md.campaignId),
    firebaseUid,
    distinctId: cleanStr(session.client_reference_id) || cleanStr(md.posthog_distinct_id) || firebaseUid,
    isGuest: md.is_guest === 'true',
    email: cleanStr(session.customer_details?.email),
    stripeCustomerId: typeof session.customer === 'string' ? session.customer : cleanStr(session.customer?.id),
    // Pre-applied lander codes live in metadata. User-typed-code readback is a follow-up ticket.
    promoCode: cleanStr(md.promo_code),
    amountTotal: session.amount_total ?? 0,
    amountDiscount: session.total_details?.amount_discount ?? 0,
    utmSource: cleanStr(md.utm_source),
    utmCampaign: cleanStr(md.utm_campaign),
    utmMedium: cleanStr(md.utm_medium),
    utmTerm: cleanStr(md.utm_term),
    utmContent: cleanStr(md.utm_content),
    source: 'checkout.session.completed',
  });
}

/** Backstop for the session event. In practice this usually arrives FIRST (Stripe emits
 * payment_intent.succeeded a few seconds before checkout.session.completed), so it — not the
 * session handler — is what normally creates the record. It must therefore carry the real
 * money values: the PI has our `payment_intent_data.metadata` from UE-154, which includes
 * discount_cents/gross_cents for coupon checkouts. (No client_reference_id here, so the
 * distinct_id falls back to firebase_uid / posthog_distinct_id from metadata.) */
async function handlePaymentIntentSucceeded(pi: Stripe.PaymentIntent): Promise<void> {
  const md = pi.metadata || {};
  const campaignId = cleanStr(md.campaign_id) || cleanStr(md.campaignId);
  if (!campaignId) return; // not one of our campaign checkouts
  const firebaseUid = cleanStr(md.firebase_uid) || cleanStr(md.donorUid);
  await upsertBacking({
    idKey: pi.id,
    campaignId,
    firebaseUid,
    distinctId: firebaseUid || cleanStr(md.posthog_distinct_id),
    isGuest: md.is_guest === 'true',
    email: cleanStr(pi.receipt_email),
    stripeCustomerId: typeof pi.customer === 'string' ? pi.customer : cleanStr(pi.customer?.id),
    promoCode: cleanStr(md.promo_code),
    amountTotal: pi.amount_received ?? pi.amount ?? 0,
    // Our own metadata carries the coupon breakdown (UE-154). Previously hardcoded 0, which
    // zeroed amount_discount/coupon_value on essentially every backing because this handler
    // wins the race — see the note above.
    amountDiscount: parseCents(md.discount_cents),
    utmSource: cleanStr(md.utm_source),
    utmCampaign: cleanStr(md.utm_campaign),
    utmMedium: cleanStr(md.utm_medium),
    utmTerm: cleanStr(md.utm_term),
    utmContent: cleanStr(md.utm_content),
    source: 'payment_intent.succeeded',
  });
}

/** Stripe Product.images only accept publicly reachable HTTPS URLs (not http://localhost). */
function campaignImageUrlsForStripe(thumbnailUrl: unknown, apiBaseUrl: string): string[] {
  if (typeof thumbnailUrl !== 'string' || !thumbnailUrl.trim()) return [];
  const t = thumbnailUrl.trim();
  if (t.startsWith('https://')) return [t.slice(0, 2048)];
  const base = apiBaseUrl.replace(/\/$/, '');
  if (!base.startsWith('https://')) return [];
  const path = t.startsWith('/') ? t : `/${t}`;
  return [`${base}${path}`.slice(0, 2048)];
}

/** Hero slideshow primary CTA: http(s), bare host like yahoo.com (→ https), or same-origin path; empty = default donate URL. */
function sanitizeSlideshowBackButtonUrl(raw: unknown): string {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('file:')
  ) {
    return '';
  }
  if (s.startsWith('/') && !s.startsWith('//')) {
    return s.slice(0, 2048);
  }
  let candidate = s;
  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`;
  } else if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate.replace(/^\/+/, '')}`;
  }
  try {
    const u = new URL(candidate);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.href.slice(0, 2048);
    }
  } catch {
    /* invalid URL */
  }
  return '';
}

/** Donation Checkout: customer chooses amount on Stripe (min $5, default suggestion $5). */
const DONATION_CHECKOUT_MIN_CENTS = 300; // UE-183: $3 low entry point (was $5)
const DONATION_CHECKOUT_PRESET_CENTS = 500;
/** Stripe's minimum chargeable amount (USD). A coupon that leaves a smaller (non-zero) net
 * can't be charged, so we reject it cleanly rather than let Stripe 500. */
const STRIPE_MIN_CHARGE_CENTS = 50;

/** One-off Price with “customer chooses amount” for Checkout (one line item only). */
async function createDonationPayWhatYouWantPrice(stripeProductId: string): Promise<string> {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }
  const price = await stripe.prices.create({
    product: stripeProductId,
    currency: 'usd',
    custom_unit_amount: {
      enabled: true,
      minimum: DONATION_CHECKOUT_MIN_CENTS,
      preset: DONATION_CHECKOUT_PRESET_CENTS,
    },
  });
  return price.id;
}

/**
 * Reuse stored PWYW price if it matches current min/preset (Stripe Prices are immutable — old $25 presets need replacing).
 */
async function getOrCreateStripeDonationPriceId(campaignId: string, stripeProductId: string): Promise<string> {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }
  const ref = db.collection('campaigns').doc(campaignId);
  const snap = await ref.get();
  const existingRaw = (snap.data() as Record<string, unknown> | undefined)?.stripe_donation_price_id;
  const existing =
    typeof existingRaw === 'string' && existingRaw.trim().startsWith('price_') ? existingRaw.trim() : null;

  if (existing) {
    try {
      const p = await stripe.prices.retrieve(existing);
      const cua = p.custom_unit_amount;
      const presetOk = Number(cua?.preset) === DONATION_CHECKOUT_PRESET_CENTS;
      const minOk = Number(cua?.minimum) === DONATION_CHECKOUT_MIN_CENTS;
      if (p.active && cua != null && presetOk && minOk) {
        return existing;
      }
    } catch {
      // deleted or invalid price id — create fresh
    }
  }

  const donationPriceId = await createDonationPayWhatYouWantPrice(stripeProductId);
  await ref.update({
    stripe_donation_price_id: donationPriceId,
    updatedAt: new Date().toISOString(),
  });

  if (existing) {
    try {
      await stripe.prices.update(existing, { active: false });
    } catch {
      // non-fatal
    }
  }

  return donationPriceId;
}

/**
 * Create a Stripe Product when a campaign is approved (visible under Products in the Stripe Dashboard).
 * Also creates a pay-what-you-want Price so Checkout lets donors set the amount on Stripe’s page.
 */
async function createStripeProductForApprovedCampaign(
  campaignId: string,
  campaign: Record<string, unknown>
): Promise<{ productId: string; donationPriceId: string }> {
  if (!stripe) {
    throw new Error('Stripe is not configured');
  }
  const title = String(campaign.title || 'Unravel campaign').slice(0, 250);
  const rawDesc =
    campaign.short_description ||
    campaign.tagline ||
    campaign.description ||
    campaign.long_description ||
    '';
  const description = String(rawDesc)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);
  const fundingGoal = Number(campaign.funding_goal);
  const fundingStr = Number.isFinite(fundingGoal) ? String(fundingGoal) : '0';
  const apiBase = (process.env.API_BASE_URL || '').trim();
  const images = campaignImageUrlsForStripe(campaign.thumbnail_url, apiBase);

  const product = await stripe.products.create({
    name: title,
    ...(description ? { description } : {}),
    ...(images.length ? { images } : {}),
    metadata: {
      campaign_id: campaignId.slice(0, 500),
      funding_goal_dollars: fundingStr.slice(0, 500),
    },
  });
  const donationPriceId = await createDonationPayWhatYouWantPrice(product.id);
  return { productId: product.id, donationPriceId };
}

// Function to analyze campaign content with AI moderation
async function analyzeCampaignWithAI(title: string, description: string, tagline?: string): Promise<string> {
  try {
    // If title, description, and tagline combined are shorter than 50 chars, skip AI
    const totalContentLength = (title?.length || 0) + (description?.length || 0) + (tagline?.length || 0);
    if (totalContentLength < 50) {
      return 'Title and content are too short for AI to determine. Please moderate manually.';
    }
    
    // Fetch AI moderation prompt from Firestore (ai_prompts collection)
    const promptDoc = await db.collection('ai_prompts').doc(AI_PROMPTS_DOC_ID).get();
    const promptTemplate = promptDoc.exists ? (promptDoc.data()?.ai_moderation as string) : null;
    
    if (!promptTemplate || typeof promptTemplate !== 'string') {
      console.error('AI moderation prompt not found in ai_prompts/ucZnWEWd4t1f32H9f9Tj');
      return 'AI moderation unavailable: prompt not configured. Please review manually.';
    }
    
    // Insert campaign content between intro and evaluation criteria (right place in prompt structure)
    const campaignContent = `

Title: ${title || 'N/A'}
Description: ${description || 'N/A'}
Tagline: ${tagline || 'N/A'}
`;
    const prompt = promptTemplate.replace(
      'Evaluate the campaign for:',
      campaignContent + '\nEvaluate the campaign for:'
    );
    
    const modelName = process.env.GEMINI_MODEL_AI_MODERATION || 'gemini-2.5-flash-lite';
    const model = vertexAI.getGenerativeModel({ model: modelName });

    const recommendation = await traceGeminiCall({
      name: 'moderate-campaign',
      model: modelName,
      tags: ['ai-moderation'],
      metadata: {
        title: metaStr(title, 120),
        contentChars: String(totalContentLength),
      },
      input: {
        title: title || null,
        tagline: tagline || null,
        descriptionChars: description?.length || 0,
        // Full prompt for debugging; trim very long campaigns in UI via Langfuse
        prompt: prompt.length > 8000 ? `${prompt.slice(0, 8000)}…` : prompt,
      },
      run: async () => {
        const result = await model.generateContent({
          contents: [{
            role: 'user',
            parts: [{ text: prompt }],
          }],
        });
        const text =
          result.response.candidates?.[0]?.content?.parts?.[0]?.text ||
          'AI moderation analysis unavailable';
        const trimmed = text.trim();
        return {
          result: trimmed,
          output: trimmed,
          usageDetails: extractVertexUsage(result),
        };
      },
    });

    return recommendation;
  } catch (error: any) {
    console.error('AI moderation error:', error);
    
    // Check if error is related to insufficient context or content
    const errorMessage = error?.message?.toLowerCase() || '';
    if (errorMessage.includes('insufficient') || errorMessage.includes('not enough') || errorMessage.includes('context')) {
      return 'AI recommends manual review because there is not enough information to determine if this campaign should be approved or rejected. Please provide more details about the campaign.';
    }
    
    return 'AI moderation unavavailable for this campaign. Please review manually.';
  }
}

// Bias wheel: evidence, facts, perspective, tone (1-5), direction (categorical)
type BiasWheel = {
  evidence: number;
  facts: number;
  perspective: number;
  tone: number;
  direction: string;
};

const DEFAULT_BIAS_WHEEL: BiasWheel = {
  evidence: 1,
  facts: 1,
  perspective: 1,
  tone: 1,
  direction: 'none',
};

const VALID_DIRECTIONS = ['none', 'left-leaning', 'centrist', 'right-leaning', 'progressive', 'mixed', 'conservative'];

async function analyzeBiasWheel(
  title: string,
  shortDescription: string,
  longDescription: string,
  campaignId?: string
): Promise<BiasWheel> {
  try {
    const content = [title, shortDescription, longDescription].filter(Boolean).join('\n\n');
    if (content.trim().length < 50) {
      console.warn('Bias wheel: content too short (' + content.trim().length + ' chars), returning default');
      return DEFAULT_BIAS_WHEEL;
    }

    // Hardcoded bias wheel prompt (campaign content is prepended below)
    const promptTemplate = `Analyze the campaign above and score it on a bias wheel. Score each dimension 1-5 using these exact criteria:

**Evidence (1-5):**
1 = Opinion only; no external citations; unverifiable claims
2 = 1-2 sources; unclear reliability; blogs / partisan outlets only
3 = Mix of mainstream and niche sources; some transparency
4 = Multiple independent reputable sources (e.g., major outlets, recognized institutions)
5 = Strong evidentiary base (systematic reviews, consensus statements, multiple independent reports)

**Facts (1-5):**
1 = Almost entirely commentary/advocacy; facts are vague or cherry-picked
2 = Some factual grounding but blurred with opinion
3 = Rough balance of factual description and interpretation
4 = Mostly factual narrative with clearly marked interpretation
5 = Strong separation of fact vs opinion; interpretive sections labeled as such

**Perspective (1-5):**
1 = Only one viewpoint presented; others ignored or mocked
2 = Acknowledges opposing views but presents them as straw men
3 = At least one serious counter-view presented, but not deeply explored
4 = Multiple views reasonably summarized; some empathy for each side
5 = Systematic discussion of major perspectives; trade-offs and uncertainties clearly surfaced

**Tone (1-5):**
1 = Alarmist / shaming / inflammatory; lots of "they/you" blame language
2 = Strong emotive language; villains/heroes framing; urgency dialed high
3 = Mixed emotional appeals + neutral exposition
4 = Mostly calm/neutral; emotional language used sparingly and contextually
5 = Calm, measured, and analytical; emotion mainly in personal anecdotes, not in core claims

**Direction** (use only when clearly applicable; choose exactly one): left-leaning, centrist, right-leaning, none

If there is not enough information to determine, use 1 for all scores and "none" for direction.

Respond with ONLY valid JSON in this exact format, no other text:
{"evidence":5,"facts":5,"perspective":5,"tone":5,"direction":"none"}`;

    // Put campaign content at the beginning so AI sees it first, then instructions
    const campaignContent = `Campaign to analyze:
---
${content}
---

`;
    const prompt = campaignContent + promptTemplate;

    const modelName = process.env.GEMINI_MODEL_BIAS_WHEEL || 'gemini-2.5-flash-lite';
    const model = vertexAI.getGenerativeModel({ model: modelName });

    return await traceGeminiCall({
      name: 'score-bias-wheel',
      model: modelName,
      tags: ['bias-wheel'],
      metadata: {
        contentChars: String(content.trim().length),
        title: metaStr(title, 120),
        ...(campaignId ? { campaignId: metaStr(campaignId) } : {}),
      },
      input: {
        title: title || null,
        shortDescriptionChars: shortDescription?.length || 0,
        longDescriptionChars: longDescription?.length || 0,
        prompt: prompt.length > 8000 ? `${prompt.slice(0, 8000)}…` : prompt,
      },
      run: async () => {
        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });

        const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          console.warn('Bias wheel: no JSON in AI response, text:', text?.substring(0, 200));
          return {
            result: DEFAULT_BIAS_WHEEL,
            output: { parseError: 'no-json', raw: text.slice(0, 500) },
            usageDetails: extractVertexUsage(result),
          };
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        } catch (parseErr) {
          console.warn('Bias wheel: JSON parse failed:', parseErr, 'raw:', jsonMatch[0]);
          return {
            result: DEFAULT_BIAS_WHEEL,
            output: { parseError: 'invalid-json', raw: jsonMatch[0].slice(0, 500) },
            usageDetails: extractVertexUsage(result),
          };
        }
        const evidence = Math.min(5, Math.max(1, Number(parsed.evidence) || 1));
        const facts = Math.min(5, Math.max(1, Number(parsed.facts) || 1));
        const perspective = Math.min(5, Math.max(1, Number(parsed.perspective) || 1));
        const tone = Math.min(5, Math.max(1, Number(parsed.tone) || 1));
        const direction =
          typeof parsed.direction === 'string' && VALID_DIRECTIONS.includes(parsed.direction.toLowerCase())
            ? parsed.direction.toLowerCase()
            : 'none';

        const biasWheel: BiasWheel = { evidence, facts, perspective, tone, direction };
        return {
          result: biasWheel,
          output: biasWheel,
          usageDetails: extractVertexUsage(result),
        };
      },
    });
  } catch (error) {
    console.error('Bias wheel analysis error:', error);
    return DEFAULT_BIAS_WHEEL;
  }
}

async function analyzeBiasWheelAndUpdate(campaignId: string, data: Record<string, unknown>): Promise<void> {
  try {
    const title = (data.title as string) || '';
    const shortDescription = (data.short_description as string) || '';
    const longDescription = (data.long_description as string) || '';
    console.log('Bias wheel input:', { titleLen: title.length, shortLen: shortDescription.length, longLen: longDescription.length, campaignId });
    const biasWheel = await analyzeBiasWheel(title, shortDescription, longDescription, campaignId);
    await db.collection('campaigns').doc(campaignId).update({
      bias_wheel: biasWheel,
      updatedAt: new Date().toISOString(),
    });
    console.log(`Bias wheel updated for campaign ${campaignId}:`, biasWheel);
  } catch (error) {
    console.error(`Failed to analyze bias wheel for campaign ${campaignId}:`, error);
    await db.collection('campaigns').doc(campaignId).update({
      bias_wheel: DEFAULT_BIAS_WHEEL,
      updatedAt: new Date().toISOString(),
    });
  }
}

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware - CORS: only allow requests from frontend
const allowedOrigins = (process.env.FRONTEND_ORIGIN || 'https://unravel-website-297290600394.us-central1.run.app')
  .split(',')
  .map(o => o.trim());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. server-to-server) - they still need API key
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false); // Reject - not from allowed frontend
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
  credentials: true
}));
app.use(morgan('dev'));

// ─────────────────────────────────────────────────────────────────────────────
// UE-155: Stripe webhook. MUST be registered BEFORE express.json() (Stripe
// signature verification needs the raw request body) and BEFORE validateApiKey
// (Stripe sends no x-api-key). Reads everything from the event payload — it does
// NOT re-retrieve/reuse the Checkout Session, so it can't double-count against the
// existing /payments/record-checkout-session flow.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  if (!stripe) return res.status(503).send('Stripe not configured');
  const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!webhookSecret) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET not set');
    return res.status(500).send('Webhook secret not configured');
  }
  const sig = req.headers['stripe-signature'];
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig as string, webhookSecret);
  } catch (err: any) {
    console.error('[webhook] signature verification failed:', err?.message);
    return res.status(400).send(`Webhook Error: ${err?.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
    } else if (event.type === 'payment_intent.succeeded') {
      await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
    }
    // All other events: acknowledged and ignored.
  } catch (err: any) {
    // 500 tells Stripe to retry (handled idempotently on redelivery).
    console.error('[webhook] handler error:', err?.message);
    return res.status(500).send('handler error');
  }
  return res.status(200).json({ received: true });
});

app.use(express.json({ limit: '50mb' }));  // Increased limit for base64 images

// Health check (no auth required)
app.get('/', (req: Request, res: Response) => {
  res.send('unravel');
});

/** Public PostHog client config for the frontend (phc_ key is safe to expose). */
app.get('/config/analytics', (_req: Request, res: Response) => {
  const key =
    process.env.POSTHOG_KEY?.trim() ||
    process.env.VITE_POSTHOG_KEY?.trim() ||
    '';
  const host =
    process.env.POSTHOG_HOST?.trim() ||
    process.env.VITE_POSTHOG_HOST?.trim() ||
    'https://us.i.posthog.com';
  if (!key) {
    return res.json({ enabled: false });
  }
  res.json({
    enabled: true,
    posthogKey: key,
    posthogHost: host,
  });
});

/** Public poll UI config (Story triggers + funding popup rate). */
app.get('/config/polls', async (_req: Request, res: Response) => {
  try {
    const cfg = mergePollConfig(await loadPollConfig(db));
    res.json(cfg);
  } catch (error) {
    console.error('Error loading poll config:', error);
    res.status(500).json({ error: 'Failed to load poll config' });
  }
});

// API Key validation - required for all routes below (except /images/ for img src, /og/ for share previews)
// Use header `x-api-key` only so `Authorization: Bearer <Firebase ID token>` can be used for users/campaigns.
const validateApiKey = (req: Request, res: Response, next: NextFunction) => {
  // Always allow CORS preflight requests through (browser never includes auth headers on OPTIONS)
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  // Allow /images/ without auth (browser img tags can't send headers)
  if (req.path.startsWith('/images/')) {
    return next();
  }
  // Allow /og/ without auth (Facebook/crawlers need to fetch campaign preview HTML)
  if (req.path.startsWith('/og/')) {
    return next();
  }
  // Public shareable personal impact cards (no API key for recipients)
  if (req.path.startsWith('/public/impact/')) {
    return next();
  }

  const apiKey = req.headers['x-api-key'] as string | undefined;

  if (!process.env.API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized - Invalid or missing API key (use x-api-key header)' });
  }

  next();
};

/** If client sends Firebase ID token as Bearer, verify and attach uid/email (optional for most routes). */
async function attachFirebaseUser(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next();
  }
  const token = authHeader.slice(7).trim();
  if (!token || token === process.env.API_KEY) {
    return next();
  }
  try {
    const decoded = await getAuth().verifyIdToken(token);
    req.firebaseUid = decoded.uid;
    req.firebaseEmail = decoded.email;
  } catch {
    // Invalid/expired token — leave unset; /users/* will reject
  }
  next();
}

app.use(validateApiKey);
app.use(attachFirebaseUser);

// ============ CAMPAIGN REPORT DRIPS ============

/**
 * Runs the Klaviyo-triggered report drip sequence:
 * launch + mid + recap (one event per backer with personal contribution/reach).
 * Intended for Cloud Scheduler. Does not modify site impact report calculations.
 *
 * Body/query:
 * - dryRun, limit
 * - campaignId / campaignIds — scope to specific campaigns
 * - stage / stages — only consider launch|mid|recap
 * - forceStage — ignore timing windows (requires campaignId); still skips if already sent
 */
app.post('/campaign-report-drips/run', async (req: Request, res: Response) => {
  try {
    const parsed = parseCampaignReportDripRequest({
      body: (req.body ?? {}) as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
    });
    if (parsed.forceStage && parsed.campaignIds.length === 0) {
      return res.status(400).json({
        error: 'forceStage requires campaignId or campaignIds',
      });
    }
    const result = await runCampaignReportDrips(db, {
      dryRun: parsed.dryRun,
      limit: parsed.limit,
      campaignIds: parsed.campaignIds,
      stages: parsed.stages,
      forceStage: parsed.forceStage,
      usersDb,
    });
    const status =
      'error' in result && result.error ? 400 : result.ok ? 200 : 207;
    res.status(status).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('POST /campaign-report-drips/run:', error);
    res.status(500).json({ error: message || 'Failed to run campaign report drips' });
  }
});

/**
 * UE-184 urgent-window email job (Cloud Scheduler → this endpoint, same pattern as the drips job).
 * When a campaign enters its final 48h, emails backers of OTHER same-category campaigns to help
 * close the gap. Fires once per campaign.
 * Body/query: dryRun, limit, windowHours (default 48), freqCapHours (default 72), campaignId(s).
 */
app.post('/campaign-urgent-window/run', async (req: Request, res: Response) => {
  try {
    const parsed = parseUrgentWindowRequest({
      body: (req.body ?? {}) as Record<string, unknown>,
      query: req.query as Record<string, unknown>,
    });
    const result = await runCampaignUrgentWindow(db, { ...parsed, usersDb });
    res.status(result.ok ? 200 : 207).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('POST /campaign-urgent-window/run:', error);
    res.status(500).json({ error: message || 'Failed to run campaign urgent-window emails' });
  }
});

// ============ USERS (default Firestore DB) ============

const USERNAMES_COLLECTION = 'usernames';

const RESERVED_USERNAMES = new Set([
  'admin',
  'unravel',
  'support',
  'help',
  'api',
  'www',
  'mail',
  'root',
  'system',
  'moderator',
  'staff',
  'account',
  'settings',
  'login',
  'signup',
]);

type NormalizedUsername = { username: string; usernameLower: string };

function defaultUsernameFromName(firstName: string, lastName: string): NormalizedUsername {
  const fn = String(firstName || '').trim();
  const ln = String(lastName || '').trim();
  const username = `${fn} ${ln}`.trim().slice(0, 30);
  const usernameLower = `${fn}${ln}`.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 30);
  return {
    username: username || fn || ln || 'user',
    usernameLower: usernameLower || 'user',
  };
}

function normalizeUsername(raw: unknown): NormalizedUsername | null {
  const username = String(raw || '').trim().slice(0, 30);
  if (!username) return null;
  const usernameLower = username.replace(/\s+/g, '').toLowerCase();
  if (usernameLower.length < 2 || usernameLower.length > 30) return null;
  if (!/^[a-z0-9][a-z0-9_\-\s]*[a-z0-9]$|^[a-z0-9]{1,2}$/i.test(username.replace(/\s+/g, ''))) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_\-\s]*$/.test(username)) return null;
  if (RESERVED_USERNAMES.has(usernameLower)) return null;
  return { username, usernameLower };
}

function resolveUsernameInput(
  usernameInput: unknown,
  firstName: string,
  lastName: string
): NormalizedUsername | { error: string } {
  const trimmed = usernameInput == null ? '' : String(usernameInput).trim();
  if (!trimmed) return defaultUsernameFromName(firstName, lastName);
  const normalized = normalizeUsername(trimmed);
  if (!normalized) {
    return {
      error:
        'Username must be 2–30 characters and use only letters, numbers, spaces, underscores, or hyphens.',
    };
  }
  return normalized;
}

async function claimUsernameForUser(
  uid: string,
  target: NormalizedUsername,
  existingUsernameLower?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (existingUsernameLower === target.usernameLower) {
    return { ok: true };
  }

  const usernameRef = usersDb.collection(USERNAMES_COLLECTION).doc(target.usernameLower);

  try {
    await usersDb.runTransaction(async (tx) => {
      const usernameSnap = await tx.get(usernameRef);
      if (usernameSnap.exists) {
        const owner = String(usernameSnap.data()?.uid || '');
        if (owner && owner !== uid) {
          throw new Error('USERNAME_TAKEN');
        }
      }
      if (existingUsernameLower && existingUsernameLower !== target.usernameLower) {
        const oldRef = usersDb.collection(USERNAMES_COLLECTION).doc(existingUsernameLower);
        const oldSnap = await tx.get(oldRef);
        if (oldSnap.exists && String(oldSnap.data()?.uid || '') === uid) {
          tx.delete(oldRef);
        }
      }
      tx.set(usernameRef, {
        uid,
        username: target.username,
        usernameLower: target.usernameLower,
        updatedAt: new Date().toISOString(),
      });
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.message === 'USERNAME_TAKEN') {
      return { ok: false, error: 'This username is already taken. Please choose another.' };
    }
    throw error;
  }
}

/** Check whether a username is available (no auth; requires x-api-key). */
app.get('/users/username/available', async (req: Request, res: Response) => {
  try {
    const raw = String(req.query.username || '').trim();
    if (!raw) {
      return res.status(400).json({ available: false, reason: 'invalid' });
    }
    const normalized = normalizeUsername(raw);
    if (!normalized) {
      return res.json({ available: false, reason: 'invalid' });
    }
    const snap = await usersDb.collection(USERNAMES_COLLECTION).doc(normalized.usernameLower).get();
    res.json({ available: !snap.exists, reason: snap.exists ? 'taken' : undefined });
  } catch (error) {
    console.error('GET /users/username/available:', error);
    res.status(500).json({ error: 'Failed to check username' });
  }
});

/** Create or update profile after sign-up. Requires Firebase ID token + x-api-key. */
app.post('/users/profile', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization: Bearer <Firebase ID token> required' });
    }
    const token = authHeader.slice(7).trim();
    if (!token || token === process.env.API_KEY) {
      return res.status(401).json({ error: 'Use a Firebase ID token, not the API key' });
    }
    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(token);
    } catch {
      console.error('POST /users/profile: verifyIdToken failed');
      return res.status(401).json({ error: 'Invalid or expired Firebase token' });
    }

    const {
      firstName,
      lastName,
      email,
      username,
      avatarUrl,
      policiesVersion,
      marketingEmailConsent,
      marketingSmsConsent,
    } = req.body as Record<string, unknown>;
    if (firstName == null || lastName == null || email == null) {
      return res.status(400).json({ error: 'firstName, lastName, and email are required' });
    }

    const fn = String(firstName).trim().slice(0, 120);
    const ln = String(lastName).trim().slice(0, 120);
    const normEmail = String(email).trim().toLowerCase().slice(0, 320);
    if (!fn || !ln || !normEmail) {
      return res.status(400).json({ error: 'firstName, lastName, and email must be non-empty' });
    }

    const tokenEmail = (decoded.email || '').toLowerCase();
    if (tokenEmail && normEmail !== tokenEmail) {
      return res.status(400).json({ error: 'email must match your Firebase sign-in email' });
    }

    // Normalize optional consent fields. Values are only recorded if the client
    // explicitly sends them — legacy clients without the consent fields create
    // profiles as before (backwards-compatible). Marketing consent defaults to
    // false when missing (TCPA/GDPR: no opt-in record = no marketing).
    const polVersion = typeof policiesVersion === 'string' ? policiesVersion.trim().slice(0, 40) : null;
    const marketingEmail = marketingEmailConsent === true;
    const marketingSms = marketingSmsConsent === true;
    // Capture consent context server-side for audit defense (TCPA / CAN-SPAM / GDPR
    // record-keeping). Client-supplied IPs cannot be trusted.
    const consentIp = String(
      req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || ''
    ).split(',')[0].trim().slice(0, 64);
    const consentUserAgent = String(req.headers['user-agent'] || '').slice(0, 500);

    const uid = decoded.uid;
    const ref = usersDb.collection('users').doc(uid);
    const snap = await ref.get();
    const existingData = snap.exists ? snap.data() : undefined;
    const now = new Date().toISOString();
    const payload: Record<string, unknown> = {
      firstName: fn,
      lastName: ln,
      email: normEmail,
      updatedAt: now,
    };

    if (Object.prototype.hasOwnProperty.call(req.body as object, 'username')) {
      const resolved = resolveUsernameInput(username, fn, ln);
      if ('error' in resolved) {
        return res.status(400).json({ error: resolved.error });
      }
      const claim = await claimUsernameForUser(
        uid,
        resolved,
        typeof existingData?.usernameLower === 'string' ? existingData.usernameLower : null
      );
      if (!claim.ok) {
        return res.status(409).json({ error: claim.error });
      }
      payload.username = resolved.username;
      payload.usernameLower = resolved.usernameLower;
    }

    // Optional profile photo URL (uploaded via /upload-campaign-image). Empty string clears.
    if (Object.prototype.hasOwnProperty.call(req.body as object, 'avatarUrl')) {
      const raw = avatarUrl == null ? '' : String(avatarUrl).trim().slice(0, 500);
      if (!raw) {
        payload.avatarUrl = FieldValue.delete();
      } else if (!/^https?:\/\//i.test(raw)) {
        return res.status(400).json({ error: 'avatarUrl must be an http(s) URL' });
      } else {
        payload.avatarUrl = raw;
      }
    }

    // Current-state consent fields on the user doc (fast read, overwritten on each
    // update). Only written when the client sends policiesVersion — otherwise we
    // leave prior values intact (caller may be updating name/email only).
    if (polVersion) {
      payload.policiesVersion = polVersion;
      payload.policiesAcceptedAt = now;
      payload.marketingEmailConsent = marketingEmail;
      payload.marketingSmsConsent = marketingSms;
    }

    if (!snap.exists) {
      const createPayload = { ...payload };
      // FieldValue.delete() is only valid on update; omit cleared avatar on create.
      if (createPayload.avatarUrl && typeof createPayload.avatarUrl === 'object') {
        delete createPayload.avatarUrl;
      }
      await ref.set({
        ...createPayload,
        createdAt: now,
      });
    } else {
      await ref.update(payload);
    }

    // Append-only audit log — one document per consent event. Never updated or
    // deleted. Use this subcollection (not the user doc fields above) as the
    // authoritative record for TCPA / GDPR consent defense. Only written when
    // the client explicitly supplied consent data; skips silent updates.
    if (polVersion) {
      await ref.collection('consents').add({
        event: snap.exists ? 'profile_update' : 'signup',
        policiesVersion: polVersion,
        marketingEmailConsent: marketingEmail,
        marketingSmsConsent: marketingSms,
        ip: consentIp,
        userAgent: consentUserAgent,
        recordedAt: now,
      });
    }

    const responsePayload = { ...payload };
    if (
      responsePayload.avatarUrl &&
      typeof responsePayload.avatarUrl === 'object'
    ) {
      delete responsePayload.avatarUrl;
    }
    res.json({ ok: true, uid, ...responsePayload });
  } catch (error) {
    console.error('POST /users/profile:', error);
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

/** Current user profile from default DB (requires Firebase ID token). */
app.get('/users/me', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization: Bearer <Firebase ID token> required' });
    }
    const token = authHeader.slice(7).trim();
    if (!token || token === process.env.API_KEY) {
      return res.status(401).json({ error: 'Use a Firebase ID token' });
    }
    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(token);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired Firebase token' });
    }

    const doc = await usersDb.collection('users').doc(decoded.uid).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Profile not found; POST /users/profile first' });
    }
    res.json({ uid: decoded.uid, ...doc.data() });
  } catch (error) {
    console.error('GET /users/me:', error);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

/** Campaigns created by the current user (Firebase UID on `created_by`), newest first. */
app.get('/users/me/campaigns', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization: Bearer <Firebase ID token> required' });
    }
    const token = authHeader.slice(7).trim();
    if (!token || token === process.env.API_KEY) {
      return res.status(401).json({ error: 'Use a Firebase ID token' });
    }
    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(token);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired Firebase token' });
    }

    const uid = decoded.uid;
    const snapshot = await db.collection('campaigns').where('created_by', '==', uid).get();

    const documents = await enrichCampaignCreators(
      snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Record<string, unknown>)
    );

    documents.sort((a: any, b: any) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });

    res.json(documents);
  } catch (error) {
    console.error('GET /users/me/campaigns:', error);
    res.status(500).json({ error: 'Failed to load your campaigns' });
  }
});

// ============ CAMPAIGN DRAFTS ============
// Drafts are pre-submission work-in-progress campaigns. They live in their own
// `campaign_drafts` collection so they never enter moderation, Slack, the bias wheel,
// the public feed, or the admin queue. On submit the client creates a real campaign
// (which runs the full pipeline) and then deletes the draft.

const DRAFTS_COLLECTION = 'campaign_drafts';

/** Server-controlled fields a client must not set/override on a draft. */
const DRAFT_PROTECTED_FIELDS = [
  'id',
  'created_by',
  'created_by_uid',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  'status',
];

/** Strip server-controlled fields; keep the rest of the form payload as-is for lossless restore. */
function sanitizeDraftInput(body: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = { ...body };
  for (const field of DRAFT_PROTECTED_FIELDS) {
    delete clean[field];
  }
  return clean;
}

/** List the current user's drafts, newest updated first. */
app.get('/users/me/drafts', async (req: Request, res: Response) => {
  const uid = await requireFirebaseUid(req, res);
  if (!uid) return;
  try {
    const snapshot = await db.collection(DRAFTS_COLLECTION).where('created_by', '==', uid).get();
    const drafts = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    drafts.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      const ta = a.updatedAt ? new Date(String(a.updatedAt)).getTime() : 0;
      const tb = b.updatedAt ? new Date(String(b.updatedAt)).getTime() : 0;
      return tb - ta;
    });
    res.json(drafts);
  } catch (error) {
    console.error('GET /users/me/drafts:', error);
    res.status(500).json({ error: 'Failed to load your drafts' });
  }
});

/** Create a new draft owned by the current user. */
app.post('/users/me/drafts', async (req: Request, res: Response) => {
  const uid = await requireFirebaseUid(req, res);
  if (!uid) return;
  try {
    const now = new Date().toISOString();
    const doc = {
      ...sanitizeDraftInput((req.body ?? {}) as Record<string, unknown>),
      created_by: uid,
      created_by_uid: uid,
      createdAt: now,
      updatedAt: now,
    };
    const ref = await db.collection(DRAFTS_COLLECTION).add(doc);
    res.status(201).json({ id: ref.id, message: 'Draft created', updatedAt: now });
  } catch (error) {
    console.error('POST /users/me/drafts:', error);
    res.status(500).json({ error: 'Failed to create draft' });
  }
});

/** Fetch a single draft (owner only). */
app.get('/users/me/drafts/:id', async (req: Request, res: Response) => {
  const uid = await requireFirebaseUid(req, res);
  if (!uid) return;
  try {
    const snap = await db.collection(DRAFTS_COLLECTION).doc(req.params.id).get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Draft not found' });
    }
    const data = snap.data() as Record<string, unknown>;
    if (data.created_by !== uid) {
      return res.status(403).json({ error: 'You do not have access to this draft' });
    }
    res.json({ id: snap.id, ...data });
  } catch (error) {
    console.error('GET /users/me/drafts/:id:', error);
    res.status(500).json({ error: 'Failed to load draft' });
  }
});

/** Update a draft (owner only). Replaces form fields; server-controlled fields are protected. */
app.patch('/users/me/drafts/:id', async (req: Request, res: Response) => {
  const uid = await requireFirebaseUid(req, res);
  if (!uid) return;
  try {
    const ref = db.collection(DRAFTS_COLLECTION).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Draft not found' });
    }
    if ((snap.data() as Record<string, unknown>).created_by !== uid) {
      return res.status(403).json({ error: 'You do not have access to this draft' });
    }
    const now = new Date().toISOString();
    await ref.set(
      {
        ...sanitizeDraftInput((req.body ?? {}) as Record<string, unknown>),
        created_by: uid,
        created_by_uid: uid,
        updatedAt: now,
      },
      { merge: true }
    );
    res.json({ id: ref.id, message: 'Draft updated', updatedAt: now });
  } catch (error) {
    console.error('PATCH /users/me/drafts/:id:', error);
    res.status(500).json({ error: 'Failed to update draft' });
  }
});

/** Delete a draft (owner only). */
app.delete('/users/me/drafts/:id', async (req: Request, res: Response) => {
  const uid = await requireFirebaseUid(req, res);
  if (!uid) return;
  try {
    const ref = db.collection(DRAFTS_COLLECTION).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.json({ message: 'Draft deleted' });
    }
    if ((snap.data() as Record<string, unknown>).created_by !== uid) {
      return res.status(403).json({ error: 'You do not have access to this draft' });
    }
    await ref.delete();
    res.json({ message: 'Draft deleted' });
  } catch (error) {
    console.error('DELETE /users/me/drafts/:id:', error);
    res.status(500).json({ error: 'Failed to delete draft' });
  }
});

/** Donations made by the current user (Checkout sessions linked via `donorUid` metadata). */
app.get('/users/me/contributions', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization: Bearer <Firebase ID token> required' });
    }
    const token = authHeader.slice(7).trim();
    if (!token || token === process.env.API_KEY) {
      return res.status(401).json({ error: 'Use a Firebase ID token' });
    }
    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(token);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired Firebase token' });
    }

    const uid = decoded.uid;
    const snapshot = await usersDb.collection('users').doc(uid).collection('contributions').get();

    const documents = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    documents.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
      const dateA = a.recordedAt ? new Date(String(a.recordedAt)).getTime() : 0;
      const dateB = b.recordedAt ? new Date(String(b.recordedAt)).getTime() : 0;
      return dateB - dateA;
    });

    res.json(documents);
  } catch (error) {
    console.error('GET /users/me/contributions:', error);
    res.status(500).json({ error: 'Failed to load your contributions' });
  }
});

/** Cumulative personal impact for the signed-in user (Scope B — real contributions + campaign metrics). */
app.get('/users/me/impact', async (req: Request, res: Response) => {
  try {
    const uid = await requireFirebaseUid(req, res);
    if (!uid) return;

    const rangeId = normalizeImpactRangeId(req.query.range);
    const contributions = await loadUserContributions(uid);
    const campaignIds = contributions
      .map((c) => c.campaignId || c.campaign_id)
      .filter((id): id is string => Boolean(id));
    const campaignsById = await loadCampaignsByIds(campaignIds);

    const impact = computeCumulativePersonalImpactResponse({
      contributions,
      campaignsById,
      rangeId,
    });

    res.json({
      rangeId,
      impact,
    });
  } catch (error) {
    console.error('GET /users/me/impact:', error);
    res.status(500).json({ error: 'Failed to load your impact' });
  }
});

/** Per-campaign personal impact for the signed-in user. */
app.get('/users/me/impact/:campaignId', async (req: Request, res: Response) => {
  try {
    const uid = await requireFirebaseUid(req, res);
    if (!uid) return;

    const campaignId = String(req.params.campaignId || '').trim();
    if (!campaignId) {
      return res.status(400).json({ error: 'campaignId is required' });
    }

    const rangeId = normalizeImpactRangeId(req.query.range);
    const contributions = await loadUserContributions(uid);
    const campaignsById = await loadCampaignsByIds([campaignId]);
    const campaign = campaignsById[campaignId];

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const hasContributions = contributions.some(
      (c) => (c.campaignId || c.campaign_id) === campaignId
    );

    if (!hasContributions) {
      return res.json({
        rangeId,
        campaign: publicCampaignSummary(campaign),
        impact: null,
        similarCampaigns: [],
        hasContributions: false,
      });
    }

    const impact = computePerCampaignPersonalImpactResponse({
      contributions,
      campaign,
      rangeId,
    });

    const backedIds = [
      ...new Set(
        contributions.map((c) => c.campaignId || c.campaign_id).filter((id): id is string => Boolean(id))
      ),
    ];
    const backedCampaignsById =
      backedIds.length > 1 ? await loadCampaignsByIds(backedIds) : campaignsById;
    const hasOtherInCategory = backedIds.some(
      (id) =>
        id !== campaignId &&
        backedCampaignsById[id]?.category &&
        backedCampaignsById[id]?.category === campaign.category
    );

    let similarCampaigns: CampaignRow[] = [];
    if (hasOtherInCategory) {
      similarCampaigns = await loadSimilarCampaigns(db, campaignId, campaign.category);
    }

    res.json({
      rangeId,
      campaign: publicCampaignSummary(campaign),
      impact,
      similarCampaigns: similarCampaigns.map(publicCampaignSummary),
      hasContributions: true,
    });
  } catch (error) {
    console.error('GET /users/me/impact/:campaignId:', error);
    res.status(500).json({ error: 'Failed to load campaign impact' });
  }
});

/** Verify Firebase Bearer token; returns uid or sends 401. */
async function requireFirebaseUid(req: Request, res: Response): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization: Bearer <Firebase ID token> required' });
    return null;
  }
  const token = authHeader.slice(7).trim();
  if (!token || token === process.env.API_KEY) {
    res.status(401).json({ error: 'Use a Firebase ID token' });
    return null;
  }
  try {
    const decoded = await getAuth().verifyIdToken(token);
    return decoded.uid;
  } catch {
    res.status(401).json({ error: 'Invalid or expired Firebase token' });
    return null;
  }
}

async function loadUserContributions(uid: string): Promise<ContributionRow[]> {
  const snapshot = await usersDb.collection('users').doc(uid).collection('contributions').get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) as ContributionRow[];
}

async function loadCampaignsByIds(ids: string[]): Promise<Record<string, CampaignRow>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out: Record<string, CampaignRow> = {};
  await Promise.all(
    unique.map(async (id) => {
      const doc = await db.collection('campaigns').doc(id).get();
      if (doc.exists) {
        out[id] = { id: doc.id, ...doc.data() } as CampaignRow;
      }
    })
  );
  return out;
}

type ShareCardScope = 'cumulative' | 'campaign';

interface ShareCardDoc {
  ownerUid: string;
  scope: ShareCardScope;
  campaignId?: string;
  displayName: string;
  showAmount: boolean;
  metrics: Record<string, unknown>;
  cardImageUrl?: string;
  cardImageStoragePath?: string;
  createdAt: string;
  revoked: boolean;
}

function shareCardImageUrl(token: string, version?: string | number): string {
  const url = `${API_PUBLIC_BASE}/public/impact/${encodeURIComponent(token)}/card.jpg`;
  return version ? `${url}?v=${encodeURIComponent(String(version))}` : url;
}

function shareCardImageStoragePath(token: string): string {
  return `share-cards/${token}/card.jpg`;
}

function decodeDataUrlImage(value: unknown): { buffer: Buffer; mimeType: string } | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^data:(image\/(?:jpeg|jpg));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  return {
    buffer: Buffer.from(match[2].replace(/\s/g, ''), 'base64'),
    mimeType: 'image/jpeg',
  };
}

/** Create a public share link for personal impact (UE-47). */
app.post('/users/me/share-cards', async (req: Request, res: Response) => {
  try {
    const uid = await requireFirebaseUid(req, res);
    if (!uid) return;

    const scope = String(req.body?.scope || 'cumulative') as ShareCardScope;
    if (scope !== 'cumulative' && scope !== 'campaign') {
      return res.status(400).json({ error: 'scope must be cumulative or campaign' });
    }
    const campaignId =
      scope === 'campaign' ? String(req.body?.campaignId || '').trim() : undefined;
    if (scope === 'campaign' && !campaignId) {
      return res.status(400).json({ error: 'campaignId is required for campaign scope' });
    }
    const showAmount = Boolean(req.body?.showAmount);

    const contributions = await loadUserContributions(uid);
    if (!contributions.length) {
      return res.status(400).json({ error: 'No contributions found — back a campaign first to share impact' });
    }

    const campaignIds = contributions
      .map((c) => c.campaignId || c.campaign_id)
      .filter((id): id is string => Boolean(id));
    const campaignsById = await loadCampaignsByIds(campaignIds);

    const profileSnap = await usersDb.collection('users').doc(uid).get();
    const profile = profileSnap.data() as { firstName?: string; lastName?: string } | undefined;
    const displayName =
      String(req.body?.displayName || profile?.firstName || 'A backer').trim() || 'A backer';

    let metrics: Record<string, unknown>;
    let thumbnailUrl: string | null = null;
    let headlineTitle: string;

    if (scope === 'campaign' && campaignId) {
      const campaign = campaignsById[campaignId];
      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      const snapshot = computePerCampaignPersonalImpactSnapshot({ contributions, campaign });
      if (!snapshot) {
        return res.status(400).json({ error: 'You have not contributed to this campaign' });
      }
      metrics = {
        peopleReached: snapshot.personalReach,
        personalViews: snapshot.personalViews,
        personalActions: snapshot.personalActions,
        reconsidered: snapshot.reconsidered,
        perceptionShift: snapshot.actualPerceptionShift ?? snapshot.estimatedPerceptionShift,
        sharePct: snapshot.sharePct,
        campaignTitle: snapshot.campaignTitle,
        ...(showAmount ? { totalContributedCents: snapshot.totalContributedCents } : {}),
      };
      thumbnailUrl = snapshot.campaignThumbnail;
      headlineTitle = snapshot.campaignTitle;
    } else {
      const snapshot = computeCumulativePersonalImpactSnapshot({ contributions, campaignsById });
      if (!snapshot.campaignsBacked) {
        return res.status(400).json({ error: 'No impact data available yet' });
      }
      metrics = {
        peopleReached: snapshot.peopleReached,
        personalViews: snapshot.personalViews,
        personalActions: snapshot.personalActions,
        reconsidered: snapshot.reconsidered,
        avgPerceptionShift: snapshot.avgPerceptionShift,
        campaignsBacked: snapshot.campaignsBacked,
        avgTrustScore: snapshot.avgTrustScore,
        ...(showAmount ? { totalContributedCents: snapshot.totalContributedCents } : {}),
      };
      thumbnailUrl = snapshot.topCampaignThumbnail;
      headlineTitle = `${displayName}'s impact`;
    }

    const token = randomUUID();
    const createdAt = new Date().toISOString();
    const doc: ShareCardDoc = {
      ownerUid: uid,
      scope,
      ...(campaignId ? { campaignId } : {}),
      displayName,
      showAmount,
      metrics,
      createdAt,
      revoked: false,
    };

    await db.collection('share_cards').doc(token).set({
      ...doc,
      headlineTitle,
      thumbnailUrl,
    });

    const frontendBase = (process.env.FRONTEND_PUBLIC_URL || 'https://unravel.network').replace(/\/$/, '');
    res.status(201).json({
      token,
      url: `${frontendBase}/impact/share/${token}`,
      ogUrl: `${API_PUBLIC_BASE}/og/impact/${token}`,
      cardImageUrl: doc.cardImageUrl,
      scope,
      displayName,
      headlineTitle,
      metrics,
    });
  } catch (error) {
    console.error('POST /users/me/share-cards:', error);
    res.status(500).json({ error: 'Failed to create share card' });
  }
});

/** Store/overwrite the public JPG for a personal impact share card. */
app.post('/users/me/share-cards/:token/card-image', async (req: Request, res: Response) => {
  try {
    const uid = await requireFirebaseUid(req, res);
    if (!uid) return;

    const { token } = req.params;
    const ref = db.collection('share_cards').doc(token);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Share card not found' });
    }

    const data = snap.data() as ShareCardDoc;
    if (data.ownerUid !== uid) {
      return res.status(403).json({ error: 'Not allowed to update this share card' });
    }
    if (data.revoked) {
      return res.status(410).json({ error: 'This share link has been revoked' });
    }

    const decoded = decodeDataUrlImage(req.body?.imageBase64);
    if (!decoded) {
      return res.status(400).json({ error: 'imageBase64 must be a JPEG data URL' });
    }
    if (decoded.buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 5MB)' });
    }
    if (decoded.buffer.length < 128) {
      return res.status(400).json({ error: 'Invalid image data' });
    }

    const version = Date.now();
    const bucketName = process.env.GCS_BUCKET || 'unravel-generated-images';
    const storagePath = shareCardImageStoragePath(token);
    const file = storage.bucket(bucketName).file(storagePath);
    await file.save(decoded.buffer, {
      resumable: false,
      metadata: {
        contentType: decoded.mimeType,
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });

    const cardImageUrl = shareCardImageUrl(token, version);
    await ref.update({
      cardImageUrl,
      cardImageStoragePath: `gs://${bucketName}/${storagePath}`,
      cardImageUpdatedAt: FieldValue.serverTimestamp(),
      cardImageVersion: version,
    });

    res.json({ cardImageUrl });
  } catch (error) {
    console.error('POST /users/me/share-cards/:token/card-image:', error);
    res.status(500).json({ error: 'Failed to store share card image' });
  }
});

/** Revoke a personal impact share link. */
app.delete('/users/me/share-cards/:token', async (req: Request, res: Response) => {
  try {
    const uid = await requireFirebaseUid(req, res);
    if (!uid) return;

    const { token } = req.params;
    const ref = db.collection('share_cards').doc(token);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Share card not found' });
    }
    const data = snap.data() as ShareCardDoc;
    if (data.ownerUid !== uid) {
      return res.status(403).json({ error: 'Not allowed to revoke this share card' });
    }
    await ref.update({ revoked: true });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE /users/me/share-cards/:token:', error);
    res.status(500).json({ error: 'Failed to revoke share card' });
  }
});

/** Public read for a shareable personal impact card (no auth). */
app.get('/public/impact/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const snap = await db.collection('share_cards').doc(token).get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Share card not found' });
    }
    const data = snap.data() as ShareCardDoc & {
      headlineTitle?: string;
      thumbnailUrl?: string | null;
      cardImageUrl?: string | null;
    };
    if (data.revoked) {
      return res.status(410).json({ error: 'This share link has been revoked' });
    }

    res.setHeader('Cache-Control', 'public, max-age=120');
    res.json({
      scope: data.scope,
      displayName: data.displayName,
      headlineTitle: data.headlineTitle,
      thumbnailUrl: data.thumbnailUrl,
      cardImageUrl: data.cardImageUrl,
      metrics: data.metrics,
      createdAt: data.createdAt,
    });
  } catch (error) {
    console.error('GET /public/impact/:token:', error);
    res.status(500).json({ error: 'Failed to load share card' });
  }
});

/** Public stable JPG for a shareable personal impact card. */
app.get('/public/impact/:token/card.jpg', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const snap = await db.collection('share_cards').doc(token).get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Share card not found' });
    }
    const data = snap.data() as ShareCardDoc;
    if (data.revoked) {
      return res.status(410).json({ error: 'This share link has been revoked' });
    }

    const bucketName = process.env.GCS_BUCKET || 'unravel-generated-images';
    const file = storage.bucket(bucketName).file(shareCardImageStoragePath(token));
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({ error: 'Share card image not found' });
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
    file.createReadStream()
      .on('error', (err) => {
        console.error('Error streaming share card image:', err);
        res.status(500).json({ error: 'Failed to load share card image' });
      })
      .pipe(res);
  } catch (error) {
    console.error('GET /public/impact/:token/card.jpg:', error);
    res.status(500).json({ error: 'Failed to serve share card image' });
  }
});

// ============ FIRESTORE ROUTES (unravel DB) ============

// GET approved campaigns only (sorted by newest first)
app.get('/campaigns/approved', async (req: Request, res: Response) => {
  try {
    const snapshot = await db.collection('campaigns')
      .where('status', '==', 'Approved')
      .get();

    const documents = await enrichCampaignCreators(
      snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Record<string, unknown>)
    );

    documents.sort((a: any, b: any) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });

    res.json(documents);
  } catch (error) {
    console.error('Error fetching approved campaigns:', error);
    res.status(500).json({ error: 'Failed to fetch approved campaigns' });
  }
});

/** Sort key: ISO `createdAt` (campaigns / API) or Firestore `created_at` (landers console). */
function documentCreatedMsForSort(data: Record<string, unknown>): number {
  const ca = data.createdAt;
  if (typeof ca === 'string' && ca) {
    const t = new Date(ca).getTime();
    if (!Number.isNaN(t)) return t;
  }
  const cat = data.created_at;
  if (cat && typeof cat === 'object' && cat !== null && '_seconds' in cat) {
    const s = (cat as { _seconds: number; _nanoseconds?: number })._seconds;
    const n = (cat as { _nanoseconds?: number })._nanoseconds ?? 0;
    return s * 1000 + Math.floor(n / 1e6);
  }
  if (typeof cat === 'string' && cat) {
    const t = new Date(cat).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

// ============ Campaign duration / countdown ============

const CAMPAIGN_DAY_MS = 24 * 60 * 60 * 1000;
const CAMPAIGN_HOUR_MS = 60 * 60 * 1000;
const CAMPAIGN_MAX_DURATION_DAYS = 365;

function campaignTimestampToMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'object' && value !== null) {
    if ('_seconds' in value) {
      const s = (value as { _seconds: number; _nanoseconds?: number })._seconds;
      const n = (value as { _nanoseconds?: number })._nanoseconds ?? 0;
      return s * 1000 + Math.floor(n / 1e6);
    }
    if ('seconds' in value) {
      const s = (value as { seconds: number; nanoseconds?: number }).seconds;
      const n = (value as { nanoseconds?: number }).nanoseconds ?? 0;
      return s * 1000 + Math.floor(n / 1e6);
    }
    return null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const t = new Date(String(value)).getTime();
  return Number.isNaN(t) ? null : t;
}

function getCampaignStartMsFromData(data: Record<string, unknown>): number | null {
  return (
    campaignTimestampToMs(data.campaign_starts_at) ??
    campaignTimestampToMs(data.createdAt) ??
    campaignTimestampToMs(data.creation_date) ??
    campaignTimestampToMs(data.created_at)
  );
}

function getCampaignDurationMs(data: Record<string, unknown>): number | null {
  const days = Number(data.duration_days);
  const hours = Number(data.duration_hours);
  const hasDays = Number.isFinite(days) && days > 0;
  const hasHours = Number.isFinite(hours) && hours > 0;
  if (!hasDays && !hasHours) return null;
  return (hasDays ? days * CAMPAIGN_DAY_MS : 0) + (hasHours ? hours * CAMPAIGN_HOUR_MS : 0);
}

function getCampaignEndMsFromData(data: Record<string, unknown>): number | null {
  const durationMs = getCampaignDurationMs(data);
  if (durationMs == null) {
    return campaignTimestampToMs(data.campaign_ends_at);
  }
  const startMs = getCampaignStartMsFromData(data);
  if (startMs == null) return null;
  return startMs + durationMs;
}

/** Add computed countdown fields for API responses (does not mutate Firestore). */
function enrichCampaignResponse(
  data: Record<string, unknown>,
  nowMs = Date.now()
): Record<string, unknown> {
  const endMs = getCampaignEndMsFromData(data);
  if (endMs == null) {
    return { ...data };
  }
  const remainingMs = Math.max(0, endMs - nowMs);
  const ended = remainingMs <= 0;
  const daysLeft = ended ? 0 : Math.ceil(remainingMs / CAMPAIGN_DAY_MS);
  return {
    ...data,
    campaign_ends_at: new Date(endMs).toISOString(),
    days_left: daysLeft,
    campaign_ended: ended,
  };
}

/** Build public creator display fields from a user profile doc. Prefer username. */
function creatorFieldsFromUserProfile(userData: Record<string, unknown> | null | undefined): {
  creator_username?: string;
  creator_first_name?: string;
  creator_last_name?: string;
  creator?: string;
  creator_name?: string;
  creator_email?: string;
  creator_avatar_url?: string;
} {
  if (!userData) return {};
  const username = String(userData.username ?? '').trim();
  const firstName = String(userData.firstName ?? '').trim();
  const lastName = String(userData.lastName ?? '').trim();
  const fullName = `${firstName} ${lastName}`.trim();
  const email = String(userData.email ?? '').trim().toLowerCase();
  const avatarUrl = String(userData.avatarUrl ?? '').trim();
  const display = username || fullName;
  const out: Record<string, string> = {};
  if (username) out.creator_username = username;
  if (firstName) out.creator_first_name = firstName;
  if (lastName) out.creator_last_name = lastName;
  if (display) {
    out.creator = display;
    out.creator_name = display;
  }
  if (email) out.creator_email = email;
  if (avatarUrl && /^https?:\/\//i.test(avatarUrl)) out.creator_avatar_url = avatarUrl;
  return out;
}

function campaignHasCreatorDisplay(data: Record<string, unknown>): boolean {
  const username = String(data.creator_username ?? '').trim();
  const name = String(data.creator_name ?? data.creator ?? '').trim();
  const parts = [data.creator_first_name, data.creator_last_name]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return Boolean(username || name || parts);
}

/**
 * Fill missing creator display fields from users/{created_by}.
 * Prefer username when present. Always attach live avatar when available.
 * Response-only (does not write Firestore).
 */
async function enrichCampaignCreators(
  campaigns: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  const uidsNeeded = new Set<string>();
  for (const c of campaigns) {
    if (c.admin_created) continue;
    const uid = String(c.created_by ?? c.created_by_uid ?? '').trim();
    // Always load the user profile so avatar (and username) stay live.
    if (uid) uidsNeeded.add(uid);
  }

  const byUid = new Map<string, Record<string, unknown>>();
  if (uidsNeeded.size > 0) {
    const refs = [...uidsNeeded].map((uid) => usersDb.collection('users').doc(uid));
    // Firestore getAll accepts up to a batch of refs
    const snaps = await usersDb.getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists) {
        byUid.set(snap.id, snap.data() as Record<string, unknown>);
      }
    }
  }

  return campaigns.map((c) => {
    const data = { ...c };
    if (data.admin_created) return enrichCampaignResponse(data);

    const uid = String(data.created_by ?? data.created_by_uid ?? '').trim();
    const user = uid ? byUid.get(uid) : undefined;
    if (user) {
      const fields = creatorFieldsFromUserProfile(user);
      // Prefer live username for public display when available.
      if (fields.creator_username) {
        data.creator_username = fields.creator_username;
        data.creator = fields.creator_username;
        data.creator_name = fields.creator_username;
      } else if (!campaignHasCreatorDisplay(data)) {
        Object.assign(data, fields);
      }
      if (!data.creator_first_name && fields.creator_first_name) {
        data.creator_first_name = fields.creator_first_name;
      }
      if (!data.creator_last_name && fields.creator_last_name) {
        data.creator_last_name = fields.creator_last_name;
      }
      if (!data.creator_email && fields.creator_email) {
        data.creator_email = fields.creator_email;
      }
      if (fields.creator_avatar_url) {
        data.creator_avatar_url = fields.creator_avatar_url;
      } else {
        delete data.creator_avatar_url;
      }
    } else {
      delete data.creator_avatar_url;
    }

    // Prefer stored username over a name-only snapshot when both exist.
    const storedUsername = String(data.creator_username ?? '').trim();
    if (storedUsername) {
      data.creator = storedUsername;
      data.creator_name = storedUsername;
    }

    return enrichCampaignResponse(data);
  });
}

type CampaignDurationPatchResult =
  | { ok: true; patch: Record<string, unknown>; deleteFields: string[] }
  | { ok: false; error: string };

/**
 * Validate and normalize campaign duration fields on write.
 * Sets `campaign_starts_at` on first approval; persists `campaign_ends_at` when duration is set.
 */
function applyCampaignDurationPatch(
  body: Record<string, unknown>,
  prev: Record<string, unknown>,
  nowMs = Date.now()
): CampaignDurationPatchResult {
  const patch: Record<string, unknown> = { ...body };
  const deleteFields: string[] = [];

  if (patch.duration_days !== undefined) {
    const d = Number(patch.duration_days);
    if (!Number.isInteger(d) || d < 0 || d > CAMPAIGN_MAX_DURATION_DAYS) {
      return {
        ok: false,
        error: `duration_days must be an integer from 0 to ${CAMPAIGN_MAX_DURATION_DAYS}`,
      };
    }
    patch.duration_days = d;
  }

  if (patch.duration_hours !== undefined) {
    const h = Number(patch.duration_hours);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      return { ok: false, error: 'duration_hours must be an integer from 0 to 23' };
    }
    patch.duration_hours = h;
  }

  if (patch.show_countdown !== undefined) {
    patch.show_countdown = Boolean(patch.show_countdown);
  }

  if (patch.campaign_starts_at !== undefined) {
    const raw = patch.campaign_starts_at;
    if (raw === null || raw === '') {
      delete patch.campaign_starts_at;
      deleteFields.push('campaign_starts_at');
    } else {
      const t = new Date(String(raw)).getTime();
      if (Number.isNaN(t)) {
        return { ok: false, error: 'campaign_starts_at must be a valid ISO date string' };
      }
      patch.campaign_starts_at = new Date(t).toISOString();
    }
  }

  const becomingApproved = patch.status === 'Approved' && prev.status !== 'Approved';
  if (becomingApproved) {
    const hasExplicitStart =
      patch.campaign_starts_at !== undefined
        ? !deleteFields.includes('campaign_starts_at')
        : prev.campaign_starts_at != null && prev.campaign_starts_at !== '';
    if (!hasExplicitStart) {
      patch.campaign_starts_at = new Date(nowMs).toISOString();
    }
  }

  const merged: Record<string, unknown> = { ...prev };
  for (const [key, value] of Object.entries(patch)) {
    if (!deleteFields.includes(key)) merged[key] = value;
  }
  for (const key of deleteFields) {
    delete merged[key];
  }

  const endMs = getCampaignEndMsFromData(merged);
  const durationTouched =
    patch.duration_days !== undefined ||
    patch.duration_hours !== undefined ||
    patch.campaign_starts_at !== undefined ||
    deleteFields.includes('campaign_starts_at') ||
    becomingApproved;

  if (endMs != null) {
    patch.campaign_ends_at = new Date(endMs).toISOString();
  } else if (durationTouched) {
    delete patch.campaign_ends_at;
    deleteFields.push('campaign_ends_at');
  }

  return { ok: true, patch, deleteFields };
}

function buildCampaignUpdatePayload(
  patch: Record<string, unknown>,
  deleteFields: string[]
): Record<string, unknown> {
  const updatePayload: Record<string, unknown> = {
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  for (const key of deleteFields) {
    updatePayload[key] = FieldValue.delete();
  }
  return updatePayload;
}

function landerCreateFields(body: Record<string, unknown>): Record<string, unknown> {
  const title = String(body.title ?? '').trim();
  const description = String(body.description ?? '').trim();
  const read_more_url = String(body.read_more_url ?? body.readMoreUrl ?? '').trim();
  const image_url = String(body.image_url ?? body.imageUrl ?? '').trim();
  let status = String(body.status ?? 'Draft').trim();
  if (status !== 'Draft' && status !== 'Published') status = 'Draft';
  return { title, description, read_more_url, image_url, status };
}

function landerPatchFields(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) patch.title = String(body.title).trim();
  if (body.description !== undefined) patch.description = String(body.description).trim();
  if (body.read_more_url !== undefined || body.readMoreUrl !== undefined) {
    patch.read_more_url = String(body.read_more_url ?? body.readMoreUrl ?? '').trim();
  }
  if (body.image_url !== undefined || body.imageUrl !== undefined) {
    patch.image_url = String(body.image_url ?? body.imageUrl ?? '').trim();
  }
  if (body.status !== undefined) {
    const s = String(body.status).trim();
    if (s === 'Draft' || s === 'Published') patch.status = s;
  }
  return patch;
}

// ============ UUTS TRUST REPORT (Phase 0 / UE-167) ============
// Firestore: trust_reports/{campaignId} + versions subcollection.
// Does not modify legacy campaign.trust_score.

/** GET published trust report payload for public Surfaces & Review / report / email / PDF. */
app.get('/data/campaigns/:id/trust-report', async (req: Request, res: Response) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) {
      return res.status(400).json({ error: 'Campaign id is required' });
    }
    const campaignSnap = await db.collection('campaigns').doc(campaignId).get();
    if (!campaignSnap.exists) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = { id: campaignSnap.id, ...(campaignSnap.data() as Record<string, unknown>) };
    const report = await getPublishedTrustReport(db, campaignId, campaign);
    if (!report) {
      return res.status(404).json({ error: 'Trust report not found' });
    }
    res.json(report);
  } catch (error) {
    console.error('GET /data/campaigns/:id/trust-report:', error);
    res.status(500).json({ error: 'Failed to fetch trust report' });
  }
});

/** GET latest or specific version (includes drafts) — admin / moderation. ?versionId= */
app.get('/data/campaigns/:id/trust-report/admin', async (req: Request, res: Response) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) {
      return res.status(400).json({ error: 'Campaign id is required' });
    }
    const campaignSnap = await db.collection('campaigns').doc(campaignId).get();
    if (!campaignSnap.exists) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = { id: campaignSnap.id, ...(campaignSnap.data() as Record<string, unknown>) };
    const versionId =
      typeof req.query.versionId === 'string' ? req.query.versionId : null;
    const report = await getTrustReportVersion(db, campaignId, campaign, versionId);
    if (!report) {
      return res.status(404).json({ error: 'Trust report not found' });
    }
    res.json(report);
  } catch (error) {
    console.error('GET /data/campaigns/:id/trust-report/admin:', error);
    res.status(500).json({ error: 'Failed to fetch trust report' });
  }
});

/** GET version history for a campaign. */
app.get('/data/campaigns/:id/trust-report/versions', async (req: Request, res: Response) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) {
      return res.status(400).json({ error: 'Campaign id is required' });
    }
    const campaignSnap = await db.collection('campaigns').doc(campaignId).get();
    if (!campaignSnap.exists) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const versions = await listTrustReportVersions(db, campaignId);
    res.json({ campaignId, versions });
  } catch (error) {
    console.error('GET /data/campaigns/:id/trust-report/versions:', error);
    res.status(500).json({ error: 'Failed to list trust report versions' });
  }
});

/**
 * PUT create/update draft scores.
 * Body: { initial?, final?, review?, createdBy?, publish?, refresh? }
 * - refresh: new version without clobbering published
 * - publish: publish this write after save
 */
app.put('/data/campaigns/:id/trust-report', async (req: Request, res: Response) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) {
      return res.status(400).json({ error: 'Campaign id is required' });
    }
    const campaignSnap = await db.collection('campaigns').doc(campaignId).get();
    if (!campaignSnap.exists) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    if (body.publish === true && !isUutsPublishLiveEnabled()) {
      return res.status(403).json({
        error: 'UUTS live publish is disabled',
        publishLiveEnabled: false,
        hint: 'Set UUTS_PUBLISH_LIVE_ENABLED=true to connect publish to the live pipeline',
      });
    }
    const result = await upsertTrustReport(db, campaignId, {
      initial: body.initial,
      final: body.final,
      review: body.review,
      createdBy: body.createdBy != null ? String(body.createdBy) : req.firebaseEmail || req.firebaseUid || null,
      refresh: body.refresh === true,
      publish: body.publish === true,
    });
    const campaign = { id: campaignSnap.id, ...(campaignSnap.data() as Record<string, unknown>) };
    const report = await getTrustReportVersion(db, campaignId, campaign, result.versionId);
    res.status(result.created ? 201 : 200).json({
      message: result.created ? 'Trust report version created' : 'Trust report updated',
      ...result,
      report,
    });
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: error.message || 'Bad request' });
    }
    console.error('PUT /data/campaigns/:id/trust-report:', error);
    res.status(500).json({ error: 'Failed to upsert trust report' });
  }
});

/** POST refresh — new draft version; published scores stay intact. */
app.post('/data/campaigns/:id/trust-report/refresh', async (req: Request, res: Response) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) {
      return res.status(400).json({ error: 'Campaign id is required' });
    }
    const campaignSnap = await db.collection('campaigns').doc(campaignId).get();
    if (!campaignSnap.exists) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    if (body.initial === undefined) {
      return res.status(400).json({ error: 'initial scores are required for refresh' });
    }
    const result = await upsertTrustReport(db, campaignId, {
      initial: body.initial,
      final: body.final !== undefined ? body.final : null,
      review: body.review ?? {
        aiReviewed: true,
        humanReviewed: false,
        assignedReviewer: null,
        decision: 'pending',
        reviewedAt: null,
        reviewer: null,
      },
      createdBy: body.createdBy != null ? String(body.createdBy) : req.firebaseEmail || req.firebaseUid || null,
      refresh: true,
      publish: false,
    });
    const campaign = { id: campaignSnap.id, ...(campaignSnap.data() as Record<string, unknown>) };
    const report = await getTrustReportVersion(db, campaignId, campaign, result.versionId);
    res.status(201).json({
      message: 'Trust report refresh created as new draft version',
      ...result,
      report,
    });
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: error.message || 'Bad request' });
    }
    console.error('POST /data/campaigns/:id/trust-report/refresh:', error);
    res.status(500).json({ error: 'Failed to refresh trust report' });
  }
});

/**
 * POST enqueue a new async UUTS pre-screen run for an existing campaign.
 * Always allowed (manual Admin test path). Auto-run on submit remains gated by
 * UUTS_PRESCREEN_ENABLED — this endpoint does not require that flag.
 * Body (optional): { model?: string } — allowlisted Gemini or Claude Opus id.
 */
app.post('/data/campaigns/:id/uuts-prescreen/refresh', async (req: Request, res: Response) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) {
      return res.status(400).json({ error: 'Campaign id is required' });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    let modelOption;
    try {
      modelOption = resolveUutsModel(body.model != null ? String(body.model) : null);
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      return res.status(status).json({ error: err.message || 'Invalid model' });
    }
    const campaignRef = db.collection('campaigns').doc(campaignId);
    const campaignSnap = await campaignRef.get();
    if (!campaignSnap.exists) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = { id: campaignSnap.id, ...(campaignSnap.data() as Record<string, unknown>) };
    const queuedAt = new Date().toISOString();
    await campaignRef.update({
      uuts_prescreen_status: 'queued',
      uuts_prescreen_attempts: 0,
      uuts_prescreen_error: null,
      uuts_prescreen_model: modelOption.id,
      uuts_prescreen_provider: modelOption.provider,
      uuts_prescreen_updated_at: queuedAt,
      updatedAt: queuedAt,
    });

    void runUutsPrescreenAndPersist({
      db,
      vertexAI,
      campaignId,
      campaign,
      promptDocId: AI_PROMPTS_DOC_ID,
      model: modelOption.id,
    }).catch((err) =>
      console.error('UUTS pre-screen refresh background task error:', err)
    );

    res.status(202).json({
      message: 'UUTS pre-screen refresh queued',
      campaignId,
      uuts_prescreen_status: 'queued',
      model: modelOption.id,
      provider: modelOption.provider,
      source: 'manual',
    });
  } catch (error) {
    console.error('POST /data/campaigns/:id/uuts-prescreen/refresh:', error);
    res.status(500).json({ error: 'Failed to queue UUTS pre-screen refresh' });
  }
});

/**
 * GET UUTS admin config: available models + feature flags (publish live, scheduler).
 */
app.get('/uuts-prescreen/config', async (_req: Request, res: Response) => {
  try {
    res.json(getUutsConfig());
  } catch (error) {
    console.error('GET /uuts-prescreen/config:', error);
    res.status(500).json({ error: 'Failed to load UUTS config' });
  }
});

/**
 * POST batch UUTS re-score (Cloud Scheduler). Creates draft versions only.
 * Gated by UUTS_SCHEDULER_ENABLED (default off).
 * Body/query: dryRun, limit, campaignId(s), model.
 */
app.post('/uuts-prescreen/run', async (req: Request, res: Response) => {
  try {
    if (!isUutsSchedulerEnabled()) {
      return res.status(503).json({
        error: 'UUTS scheduler is disabled',
        schedulerEnabled: false,
        hint: 'Set UUTS_SCHEDULER_ENABLED=true to enable',
      });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const query = req.query as Record<string, unknown>;
    const dryRun =
      body.dryRun === true ||
      query.dryRun === 'true' ||
      query.dryRun === '1';
    const limitRaw = body.limit ?? query.limit;
    const limit = Math.max(1, Math.min(Number(limitRaw) || 20, 100));
    const campaignIdsRaw = body.campaignIds ?? body.campaignId ?? query.campaignIds ?? query.campaignId;
    const campaignIds = Array.isArray(campaignIdsRaw)
      ? campaignIdsRaw.map((id) => String(id).trim()).filter(Boolean)
      : typeof campaignIdsRaw === 'string' && campaignIdsRaw.trim()
        ? campaignIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    const model =
      body.model != null
        ? String(body.model)
        : typeof query.model === 'string'
          ? query.model
          : null;

    const result = await runUutsPrescreenScheduler({
      db,
      vertexAI,
      dryRun,
      limit,
      campaignIds,
      model,
      promptDocId: AI_PROMPTS_DOC_ID,
    });
    res.json(result);
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: error.message || 'Bad request' });
    }
    console.error('POST /uuts-prescreen/run:', error);
    res.status(500).json({ error: 'Failed to run UUTS scheduler' });
  }
});

/**
 * POST publish latest draft (or body.versionId). Archives previous published version.
 * Gated by UUTS_PUBLISH_LIVE_ENABLED (default off) so republish does not hit the live
 * public trust-report pipeline until explicitly enabled.
 */
app.post('/data/campaigns/:id/trust-report/publish', async (req: Request, res: Response) => {
  try {
    if (!isUutsPublishLiveEnabled()) {
      return res.status(403).json({
        error: 'UUTS live publish is disabled',
        publishLiveEnabled: false,
        hint: 'Set UUTS_PUBLISH_LIVE_ENABLED=true to connect republish to the live pipeline',
      });
    }
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) {
      return res.status(400).json({ error: 'Campaign id is required' });
    }
    const campaignSnap = await db.collection('campaigns').doc(campaignId).get();
    if (!campaignSnap.exists) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const versionId = body.versionId != null ? String(body.versionId) : null;
    const result = await publishTrustReport(db, campaignId, versionId);
    const campaign: Record<string, unknown> = {
      id: campaignSnap.id,
      ...(campaignSnap.data() as Record<string, unknown>),
    };
    const report = await getPublishedTrustReport(db, campaignId, campaign);

    // Queue for human annotation when AI initial vs human final diverge materially.
    try {
      const initialComposite = report?.initial?.composite ?? null;
      const finalComposite = report?.final?.composite ?? null;
      const { compositeDelta, enqueueUutsDisagreement } = await import('./uutsLangfuseEval');
      const delta = compositeDelta(initialComposite, finalComposite);
      const traceRaw = campaign.uuts_prescreen_langfuse_trace_id;
      const traceId = typeof traceRaw === 'string' ? traceRaw : null;
      if (delta != null && traceId) {
        await enqueueUutsDisagreement({
          traceId,
          delta,
          reason: `publish AI vs human Δ=${delta} campaign=${campaignId}`,
        });
      }
    } catch (enqueueErr) {
      console.warn('UUTS annotation enqueue after publish failed:', enqueueErr);
    }

    res.json({
      message: 'Trust report published',
      ...result,
      report,
    });
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500;
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: error.message || 'Bad request' });
    }
    console.error('POST /data/campaigns/:id/trust-report/publish:', error);
    res.status(500).json({ error: 'Failed to publish trust report' });
  }
});

// GET all documents from a collection (sorted by newest first)
// For campaigns, supports filtering by status: ?status=Approved|Rejected|Pending
// For landers, supports filtering by status: ?status=Draft|Published
app.get('/data/:collection', async (req: Request, res: Response) => {
  try {
    const { collection } = req.params;
    const { status } = req.query;
    
    let snapshot;
    
    // If filtering by status for campaigns or landers, use Firestore query
    if ((collection === 'campaigns' || collection === 'landers') && status) {
      snapshot = await db.collection(collection)
        .where('status', '==', status)
        .get();
    } else {
      // Otherwise get all documents
      snapshot = await db.collection(collection).get();
    }
    
    const rawDocs = snapshot.docs.map(
      (doc) => ({ id: doc.id, ...doc.data() }) as Record<string, unknown>
    );
    const documents =
      collection === 'campaigns' ? await enrichCampaignCreators(rawDocs) : rawDocs;
    documents.sort((a: any, b: any) => {
      const dateA = documentCreatedMsForSort(a as Record<string, unknown>);
      const dateB = documentCreatedMsForSort(b as Record<string, unknown>);
      return dateB - dateA;
    });
    
    res.json(documents);
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// GET a single document by ID
app.get('/data/:collection/:id', async (req: Request, res: Response) => {
  try {
    const { collection, id } = req.params;
    const doc = await db.collection(collection).doc(id).get();
    
    if (!doc.exists) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    const data = doc.data() as Record<string, unknown>;
    const out: Record<string, unknown> = { id: doc.id, ...data };

    if (collection === 'campaigns' && data?.facebook_ad_id) {
      out.facebook_reach = data.facebook_reach ?? 0;
      out.facebook_impressions = data.facebook_impressions ?? 0;
      out.facebook_clicks = data.facebook_clicks ?? 0;
      out.facebook_inline_link_clicks = data.facebook_inline_link_clicks ?? 0;
      out.facebook_frequency = data.facebook_frequency ?? null;
      out.facebook_spend = data.facebook_spend ?? null;
      out.facebook_insights_updated_at = data.facebook_insights_updated_at ?? null;
    }

    const response =
      collection === 'campaigns'
        ? (await enrichCampaignCreators([out]))[0]
        : out;

    res.json(response);
  } catch (error) {
    console.error('Error fetching document:', error);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

// ---------------------------------------------------------------------------
// UE-186 — Social proof: backer count + recent backer activity
// ---------------------------------------------------------------------------

/**
 * Display thresholds, editable WITHOUT a deploy via Firestore: settings/engagement
 * (unravel DB, same singleton-doc pattern as passkey / ai_prompts). A missing doc
 * or field falls back to these defaults.
 */
const SOCIAL_PROOF_DEFAULTS = {
  social_proof_min_backers: 5,
  social_proof_activity_max_hours: 72,
};

async function getEngagementSettings(): Promise<typeof SOCIAL_PROOF_DEFAULTS> {
  try {
    const doc = await db.collection('settings').doc('engagement').get();
    if (!doc.exists) return { ...SOCIAL_PROOF_DEFAULTS };
    const data = doc.data() as Record<string, unknown>;
    const minBackers = Number(data.social_proof_min_backers);
    const maxHours = Number(data.social_proof_activity_max_hours);
    return {
      social_proof_min_backers:
        Number.isFinite(minBackers) && minBackers >= 0
          ? minBackers
          : SOCIAL_PROOF_DEFAULTS.social_proof_min_backers,
      social_proof_activity_max_hours:
        Number.isFinite(maxHours) && maxHours > 0
          ? maxHours
          : SOCIAL_PROOF_DEFAULTS.social_proof_activity_max_hours,
    };
  } catch {
    return { ...SOCIAL_PROOF_DEFAULTS };
  }
}

// GET anonymized social proof for a campaign (public; UE-186).
// Privacy is enforced HERE, server-side: below the min-backer threshold nothing
// leaves the API; emails and last names never leave it at all; first names only
// with an explicit opt-in (show_name on the backing record, captured at checkout);
// timestamps are coarsened to whole hours (no exact times).
app.get('/data/campaigns/:id/backers', async (req: Request, res: Response) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) return res.status(400).json({ error: 'Campaign id is required' });

    const settings = await getEngagementSettings();
    const snapshot = await db
      .collection('stripe_checkout_records')
      .where('campaignId', '==', campaignId)
      .get();

    // One entry per distinct backer (uid, else email, else the record itself for
    // fully anonymous guests) — a repeat backer counts once, keeping their most
    // recent backing. Real records only; there is no simulated activity, ever.
    type BackerAgg = {
      donorUid?: string;
      donorName?: string;
      showName: boolean;
      lastAt: number;
    };
    const byBacker = new Map<string, BackerAgg>();
    for (const doc of snapshot.docs) {
      const data = doc.data() as Record<string, unknown>;
      const at = Date.parse(String(data.recordedAt || ''));
      if (!Number.isFinite(at)) continue;
      const donorUid = String(data.donor_uid || '').trim() || undefined;
      const email = String(data.donor_email || '').trim().toLowerCase();
      const key = donorUid || (email ? `e:${email}` : `r:${doc.id}`);
      const donorName = String(data.donor_name || '').trim() || undefined;
      const prev = byBacker.get(key);
      if (!prev || at > prev.lastAt) {
        byBacker.set(key, {
          donorUid: donorUid || prev?.donorUid,
          donorName: donorName || prev?.donorName,
          // The opt-in follows the most recent backing, so a backer can change
          // their mind on a later contribution.
          showName: data.show_name === true,
          lastAt: at,
        });
      }
    }

    const backerCount = byBacker.size;
    if (backerCount < settings.social_proof_min_backers) {
      // Below threshold: hide everything and send nothing else — young campaigns
      // must not look dead ("1 backer, 5 days ago").
      return res.json({ visible: false });
    }

    const now = Date.now();
    const recent = [...byBacker.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 5);

    // Resolve first names ONLY for opted-in backers. Stripe-path records carry no
    // donor_name, so fall back to the user profile for logged-in donors.
    const recentBackers: { firstName: string | null; hoursAgo: number }[] = [];
    for (const b of recent) {
      let firstName: string | null = null;
      if (b.showName) {
        firstName = (b.donorName || '').split(/\s+/)[0] || null;
        if (!firstName && b.donorUid) {
          try {
            const userDoc = await usersDb.collection('users').doc(b.donorUid).get();
            if (userDoc.exists) {
              firstName =
                String((userDoc.data() as Record<string, unknown>)?.firstName || '').trim() || null;
            }
          } catch {
            /* lookup failure → stays anonymous */
          }
        }
      }
      recentBackers.push({
        firstName, // null renders as "Someone" on the client
        hoursAgo: Math.max(0, Math.floor((now - b.lastAt) / 3_600_000)),
      });
    }

    const lastAt = recent[0]?.lastAt ?? 0;
    const showActivity =
      lastAt > 0 && now - lastAt <= settings.social_proof_activity_max_hours * 3_600_000;

    res.json({ visible: true, backerCount, showActivity, recentBackers });
  } catch (error) {
    console.error('Error fetching campaign backers:', error);
    res.status(500).json({ error: 'Failed to fetch campaign backers' });
  }
});

/**
 * UE-185 (Tim, Aug 3): capture WHY a backer funded, right after they contribute.
 * Stored against the campaign in `campaign_backer_feedback` so the team can read it.
 * Optional + length-capped; identity is best-effort (uid/email from the auth token,
 * session_id from the Stripe backing). Plain text only.
 */
const BACKER_FEEDBACK_MAX_CHARS = 500;
app.post('/data/campaigns/:id/backer-feedback', async (req: Request, res: Response) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) return res.status(400).json({ error: 'Campaign id is required' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const feedback = String(body.feedback ?? '').trim().slice(0, BACKER_FEEDBACK_MAX_CHARS);
    if (!feedback) return res.status(400).json({ error: 'Feedback text is required' });
    const sessionId = String(body.sessionId ?? '').trim() || undefined;
    await db.collection('campaign_backer_feedback').add({
      campaignId,
      feedback,
      ...(req.firebaseUid ? { donor_uid: req.firebaseUid } : {}),
      ...(req.firebaseEmail ? { donor_email: req.firebaseEmail } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      createdAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error saving backer feedback:', error);
    res.status(500).json({ error: 'Failed to save backer feedback' });
  }
});

// ---------------------------------------------------------------------------
// Campaign one-tap polls — perception-shift / content-quality signals
// ---------------------------------------------------------------------------

/** Upsert one answer per respondent per campaign per question. */
app.post('/data/campaigns/:id/polls', async (req: Request, res: Response) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) return res.status(400).json({ error: 'Campaign id is required' });
    if (!req.firebaseUid) {
      return res.status(401).json({ error: 'Sign in required to submit feedback' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const questionId = body.questionId ?? body.question_id;
    if (!isPollQuestionId(questionId)) {
      return res.status(400).json({ error: 'Invalid or missing questionId' });
    }
    const answer = body.answer;
    const placement = typeof body.placement === 'string' ? body.placement : undefined;
    const resolved = resolveRespondent(req.firebaseUid, body.fingerprint ?? body.posthogDistinctId);
    if (resolved.error || !resolved.respondent || resolved.respondent.type !== 'user') {
      return res.status(401).json({ error: 'Sign in required to submit feedback' });
    }

    const result = await upsertPollAnswer(db, {
      campaignId,
      questionId,
      answer: String(answer ?? ''),
      respondent: resolved.respondent,
      placement,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({
      ok: true,
      questionId,
      answer: result.answer,
      changed: result.changed,
      aggregates: result.aggregates,
    });
  } catch (error) {
    console.error('Error saving poll answer:', error);
    res.status(500).json({ error: 'Failed to save poll answer' });
  }
});

/** Dismiss a poll without answering (still counts toward one-shot UI). */
app.post('/data/campaigns/:id/polls/dismiss', async (req: Request, res: Response) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) return res.status(400).json({ error: 'Campaign id is required' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const questionId = body.questionId ?? body.question_id;
    if (!isPollQuestionId(questionId)) {
      return res.status(400).json({ error: 'Invalid or missing questionId' });
    }
    const placement = typeof body.placement === 'string' ? body.placement : undefined;
    const resolved = resolveRespondent(req.firebaseUid, body.fingerprint ?? body.posthogDistinctId);
    if (resolved.error || !resolved.respondent) {
      return res.status(400).json({ error: resolved.error || 'Respondent identity required' });
    }

    const result = await dismissPoll(db, {
      campaignId,
      questionId,
      respondent: resolved.respondent,
      placement,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, alreadyAnswered: result.alreadyAnswered });
  } catch (error) {
    console.error('Error dismissing poll:', error);
    res.status(500).json({ error: 'Failed to dismiss poll' });
  }
});

/** Caller’s answers/dismissals for this campaign. */
app.get('/data/campaigns/:id/polls/me', async (req: Request, res: Response) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) return res.status(400).json({ error: 'Campaign id is required' });

    const fingerprint = req.query.fingerprint ?? req.query.posthogDistinctId;
    const resolved = resolveRespondent(req.firebaseUid, fingerprint);
    if (resolved.error || !resolved.respondent) {
      return res.status(400).json({ error: resolved.error || 'Respondent identity required' });
    }

    const responses = await getMyPollResponses(db, campaignId, resolved.respondent);
    const config = mergePollConfig(await loadPollConfig(db));
    res.json({ responses, config });
  } catch (error) {
    console.error('Error fetching poll responses:', error);
    res.status(500).json({ error: 'Failed to fetch poll responses' });
  }
});

/** Public aggregates per question for a campaign. */
app.get('/data/campaigns/:id/polls/summary', async (req: Request, res: Response) => {
  try {
    const campaignId = String(req.params.id || '').trim();
    if (!campaignId) return res.status(400).json({ error: 'Campaign id is required' });

    const snap = await db.collection('campaigns').doc(campaignId).get();
    if (!snap.exists) return res.status(404).json({ error: 'Campaign not found' });
    const data = snap.data() as Record<string, unknown>;
    const aggregates = summarizePollAggregates(data.poll_aggregates);
    res.json({
      campaignId,
      aggregates,
      perception_shift_actual: data.perception_shift_actual ?? null,
      thumbs_up: data.thumbs_up ?? null,
      thumbs_down: data.thumbs_down ?? null,
      net_rating: data.net_rating ?? null,
      config: mergePollConfig(await loadPollConfig(db)),
    });
  } catch (error) {
    console.error('Error fetching poll summary:', error);
    res.status(500).json({ error: 'Failed to fetch poll summary' });
  }
});

// GET campaign Open Graph HTML for share previews (no API key; used by Facebook/crawlers and redirects users to frontend)
function normalizeFrontendBaseForOg(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().replace(/\/$/, '') : '';
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value.replace(/^\/+/, '')}`;
}

const FRONTEND_BASE_FOR_OG = normalizeFrontendBaseForOg(process.env.FRONTEND_BASE_URL || process.env.FRONTEND_ORIGIN);
// Where thumbnail images are actually hosted. Always the API's own public URL, never the
// frontend — because the UI proxies /og/ to the API via nginx, so req headers after the
// proxy see X-Forwarded-Host: unravel.network. We must NOT use that host for resolving
// /images/* paths (unravel.network doesn't serve those). Falls back to the known Cloud
// Run URL; override via env in other environments.
const API_PUBLIC_BASE = (process.env.API_PUBLIC_URL || 'https://unravel-api-297290600394.us-central1.run.app').replace(/\/$/, '');
// Facebook App ID for share analytics attribution (Meta Ads Manager, Social Issues
// authorization). Cleared the "Missing Properties: fb:app_id" warning in Sharing Debugger.
const FB_APP_ID = process.env.FB_APP_ID || '1175176054476751';

/**
 * Browser hits on /og/* redirect here (crawlers get HTML). Without FRONTEND_BASE_URL, a local
 * API on :8080 would otherwise redirect to http://localhost:8080/lander/... which does not exist.
 *
 * When nginx proxies /og/ to Cloud Run it sets Host to the run.app hostname but passes the
 * public site in X-Forwarded-Host. Using req.host alone would put the API origin in og:url
 * and redirects — LinkedIn/Meta often reject or strip previews when og:url does not match the
 * shared link domain.
 */
function ogRedirectBase(req: Request): string {
  if (FRONTEND_BASE_FOR_OG) return FRONTEND_BASE_FOR_OG;
  const xfHost = String(req.get('x-forwarded-host') || '')
    .split(',')[0]
    .trim();
  const xfProtoRaw = String(req.get('x-forwarded-proto') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (xfHost) {
    const proto = xfProtoRaw === 'http' ? 'http' : 'https';
    return `${proto}://${xfHost}`;
  }
  const hostRaw = (req.get('host') || '').toLowerCase();
  const host = hostRaw.split(':')[0];
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:5173';
  }
  return `${req.protocol}://${req.get('host')}`;
}

/** User-agents that should receive OG HTML instead of a redirect (share preview scrapers). */
function isSharePreviewCrawler(ua: string): boolean {
  return /(facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|slack-imgproxy|discordbot|whatsapp|telegrambot|pinterest|googlebot|bingbot|applebot|redditbot|skypeuripreview|embedly|vkshare|w3c_validator|qwantify|yandexbot|duckduckbot|crawler|spider|bot)/i.test(
    ua,
  );
}

/**
 * Resolve a Firestore-stored `thumbnail_url` into an absolute, crawler-fetchable URL.
 * Mirrors the UI's `getImageUrl` logic (see unravel-ui/src/pages/CampaignDetailPage.jsx)
 * so relative paths like "/images/foo.png" or bare filenames like "foo.png" don't get
 * fed to Facebook/LinkedIn as broken `og:image` values (which cause them to render a
 * blank preview card with no image).
 */
function resolveThumbnailUrl(raw: unknown, apiBase: string): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const fallback = 'https://via.placeholder.com/800x400?text=Campaign';
  if (!s) return fallback;
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:')) return s;
  if (s.startsWith('/')) return `${apiBase}${s}`;
  if (!s.includes('/') && !s.includes(':')) return `${apiBase}/images/${s}`;
  return fallback;
}

app.get('/og/campaign/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const doc = await db.collection('campaigns').doc(id).get();
    if (!doc.exists) {
      res.status(404).send('Campaign not found');
      return;
    }
    const data = doc.data() as Record<string, unknown>;
    const title = (data?.title as string) || 'Campaign';
    const description = String(data?.short_description ?? data?.tagline ?? data?.description ?? title).replace(/<[^>]*>/g, '').slice(0, 200);
    // Always resolve image paths against the API's own public URL (not forwarded host —
    // requests arrive here via nginx proxy from unravel.network, which doesn't host /images/).
    const image = resolveThumbnailUrl(data?.thumbnail_url, API_PUBLIC_BASE);
    const canonicalUrl = `${ogRedirectBase(req)}/campaign/${id}`;
    // Use the canonical frontend URL for FB preview display.
    // Otherwise the OG endpoint URL leaks as the visible "source" domain.
    const ogPageUrl = canonicalUrl;
    // UE-185: carry the share link's query (utm_source / utm_medium / …) through to
    // the frontend so attribution survives the click-through. og:url stays clean so
    // crawlers collapse every share of a campaign onto one preview object.
    const qsIndex = req.originalUrl.indexOf('?');
    const forwardedQuery = qsIndex >= 0 ? req.originalUrl.slice(qsIndex) : '';
    const ua = String(req.get('user-agent') || '');
    const isCrawler = isSharePreviewCrawler(ua);
    // Diagnostic log so we can confirm which crawler (if any) is hitting /og/campaign/:id in prod.
    // Safe to leave on — low volume, no PII. Remove once preview-card issue is verified fixed.
    console.log(`[og/campaign] id=${id} ua="${ua}" crawler=${isCrawler} image=${image}`);

    const ogHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} | Unravel</title>
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:image:secure_url" content="${escapeHtml(image)}">
  <meta property="og:url" content="${escapeHtml(ogPageUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Unravel">
  <meta property="fb:app_id" content="${escapeHtml(FB_APP_ID)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">
</head>
<body><p>${escapeHtml(title)}</p></body>
</html>`;
    if (isCrawler) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.send(ogHtml);
    }

    return res.redirect(302, `${canonicalUrl}${forwardedQuery}`);
  } catch (error) {
    console.error('OG campaign error:', error);
    res.status(500).send('Error loading campaign');
  }
});

/** Campaign id from a path or full URL containing `/campaign/:id` (matches unravel-ui lander helpers). */
function extractCampaignIdFromUrl(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  const m = value.match(/\/campaign\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

app.get('/og/lander/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const landerSnap = await db.collection('landers').doc(id).get();
    if (!landerSnap.exists) {
      res.status(404).send('Lander not found');
      return;
    }
    const landerData = landerSnap.data() as Record<string, unknown>;
    const landerStatus = String(landerData?.status ?? '').trim();
    if (landerStatus !== 'Published') {
      res.status(404).send('Lander not found');
      return;
    }

    const readMore =
      String(landerData?.read_more_url ?? landerData?.readMoreUrl ?? '').trim();
    const campaignId = extractCampaignIdFromUrl(readMore);

    let title = (landerData?.title as string) || 'Fund';
    let description = String(landerData?.description ?? title)
      .replace(/<[^>]*>/g, '')
      .slice(0, 200);
    let image = resolveThumbnailUrl(landerData?.image_url ?? landerData?.imageUrl, API_PUBLIC_BASE);

    if (campaignId) {
      const campSnap = await db.collection('campaigns').doc(campaignId).get();
      if (campSnap.exists) {
        const c = campSnap.data() as Record<string, unknown>;
        title = (c?.title as string) || title;
        description = String(c?.short_description ?? c?.tagline ?? c?.description ?? title)
          .replace(/<[^>]*>/g, '')
          .slice(0, 200);
        image = resolveThumbnailUrl(c?.thumbnail_url, API_PUBLIC_BASE);
      }
    }

    const canonicalUrl = `${ogRedirectBase(req)}/lander/${id}`;
    const ogPageUrl = canonicalUrl;
    // UE-185: forward share-link UTMs through the human redirect (see /og/campaign).
    const qsIndex = req.originalUrl.indexOf('?');
    const forwardedQuery = qsIndex >= 0 ? req.originalUrl.slice(qsIndex) : '';
    const ua = String(req.get('user-agent') || '');
    const isCrawler = isSharePreviewCrawler(ua);
    console.log(`[og/lander] id=${id} ua="${ua}" crawler=${isCrawler} campaignId=${campaignId || 'none'} image=${image}`);

    const ogHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} | Unravel</title>
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:image:secure_url" content="${escapeHtml(image)}">
  <meta property="og:url" content="${escapeHtml(ogPageUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Unravel">
  <meta property="fb:app_id" content="${escapeHtml(FB_APP_ID)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">
</head>
<body><p>${escapeHtml(title)}</p></body>
</html>`;
    if (isCrawler) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.send(ogHtml);
    }

    return res.redirect(302, `${canonicalUrl}${forwardedQuery}`);
  } catch (error) {
    console.error('OG lander error:', error);
    res.status(500).send('Error loading lander');
  }
});

function impactShareCardPayloadFromDoc(
  data: ShareCardDoc & { headlineTitle?: string },
): ImpactShareCardPayload {
  return {
    scope: data.scope,
    displayName: data.displayName,
    headlineTitle: data.headlineTitle,
    metrics: data.metrics || {},
  };
}

function impactOgTitle(payload: ImpactShareCardPayload): string {
  const metrics = payload.metrics || {};
  const campaignTitle =
    typeof metrics.campaignTitle === 'string' ? metrics.campaignTitle.trim() : '';
  if (payload.scope === 'campaign' && campaignTitle) {
    return `${payload.displayName} backed "${campaignTitle}"`;
  }
  return `${payload.displayName}'s impact on Unravel`;
}

function impactOgDescription(payload: ImpactShareCardPayload): string {
  const metrics = payload.metrics || {};
  const reached = formatCompactNumber(Number(metrics.peopleReached) || 0);
  const shift = metrics.perceptionShift ?? metrics.avgPerceptionShift;
  const shiftLabel = shift != null ? ` · +${shift}% perception shift` : '';
  return `Helped reach ${reached} people${shiftLabel} through evaluated campaigns.`;
}

async function loadImpactShareCardForOg(token: string): Promise<
  | { ok: true; payload: ImpactShareCardPayload }
  | { ok: false; status: 404 | 410; message: string }
> {
  const snap = await db.collection('share_cards').doc(token).get();
  if (!snap.exists) {
    return { ok: false, status: 404, message: 'Share card not found' };
  }
  const data = snap.data() as ShareCardDoc & { headlineTitle?: string };
  if (data.revoked) {
    return { ok: false, status: 410, message: 'This share link has been revoked' };
  }
  return { ok: true, payload: impactShareCardPayloadFromDoc(data) };
}

app.get('/og/impact/:token/image', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const loaded = await loadImpactShareCardForOg(token);
    if (!loaded.ok) {
      res.status(loaded.status).send(loaded.message);
      return;
    }

    const png = renderImpactOgPng(loaded.payload);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.send(png);
  } catch (error) {
    console.error('OG impact image error:', error);
    res.status(500).send('Error generating impact share image');
  }
});

app.get('/og/impact/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const loaded = await loadImpactShareCardForOg(token);
    if (!loaded.ok) {
      res.status(loaded.status).send(loaded.message);
      return;
    }

    const title = impactOgTitle(loaded.payload);
    const description = impactOgDescription(loaded.payload);
    const canonicalUrl = `${ogRedirectBase(req)}/impact/share/${token}`;
    const ogPageUrl = canonicalUrl;
    const ua = String(req.get('user-agent') || '');
    const isCrawler = isSharePreviewCrawler(ua);
    console.log(`[og/impact] token=${token} ua="${ua}" crawler=${isCrawler}`);

    const ogHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} | Unravel</title>
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(ogPageUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Unravel">
  <meta property="fb:app_id" content="${escapeHtml(FB_APP_ID)}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
</head>
<body><p>${escapeHtml(title)}</p></body>
</html>`;
    if (isCrawler) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.send(ogHtml);
    }

    return res.redirect(302, canonicalUrl);
  } catch (error) {
    console.error('OG impact error:', error);
    res.status(500).send('Error loading impact share card');
  }
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// GET passkey value from Firestore (passkey collection, document tKUoAVCdvkrbCjqnyf67)
app.get('/passkey', async (req: Request, res: Response) => {
  try {
    const docId = 'tKUoAVCdvkrbCjqnyf67';
    const doc = await db.collection('passkey').doc(docId).get();
    
    if (!doc.exists) {
      return res.status(404).json({ error: 'Passkey document not found' });
    }
    
    const data = doc.data();
    const pass = data?.pass;
    
    if (pass === undefined) {
      return res.status(404).json({ error: 'Pass field not found' });
    }
    
    res.json({ pass });
  } catch (error: unknown) {
    const err = error as { message?: string; code?: number };
    console.error('Error fetching passkey:', err?.message ?? error, err?.code);
    res.status(500).json({ error: 'Failed to fetch passkey', detail: err?.message ?? String(error) });
  }
});

// AI prompts document (contains ai_moderation and biaswheel_prompt fields)
const AI_PROMPTS_DOC_ID = 'ucZnWEWd4t1f32H9f9Tj';
app.get('/ai-prompts/ai-moderation', async (req: Request, res: Response) => {
  try {
    const doc = await db.collection('ai_prompts').doc(AI_PROMPTS_DOC_ID).get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'AI prompts document not found' });
    }

    const data = doc.data();
    const ai_moderation = data?.ai_moderation;

    if (ai_moderation === undefined) {
      return res.status(404).json({ error: 'ai_moderation field not found' });
    }

    res.json({ ai_moderation });
  } catch (error: unknown) {
    const err = error as { message?: string; code?: number };
    console.error('Error fetching AI moderation prompt:', err?.message ?? error, err?.code);
    res.status(500).json({ error: 'Failed to fetch AI moderation prompt', detail: err?.message ?? String(error) });
  }
});

// PUT - Update AI moderation prompt in Firestore
app.put('/ai-prompts/ai-moderation', async (req: Request, res: Response) => {
  try {
    const { ai_moderation } = req.body;

    if (ai_moderation === undefined) {
      return res.status(400).json({ error: 'ai_moderation is required in request body' });
    }

    if (typeof ai_moderation !== 'string') {
      return res.status(400).json({ error: 'ai_moderation must be a string' });
    }

    await db.collection('ai_prompts').doc(AI_PROMPTS_DOC_ID).set(
      { ai_moderation },
      { merge: true }
    );

    res.json({ ai_moderation, message: 'AI moderation prompt updated successfully' });
  } catch (error: unknown) {
    const err = error as { message?: string; code?: number };
    console.error('Error updating AI moderation prompt:', err?.message ?? error, err?.code);
    res.status(500).json({ error: 'Failed to update AI moderation prompt', detail: err?.message ?? String(error) });
  }
});

// GET - Fetch bias wheel prompt from Firestore (ai_prompts collection, field biashwheel_prompt)
app.get('/ai-prompts/bias-wheel', async (req: Request, res: Response) => {
  try {
    const doc = await db.collection('ai_prompts').doc(AI_PROMPTS_DOC_ID).get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Bias wheel prompts document not found' });
    }

    const data = doc.data();
    const biaswheel_prompt = data?.biashwheel_prompt ?? data?.biaswheel_prompt;

    if (biaswheel_prompt === undefined) {
      return res.status(404).json({ error: 'biashwheel_prompt field not found' });
    }

    res.json({ biaswheel_prompt });
  } catch (error: unknown) {
    const err = error as { message?: string; code?: number };
    console.error('Error fetching bias wheel prompt:', err?.message ?? error, err?.code);
    res.status(500).json({ error: 'Failed to fetch bias wheel prompt', detail: err?.message ?? String(error) });
  }
});

// PUT - Update bias wheel prompt in Firestore (saved under field biashwheel_prompt)
app.put('/ai-prompts/bias-wheel', async (req: Request, res: Response) => {
  try {
    const { biaswheel_prompt } = req.body;

    if (biaswheel_prompt === undefined) {
      return res.status(400).json({ error: 'biaswheel_prompt is required in request body' });
    }

    if (typeof biaswheel_prompt !== 'string') {
      return res.status(400).json({ error: 'biaswheel_prompt must be a string' });
    }

    await db.collection('ai_prompts').doc(AI_PROMPTS_DOC_ID).set(
      { biashwheel_prompt: biaswheel_prompt },
      { merge: true }
    );

    res.json({ biaswheel_prompt, message: 'Bias wheel prompt updated successfully' });
  } catch (error: unknown) {
    const err = error as { message?: string; code?: number };
    console.error('Error updating bias wheel prompt:', err?.message ?? error, err?.code);
    res.status(500).json({ error: 'Failed to update bias wheel prompt', detail: err?.message ?? String(error) });
  }
});

// Delete files from GCS by their public image URLs (e.g. .../images/fileName.png)
async function deleteGeneratedImagesFromGcs(imageUrls: string[]): Promise<void> {
  if (!imageUrls?.length) return;
  const bucketName = process.env.GCS_BUCKET || 'unravel-generated-images';
  const bucket = storage.bucket(bucketName);
  for (const url of imageUrls) {
    try {
      // URL may be full (https://.../images/foo.png) or path; extract fileName after /images/
      const match = url.match(/\/images\/([^/?#]+)/);
      const fileName = match ? match[1] : url.split('/').pop();
      if (!fileName) continue;
      const file = bucket.file(fileName);
      const [exists] = await file.exists();
      if (exists) {
        await file.delete();
        console.log('Deleted unused generated image from GCS:', fileName);
      }
    } catch (err: unknown) {
      console.error('Failed to delete image from GCS:', err);
      // Continue with other deletes
    }
  }
}

/** Sanitize campaign text/media fields on create and patch (not applied on generic PUT). */
function sanitizeCampaignContentFields(data: Record<string, unknown>): void {
  if (data.slideshow_back_button_url !== undefined) {
    data.slideshow_back_button_url = sanitizeSlideshowBackButtonUrl(data.slideshow_back_button_url);
  }

  if (data.campaign_sources !== undefined && data.campaign_sources !== null) {
    const lines = Array.isArray(data.campaign_sources)
      ? data.campaign_sources
      : String(data.campaign_sources).split('\n');
    const cleaned = lines
      .map((s: unknown) => String(s).trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, 30);
    if (cleaned.length > 0) data.campaign_sources = cleaned;
    else delete data.campaign_sources;
  }

  if (data.ad_primary_text !== undefined && data.ad_primary_text !== null) {
    const v = String(data.ad_primary_text).trim().slice(0, 200);
    if (v) data.ad_primary_text = v;
    else delete data.ad_primary_text;
  }
  if (data.ad_headline !== undefined && data.ad_headline !== null) {
    const v = String(data.ad_headline).trim().slice(0, 60);
    if (v) data.ad_headline = v;
    else delete data.ad_headline;
  }
  if (data.ad_image_url !== undefined && data.ad_image_url !== null) {
    const v = String(data.ad_image_url).trim();
    if (v) data.ad_image_url = v;
    else delete data.ad_image_url;
  }

  if (data.hero_slideshow !== undefined) {
    if (!Array.isArray(data.hero_slideshow)) {
      delete data.hero_slideshow;
    } else {
      data.hero_slideshow = (data.hero_slideshow as unknown[])
        .map((slide) => {
          if (!slide || typeof slide !== 'object') return null;
          const s = slide as Record<string, unknown>;
          const description = String(s.description ?? '').trim().slice(0, 2000);
          const youtubeVideoId = s.youtubeVideoId
            ? String(s.youtubeVideoId).trim().slice(0, 32)
            : undefined;
          const youtubeUrl = s.youtubeUrl ? String(s.youtubeUrl).trim().slice(0, 500) : undefined;
          const imageUrl = s.imageUrl ? String(s.imageUrl).trim().slice(0, 2048) : undefined;
          if (!description) return null;
          if (youtubeVideoId || youtubeUrl) {
            const out: Record<string, string> = { description };
            if (youtubeUrl) out.youtubeUrl = youtubeUrl;
            if (youtubeVideoId) out.youtubeVideoId = youtubeVideoId;
            return out;
          }
          if (imageUrl) return { description, imageUrl };
          return null;
        })
        .filter(Boolean)
        .slice(0, 30);
    }
  }

  if (data.thumbnail_url !== undefined && data.thumbnail_url !== null) {
    const v = String(data.thumbnail_url).trim();
    if (v) data.thumbnail_url = v;
    else delete data.thumbnail_url;
  }

  if (data.short_description !== undefined && data.short_description !== null) {
    data.short_description = String(data.short_description).trim().slice(0, 500);
  }
}

// POST - Create a new document
app.post('/data/:collection', async (req: Request, res: Response) => {
  try {
    const { collection } = req.params;
    const data = req.body;
    
    // AI moderation for campaigns
    let aiModerationRecommendation = '';
    if (collection === 'campaigns') {
      try {
        console.log('Running AI moderation analysis...');
        // Frontend sends short_description and long_description; combine for AI
        const descriptionForAI = [data.short_description, data.long_description]
          .filter(Boolean)
          .join('\n\n') || data.description || '';
        aiModerationRecommendation = await analyzeCampaignWithAI(
          data.title || '',
          descriptionForAI,
          data.short_description || data.tagline || ''
        );
        console.log('AI Moderation Result:', aiModerationRecommendation);
      } catch (aiError) {
        console.error('AI moderation failed:', aiError);
        aiModerationRecommendation = 'AI moderation analysis unavailable. Please review manually.';
      }
      
      // Set default status to "Pending" if not provided
      if (!data.status) {
        data.status = 'Pending';
      }
      // Funding goal is set by admin on approve; default to 0 when user creates campaign
      if (data.funding_goal === undefined || data.funding_goal === null) {
        data.funding_goal = 0;
      }
      // Set default funding_current to 0 (how much money was given to campaign)
      if (data.funding_current === undefined) {
        data.funding_current = 0;
      }
      // Set default impressions to 0 (how many people clicked on campaign)
      if (data.impressions === undefined) {
        data.impressions = 0;
      }
      // Delete unused generated images from GCS when user submits (keeps only selected image)
      const unusedGeneratedImageUrls = data.unusedGeneratedImageUrls;
      if (Array.isArray(unusedGeneratedImageUrls) && unusedGeneratedImageUrls.length > 0) {
        deleteGeneratedImagesFromGcs(unusedGeneratedImageUrls).catch((err) =>
          console.error('Delete unused images failed:', err)
        );
      }
      delete data.unusedGeneratedImageUrls; // do not store in Firestore

      sanitizeCampaignContentFields(data);

      // Creator UID from verified Firebase token only (not client-supplied).
      // Admin-created campaigns may set a public display name via creator_name.
      const isAdminCreated = data.admin_created === true || data.admin_created === 'true';
      const adminCreatorDisplay = isAdminCreated
        ? String(data.creator_name ?? data.creator ?? '').trim().slice(0, 120)
        : '';
      delete data.created_by;
      delete data.created_by_uid;
      delete data.creator;
      delete data.creator_name;
      delete data.creator_first_name;
      delete data.creator_last_name;
      delete data.creator_email;
      delete data.creator_username;
      if (req.firebaseUid) {
        data.created_by = req.firebaseUid;
        data.created_by_uid = req.firebaseUid;

        // Snapshot creator profile for display on campaign cards/detail pages.
        // Ownership remains tied to `created_by` UID. Prefer username when set.
        try {
          const userDoc = await usersDb.collection('users').doc(req.firebaseUid).get();
          const userData = userDoc.exists ? (userDoc.data() as Record<string, unknown>) : null;
          const fields = creatorFieldsFromUserProfile(userData);
          if (!fields.creator_email && req.firebaseEmail) {
            fields.creator_email = String(req.firebaseEmail).trim().toLowerCase();
          }
          Object.assign(data, fields);
        } catch (creatorProfileErr) {
          console.error('Failed to attach creator profile snapshot:', creatorProfileErr);
        }
      }

      if (isAdminCreated) {
        data.admin_created = true;
        // Public "by …" for admin campaigns uses the admin-entered display name only
        // (not the signed-in admin's personal username/profile).
        delete data.creator_username;
        delete data.creator_first_name;
        delete data.creator_last_name;
        if (adminCreatorDisplay) {
          data.creator = adminCreatorDisplay;
          data.creator_name = adminCreatorDisplay;
        } else {
          delete data.creator;
          delete data.creator_name;
        }
      }

      if (isUutsPrescreenEnabled()) {
        data.uuts_prescreen_status = 'queued';
        data.uuts_prescreen_attempts = 0;
        data.uuts_prescreen_error = null;
        data.uuts_prescreen_updated_at = new Date().toISOString();
      } else {
        data.uuts_prescreen_status = 'disabled';
        data.uuts_prescreen_attempts = 0;
        data.uuts_prescreen_error = null;
        data.uuts_prescreen_updated_at = new Date().toISOString();
      }
    }

    // Landers: own schema (snake_case + Firestore timestamps). No campaign moderation fields.
    if (collection === 'landers') {
      const lander = landerCreateFields(data as Record<string, unknown>);
      const doc: Record<string, unknown> = {
        ...lander,
        created_at: FieldValue.serverTimestamp(),
        updated_at: FieldValue.serverTimestamp(),
      };
      if (req.firebaseUid) doc.created_by = req.firebaseUid;
      const docRef = await db.collection('landers').add(doc);
      res.status(201).json({ id: docRef.id, message: 'Document created' });
      return;
    }

    const docRef = await db.collection(collection).add({
      ...data,
      ai_moderation_recommendation: aiModerationRecommendation,
      createdAt: new Date().toISOString()
    });

    // Denormalized list on user profile (default DB) for quick lookup; source of truth remains campaigns.created_by
    if (collection === 'campaigns' && req.firebaseUid) {
      try {
        await usersDb
          .collection('users')
          .doc(req.firebaseUid)
          .set(
            {
              createdCampaignIds: FieldValue.arrayUnion(docRef.id),
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          );
      } catch (userCampaignListErr) {
        console.error('Failed to append campaign id to user profile:', userCampaignListErr);
      }
    }

    // Send Slack notification for new campaigns
    if (collection === 'campaigns') {
      try {
        await slack.chat.postMessage({
          channel: process.env.SLACK_CHANNEL || 'moderation',
          text: `🆕 New Campaign Submitted for Moderation`,
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: '🆕 New Campaign Submitted' }
            },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*Title:*\n${data.title || 'N/A'}` },
                { type: 'mrkdwn', text: `*Category:*\n${data.category || 'N/A'}` },
                { type: 'mrkdwn', text: `*Funding Goal:*\n$${data.funding_goal || 0}` }
              ]
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `*Short Description:*\n${data.short_description || 'N/A'}` }
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `*Long Description:*\n${data.long_description || 'No description'}` }
            },
            {
              type: 'section',
              text: { 
                type: 'mrkdwn', 
                text: `*🤖 AI Moderation Recommendation:*\n${aiModerationRecommendation || 'Analysis pending...'}` 
              }
            },
            {
              type: 'context',
              elements: [
                { type: 'mrkdwn', text: `Campaign ID: \`${docRef.id}\`` },
                ...(data.created_by
                  ? [{ type: 'mrkdwn' as const, text: `Creator UID: \`${data.created_by}\`` }]
                  : [])
              ]
            }
          ]
        });
        console.log('Slack notification sent to #moderation');
      } catch (slackError) {
        console.error('Slack notification failed:', slackError);
        // Don't fail the request if Slack fails
      }
      // Bias wheel: run in background only. Do not await — user gets "campaign submitted" after AI moderation, not after bias wheel.
      void analyzeBiasWheelAndUpdate(docRef.id, data).catch((err) =>
        console.error('Bias wheel background task error:', err)
      );
      // UUTS pre-screen: opt-in via UUTS_PRESCREEN_ENABLED=true (off by default for safe deploys).
      if (isUutsPrescreenEnabled()) {
        void runUutsPrescreenAndPersist({
          db,
          vertexAI,
          campaignId: docRef.id,
          campaign: data,
          promptDocId: AI_PROMPTS_DOC_ID,
        }).catch((err) =>
          console.error('UUTS pre-screen background task error:', err)
        );
      }
    }
    
    res.status(201).json({ id: docRef.id, message: 'Document created' });
  } catch (error) {
    console.error('Error creating document:', error);
    res.status(500).json({ error: 'Failed to create document' });
  }
});

// PUT - Update a document (full update)
app.put('/data/:collection/:id', async (req: Request, res: Response) => {
  try {
    const { collection, id } = req.params;
    let data = req.body as Record<string, unknown>;
    if (collection === 'landers') {
      const lander = landerCreateFields(data);
      await db.collection(collection).doc(id).update({
        ...lander,
        updated_at: FieldValue.serverTimestamp(),
      });
      res.json({ message: 'Document updated' });
      return;
    }

    let durationDeleteFields: string[] = [];
    if (collection === 'campaigns') {
      const ref = db.collection(collection).doc(id);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'Document not found' });
      }
      const prev = snap.data() as Record<string, unknown>;
      sanitizeCampaignContentFields(data);
      const durationResult = applyCampaignDurationPatch(data, prev);
      if (!durationResult.ok) {
        return res.status(400).json({ error: durationResult.error });
      }
      data = durationResult.patch;
      durationDeleteFields = durationResult.deleteFields;
    }

    const updatePayload = buildCampaignUpdatePayload(data, durationDeleteFields);
    await db.collection(collection).doc(id).update(updatePayload);

    res.json({ message: 'Document updated' });
  } catch (error) {
    console.error('Error updating document:', error);
    res.status(500).json({ error: 'Failed to update document' });
  }
});

// PATCH - Partial update (e.g., status change)
app.patch('/data/:collection/:id', async (req: Request, res: Response) => {
  try {
    const { collection, id } = req.params;
    let data = req.body as Record<string, unknown>;
    if (collection === 'landers') {
      const patch = landerPatchFields(data);
      patch.updated_at = FieldValue.serverTimestamp();
      await db.collection(collection).doc(id).update(patch);
      res.json({ message: 'Document updated', id });
      return;
    }

    let stripeProductId: string | undefined;
    let stripeDonationPriceId: string | undefined;
    let durationDeleteFields: string[] = [];

    if (collection === 'campaigns') {
      const ref = db.collection(collection).doc(id);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: 'Document not found' });
      }
      const prev = snap.data() as Record<string, unknown>;

      const unusedGeneratedImageUrls = data.unusedGeneratedImageUrls;
      if (Array.isArray(unusedGeneratedImageUrls) && unusedGeneratedImageUrls.length > 0) {
        deleteGeneratedImagesFromGcs(unusedGeneratedImageUrls).catch((err) =>
          console.error('Delete unused images failed:', err)
        );
      }
      delete data.unusedGeneratedImageUrls;

      sanitizeCampaignContentFields(data);

      const durationResult = applyCampaignDurationPatch(data, prev);
      if (!durationResult.ok) {
        return res.status(400).json({ error: durationResult.error });
      }
      data = durationResult.patch;
      durationDeleteFields = durationResult.deleteFields;

      const impactMetricsResult = sanitizeCampaignImpactMetricsPatch(data);
      if (impactMetricsResult.error) {
        return res.status(400).json({ error: impactMetricsResult.error });
      }
      Object.assign(data, impactMetricsResult.patch);

      // Admin editor: allow setting/clearing the public creator display name.
      if (data.creator_name !== undefined || data.creator !== undefined) {
        const display = String(data.creator_name ?? data.creator ?? '').trim().slice(0, 120);
        if (display) {
          data.creator_name = display;
          data.creator = display;
        } else {
          data.creator_name = FieldValue.delete();
          data.creator = FieldValue.delete();
        }
      }

      // Admin approval: create a Stripe Product + pay-what-you-want Price once per campaign
      if (data.status === 'Approved' && stripe) {
        const existingPid = prev.stripe_product_id;
        if (typeof existingPid !== 'string' || !existingPid.trim()) {
          const merged = { ...prev, ...data };
          try {
            const created = await createStripeProductForApprovedCampaign(id, merged);
            stripeProductId = created.productId;
            stripeDonationPriceId = created.donationPriceId;
            console.log(
              `Stripe product ${created.productId} + donation price ${created.donationPriceId} for approved campaign ${id}`
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('Stripe product creation on approve failed:', err);
            return res.status(502).json({
              error: 'Could not create Stripe product; campaign was not updated.',
              details: message,
            });
          }
        }
      }
    }

    const updatePayload = buildCampaignUpdatePayload(data, durationDeleteFields);
    if (stripeProductId) {
      updatePayload.stripe_product_id = stripeProductId;
    }
    if (stripeDonationPriceId) {
      updatePayload.stripe_donation_price_id = stripeDonationPriceId;
    }

    await db.collection(collection).doc(id).update(updatePayload);

    const responseBody: Record<string, unknown> = {
      message: 'Document updated',
      id,
      ...data,
      ...(stripeProductId ? { stripe_product_id: stripeProductId } : {}),
      ...(stripeDonationPriceId ? { stripe_donation_price_id: stripeDonationPriceId } : {}),
    };

    res.json(
      collection === 'campaigns' ? enrichCampaignResponse(responseBody) : responseBody
    );
  } catch (error) {
    console.error('Error updating document:', error);
    res.status(500).json({ error: 'Failed to update document' });
  }
});

// DELETE - Delete a document
app.delete('/data/:collection/:id', async (req: Request, res: Response) => {
  try {
    const { collection, id } = req.params;
    let campaignCreatorUid: string | null = null;
    if (collection === 'campaigns') {
      const snap = await db.collection(collection).doc(id).get();
      if (snap.exists) {
        const createdBy = (snap.data() as Record<string, unknown> | undefined)?.created_by;
        if (typeof createdBy === 'string' && createdBy.trim()) {
          campaignCreatorUid = createdBy.trim();
        }
      }
    }
    await db.collection(collection).doc(id).delete();
    if (collection === 'campaigns' && campaignCreatorUid) {
      try {
        const userRef = usersDb.collection('users').doc(campaignCreatorUid);
        const userSnap = await userRef.get();
        if (userSnap.exists) {
          await userRef.update({
            createdCampaignIds: FieldValue.arrayRemove(id),
            updatedAt: new Date().toISOString(),
          });
        }
      } catch (userCampaignListErr) {
        console.error('Failed to remove campaign id from user profile:', userCampaignListErr);
      }
    }
    res.json({ message: 'Document deleted' });
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// POST - Upload a campaign image (base64 data URL or raw base64 → GCS, same bucket as generated images)
app.post('/upload-campaign-image', async (req: Request, res: Response) => {
  try {
    const { imageBase64 } = req.body as { imageBase64?: string };
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'imageBase64 is required' });
    }
    let rawBase64 = imageBase64.trim();
    let mimeType = 'image/png';
    const dataUrlMatch = rawBase64.match(/^data:([^;]+);base64,(.+)$/i);
    if (dataUrlMatch) {
      mimeType = dataUrlMatch[1] || mimeType;
      rawBase64 = dataUrlMatch[2];
    }
    const buffer = Buffer.from(rawBase64, 'base64');
    if (buffer.length > 15 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 15MB)' });
    }
    if (buffer.length < 32) {
      return res.status(400).json({ error: 'Invalid image data' });
    }
    const bucketName = process.env.GCS_BUCKET || 'unravel-generated-images';
    const bucket = storage.bucket(bucketName);
    const ext =
      mimeType.includes('jpeg') || mimeType.includes('jpg')
        ? 'jpg'
        : mimeType.includes('webp')
          ? 'webp'
          : mimeType.includes('gif')
            ? 'gif'
            : 'png';
    const fileName = `upload-${Date.now()}-${Math.random().toString(36).substring(2, 9)}.${ext}`;
    const file = bucket.file(fileName);
    await file.save(buffer, { metadata: { contentType: mimeType || 'image/png' } });
    const baseUrl = process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const imageUrl = `${baseUrl}/images/${fileName}`;
    res.json({ imageUrl, fileName });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('upload-campaign-image:', err?.message ?? error);
    res.status(500).json({ error: err?.message || 'Upload failed' });
  }
});

// ============ IMAGE GENERATION ============

type GeneratedImage = { imageBase64: string; imageUrl: string; storagePath: string; fileName: string };

// Generate a single image (one API call). Returns null on any failure (API error, no image, safety block).
async function generateSingleImage(description: string): Promise<GeneratedImage | null> {
  const modelName = process.env.GEMINI_MODEL_IMAGE_GENERATION || 'gemini-2.0-flash-exp';
  try {
    return await traceGeminiCall({
      name: 'generate-campaign-image',
      model: modelName,
      tags: ['image-generation'],
      metadata: {
        descriptionChars: String(description?.length || 0),
      },
      input: {
        description: description.length > 2000 ? `${description.slice(0, 2000)}…` : description,
      },
      run: async () => {
        const imagenModel = vertexAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
          } as any,
        });

        const result = await imagenModel.generateContent({
          contents: [{
            role: 'user',
            parts: [{ text: `Generate an image of: ${description}. Only respond with the image.` }],
          }],
        });

        const response = result.response;
        let imageData: string | null = null;
        let mimeType = 'image/png';

        const candidates = response.candidates || [];
        for (const candidate of candidates) {
          const parts = candidate.content?.parts || [];
          for (const part of parts) {
            const inlineData = (part as { inlineData?: { data: string; mimeType?: string } }).inlineData;
            if (inlineData?.data) {
              imageData = inlineData.data;
              mimeType = inlineData.mimeType || 'image/png';
              break;
            }
          }
          if (imageData) break;
        }

        if (!imageData) {
          console.warn('Image generation returned no image data (possible safety filter or empty response)');
          return {
            result: null,
            output: { imageGenerated: false, reason: 'no-image-data' },
            usageDetails: extractVertexUsage(result),
          };
        }

        const bucketName = process.env.GCS_BUCKET || 'unravel-generated-images';
        const bucket = storage.bucket(bucketName);
        const fileName = `generated-${Date.now()}-${Math.random().toString(36).substring(7)}.png`;
        const file = bucket.file(fileName);
        await file.save(Buffer.from(imageData, 'base64'), {
          metadata: { contentType: mimeType },
        });

        const generated: GeneratedImage = {
          imageBase64: `data:${mimeType};base64,${imageData}`,
          imageUrl: '',
          storagePath: `gs://${bucketName}/${fileName}`,
          fileName,
        };
        return {
          result: generated,
          // Never log raw base64 into Langfuse
          output: {
            imageGenerated: true,
            mimeType,
            fileName,
            storagePath: generated.storagePath,
          },
          usageDetails: extractVertexUsage(result),
        };
      },
    });
  } catch (error: unknown) {
    const err = error as { message?: string; code?: number };
    console.error('Error generating single image:', err?.message ?? error, err?.code);
    return null;
  }
}

// POST - Generate 3 images using Vertex AI and store in Cloud Storage
app.post('/generate-image', async (req: Request, res: Response) => {
  try {
    const { description, campaignId } = req.body;
    
    if (!description) {
      return res.status(400).json({ error: 'Description is required' });
    }
    
    console.log('Generating 3 images for:', description);
    
    // Generate 3 images in parallel (3 separate API calls); each can fail (rate limit, safety, no image)
    let imagePromises = [
      generateSingleImage(description),
      generateSingleImage(description),
      generateSingleImage(description),
    ];
    let images = await Promise.all(imagePromises);
    let successfulImages = images.filter((img): img is GeneratedImage => img !== null);

    // If we got fewer than 3, retry once for the missing count (improves consistency)
    if (successfulImages.length < 3) {
      const needed = 3 - successfulImages.length;
      console.log(`Got ${successfulImages.length} images, retrying for ${needed} more`);
      const retryPromises = Array.from({ length: needed }, () => generateSingleImage(description));
      const retryResults = await Promise.all(retryPromises);
      const extra = retryResults.filter((img): img is GeneratedImage => img !== null);
      successfulImages = [...successfulImages, ...extra];
    }
    
    if (successfulImages.length === 0) {
      return res.status(500).json({ error: 'Failed to generate any images' });
    }
    
    // Add proper URLs and IDs to each image (use API_BASE_URL so URLs work in production)
    const baseUrl = process.env.API_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const timestamp = Date.now();
    const imagesWithMetadata = successfulImages.map((img, index) => {
      const imageUrl = `${baseUrl}/images/${img.fileName}`;
      const id = `img-${timestamp}-${index}`;
      return {
        ...img,
        imageUrl,
        id,
        index: index + 1
      };
    });
    
    // If campaignId provided, store all generated images (user will pick one later)
    if (campaignId) {
      await db.collection('campaigns').doc(campaignId).update({
        generatedImages: imagesWithMetadata.map(img => ({
          imageUrl: img.imageUrl,
          storagePath: img.storagePath,
          fileName: img.fileName,
          id: img.id
        })),
        updatedAt: new Date().toISOString()
      });
      console.log(`Stored ${imagesWithMetadata.length} generated images for campaign`);
    }
    
    // Return simplified format for frontend (only imageBase64 and imageUrl)
    const simplifiedImages = imagesWithMetadata.map(img => ({
      imageBase64: img.imageBase64,
      imageUrl: img.imageUrl
    }));
    
    res.json({ 
      images: simplifiedImages
    });
    
  } catch (error: unknown) {
    const err = error as { message?: string; code?: number; status?: number };
    const detail = err?.message ?? String(error);
    console.error('Error generating images:', detail, err?.code, err?.status);
    res.status(500).json({ error: 'Failed to generate images', details: detail });
  }
});

// POST - Select official image from generated images
app.post('/select-image', async (req: Request, res: Response) => {
  try {
    const { campaignId, imageId, imageUrl } = req.body;
    
    if (!campaignId) {
      return res.status(400).json({ error: 'campaignId is required' });
    }
    
    if (!imageId && !imageUrl) {
      return res.status(400).json({ error: 'Either imageId or imageUrl is required' });
    }
    
    // Get the campaign to find the selected image
    const campaignDoc = await db.collection('campaigns').doc(campaignId).get();
    
    if (!campaignDoc.exists) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    
    const campaignData = campaignDoc.data();
    const generatedImages = campaignData?.generatedImages || [];
    
    // Find the selected image
    let selectedImage = null;
    if (imageId) {
      selectedImage = generatedImages.find((img: any) => img.id === imageId);
    } else if (imageUrl) {
      selectedImage = generatedImages.find((img: any) => img.imageUrl === imageUrl);
    }
    
    if (!selectedImage) {
      return res.status(404).json({ error: 'Selected image not found in generated images' });
    }
    
    // Update campaign with the selected image as the official thumbnail
    await db.collection('campaigns').doc(campaignId).update({
      thumbnail_url: selectedImage.imageUrl,
      imageStoragePath: selectedImage.storagePath,
      imageFileName: selectedImage.fileName,
      selectedImageId: selectedImage.id,
      updatedAt: new Date().toISOString()
    });
    
    console.log(`Campaign ${campaignId} updated with selected image: ${selectedImage.id}`);
    
    res.json({ 
      message: 'Image selected successfully',
      thumbnail_url: selectedImage.imageUrl,
      imageId: selectedImage.id
    });
    
  } catch (error: any) {
    console.error('Error selecting image:', error);
    res.status(500).json({ error: 'Failed to select image', details: error.message });
  }
});

// GET - Serve image from Cloud Storage (makes images publicly accessible via API)
app.get('/images/:fileName', async (req: Request, res: Response) => {
  try {
    const { fileName } = req.params;
    const bucketName = process.env.GCS_BUCKET || 'unravel-generated-images';
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(fileName);
    
    // Check if file exists
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    // Get file metadata for content type
    const [metadata] = await file.getMetadata();
    const contentType = metadata.contentType || 'image/png';
    
    // Stream the file to response
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
    
    file.createReadStream()
      .on('error', (err) => {
        console.error('Error streaming image:', err);
        res.status(500).json({ error: 'Failed to load image' });
      })
      .pipe(res);
      
  } catch (error: any) {
    console.error('Error serving image:', error);
    res.status(500).json({ error: 'Failed to serve image', details: error.message });
  }
});

// ============ STRIPE PAYMENTS ============

/** First origin from FRONTEND_ORIGIN (used for Checkout return URLs). */
function getPrimaryFrontendOrigin(): string {
  const raw = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
  return raw.split(',')[0].trim().replace(/\/$/, '');
}

/**
 * Admin utility: ensure an approved campaign has a Stripe Product + donation Price stored.
 * This is used to backfill older approved campaigns that predate Stripe product creation.
 */
app.post('/payments/campaign/:campaignId/ensure-stripe-product', async (req: Request, res: Response) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }
  try {
    const campaignId = String(req.params.campaignId || '').trim();
    if (!campaignId) {
      return res.status(400).json({ error: 'campaignId is required' });
    }

    const ref = db.collection('campaigns').doc(campaignId);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = (snap.data() || {}) as Record<string, unknown>;
    const status = String(campaign.status || '').trim();
    if (status !== 'Approved') {
      return res.status(400).json({ error: 'Only approved campaigns can have Stripe products created' });
    }

    const existingPidRaw = campaign.stripe_product_id;
    const existingPid =
      typeof existingPidRaw === 'string' && existingPidRaw.trim().startsWith('prod_')
        ? existingPidRaw.trim()
        : null;

    if (existingPid) {
      const donationPriceId = await getOrCreateStripeDonationPriceId(campaignId, existingPid);
      return res.json({
        ok: true,
        campaignId,
        stripe_product_id: existingPid,
        stripe_donation_price_id: donationPriceId,
        reused: true,
      });
    }

    const created = await createStripeProductForApprovedCampaign(campaignId, campaign);
    await ref.update({
      stripe_product_id: created.productId,
      stripe_donation_price_id: created.donationPriceId,
      updatedAt: new Date().toISOString(),
    });

    return res.json({
      ok: true,
      campaignId,
      stripe_product_id: created.productId,
      stripe_donation_price_id: created.donationPriceId,
      reused: false,
    });
  } catch (error: any) {
    console.error('Ensure Stripe product error:', error);
    return res.status(500).json({ error: error?.message || 'Failed to ensure Stripe product' });
  }
});

// GET - Return Stripe publishable key for frontend (no card data ever on server)
app.get('/payments/config', (req: Request, res: Response) => {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }
  res.json({ publishableKey });
});

/** Coerce a value to a trimmed Stripe-metadata-safe string (<=500 chars), or undefined. */
function sanitizeMetaValue(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > 500 ? t.slice(0, 500) : t;
}

/**
 * Return a Stripe Customer id for the given Firebase user, creating one (stamped with
 * firebase_uid + email) on first use and caching it on the user profile. Non-fatal:
 * returns undefined on any error so checkout still proceeds. (UE-154)
 */
async function ensureStripeCustomer(uid: string, email?: string): Promise<string | undefined> {
  if (!stripe) return undefined;
  try {
    const userRef = usersDb.collection('users').doc(uid);
    const snap = await userRef.get();
    const existing = snap.exists
      ? (snap.data() as Record<string, unknown>)?.stripe_customer_id
      : undefined;
    if (typeof existing === 'string' && existing.trim()) return existing.trim();

    const customer = await stripe.customers.create({
      ...(email ? { email } : {}),
      metadata: { firebase_uid: uid },
    });
    await userRef.set({ stripe_customer_id: customer.id }, { merge: true });
    return customer.id;
  } catch (err) {
    console.error('ensureStripeCustomer failed (non-fatal):', err);
    return undefined;
  }
}

interface CouponValidationResult {
  valid: boolean;
  reason?: string; // machine-readable rejection reason for the client to map to copy
  code?: string;
  grossCents?: number;
  discountCents?: number;
  netCents?: number;
}

/**
 * Validate a coupon against the `coupons` collection for a campaign + contribution amount.
 * Read-only: redemption counting happens at checkout, so this is safe to call repeatedly.
 * Returns the computed discount/net/gross when valid, or a machine-readable `reason` when not.
 * Custom coupon system — replaces Stripe-native promotion codes so we can validate (caps,
 * expiry, scope) and decide net-vs-zero BEFORE creating a Stripe transaction.
 */
async function validateCoupon(
  rawCode: string,
  campaignId: string,
  amountCents: number,
  donor?: { uid?: string; email?: string }
): Promise<CouponValidationResult> {
  const code = rawCode.trim().toUpperCase();
  if (!code) return { valid: false, reason: 'missing_code' };
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { valid: false, reason: 'invalid_amount' };
  }

  const snap = await db.collection('coupons').doc(code).get();
  if (!snap.exists) return { valid: false, reason: 'not_found' };
  const c = snap.data() as Record<string, unknown>;

  if (c.active !== true) return { valid: false, reason: 'inactive' };

  const expiresAt = typeof c.expires_at === 'string' ? c.expires_at : null;
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    return { valid: false, reason: 'expired' };
  }

  // Campaign scope is either the string 'all' or an array of campaign ids.
  const scope = c.campaign_scope;
  const inScope = scope === 'all' || (Array.isArray(scope) && scope.includes(campaignId));
  if (!inScope) return { valid: false, reason: 'not_applicable_to_campaign' };

  // Global redemption cap.
  const maxRedemptions = typeof c.max_redemptions === 'number' ? c.max_redemptions : null;
  const timesRedeemed = typeof c.times_redeemed === 'number' ? c.times_redeemed : 0;
  if (maxRedemptions != null && timesRedeemed >= maxRedemptions) {
    return { valid: false, reason: 'redemption_limit_reached' };
  }

  // Per-user limit (opt-in): a code flagged once_per_user may be redeemed only once per
  // identity — by Firebase uid for signed-in users, else by email (lander guests). Enforced
  // when we know who the donor is (checkout); redemptions are keyed off completed backings.
  if (c.once_per_user === true && donor && (donor.uid || donor.email)) {
    const priorSnap = await db.collection('stripe_checkout_records').where('coupon_code', '==', code).get();
    const already = priorSnap.docs.some((d) => {
      const r = d.data() as Record<string, unknown>;
      return (
        (!!donor.uid && r.donor_uid === donor.uid) ||
        (!!donor.email && typeof r.donor_email === 'string' && r.donor_email === donor.email)
      );
    });
    if (already) return { valid: false, reason: 'already_redeemed_by_user' };
  }

  // Compute the discount; it can never exceed the contribution, so net stays >= 0.
  let discountCents: number;
  if (c.type === 'amount_off' && typeof c.value === 'number') {
    discountCents = Math.min(Math.round(c.value), amountCents);
  } else if (c.type === 'percent_off' && typeof c.value === 'number') {
    discountCents = Math.min(Math.round((amountCents * c.value) / 100), amountCents);
  } else {
    return { valid: false, reason: 'invalid_coupon_config' };
  }

  return {
    valid: true,
    code,
    grossCents: amountCents,
    discountCents,
    netCents: amountCents - discountCents,
  };
}

/** Atomically count a coupon redemption. Idempotent per redemptionId (Stripe session id for
 * paid backings, or a generated id for zero-balance ones). */
async function recordCouponRedemption(
  code: string,
  redemptionId: string,
  info: { campaignId: string; grossCents: number; discountCents: number; uid?: string; email?: string }
): Promise<void> {
  const couponRef = db.collection('coupons').doc(code);
  const redemptionRef = couponRef.collection('redemptions').doc(redemptionId);
  await db.runTransaction(async (t) => {
    const existing = await t.get(redemptionRef);
    if (existing.exists) return; // already counted (retry) — don't double-count
    t.set(redemptionRef, {
      campaignId: info.campaignId,
      gross_cents: info.grossCents,
      discount_cents: info.discountCents,
      ...(info.uid ? { uid: info.uid } : {}),
      ...(info.email ? { email: info.email } : {}),
      redeemedAt: new Date().toISOString(),
    });
    t.update(couponRef, { times_redeemed: FieldValue.increment(1), updatedAt: new Date().toISOString() });
  });
}

/**
 * Record a coupon-covered backing that required no payment (net $0), skipping Stripe entirely.
 * Credits the GROSS contribution to the fund, writes the backing + contribution records, counts
 * the redemption, and emits the PostHog backing_completed event — parity with the Stripe path.
 * (UE-147 zero-balance path — the custom coupon system's reason for existing: no $0 Stripe order.)
 */
/** Sequential receipt number: UNRVL-YYYY-###### (per-year counter in `counters/receipts_YYYY`). */
async function nextReceiptNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const counterRef = db.collection('counters').doc(`receipts_${year}`);
  const seq = await db.runTransaction(async (t) => {
    const snap = await t.get(counterRef);
    const current = snap.exists ? Number((snap.data() as Record<string, unknown>)?.value || 0) : 0;
    const next = current + 1;
    t.set(counterRef, { value: next, updatedAt: new Date().toISOString() }, { merge: true });
    return next;
  });
  return `UNRVL-${year}-${String(seq).padStart(6, '0')}`;
}

async function recordCouponOnlyBacking(input: {
  campaignId: string;
  code: string;
  grossCents: number;
  discountCents: number;
  donorUid?: string;
  donorEmail?: string;
  donorName?: string;
  showName?: boolean;
  posthogDistinctId?: string;
  utmSource?: string;
  utmCampaign?: string;
  utmMedium?: string;
  utmTerm?: string;
  utmContent?: string;
  isGuest: boolean;
}): Promise<{ funding_current: number }> {
  const redemptionId = 'cpn_' + randomUUID();
  const recordedAt = new Date().toISOString();
  const campaignRef = db.collection('campaigns').doc(input.campaignId);
  const recordRef = db.collection('stripe_checkout_records').doc(redemptionId);

  let campaignTitle = 'Campaign';
  let campaignCategory: string | null = null;
  let campaignImageUrl: string | null = null;
  let campaignTrustScore: number | null = null;
  await db.runTransaction(async (t) => {
    const campSnap = await t.get(campaignRef);
    if (!campSnap.exists) throw new Error('Campaign not found');
    const data = campSnap.data() || {};
    campaignTitle = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'Campaign';
    campaignCategory = typeof data.category === 'string' ? data.category : null;
    campaignImageUrl = typeof data.thumbnail_url === 'string' ? data.thumbnail_url : null;
    campaignTrustScore = typeof data.trust_score === 'number' ? data.trust_score : null;
    const currentFunding = Number(data.funding_current ?? 0) || 0;
    t.update(campaignRef, { funding_current: currentFunding + input.grossCents / 100, updatedAt: recordedAt });
    t.set(recordRef, {
      campaignId: input.campaignId,
      amount_cents: input.grossCents, // gross contribution counts toward the fund
      amount_charged_cents: 0, // nothing charged — fully coupon-covered
      amount_discount_cents: input.discountCents,
      coupon_code: input.code,
      recordedAt,
      ...(input.donorUid ? { donor_uid: input.donorUid } : {}),
      ...(input.donorEmail ? { donor_email: input.donorEmail } : {}),
      ...(input.donorName ? { donor_name: input.donorName } : {}),
      ...(input.showName ? { show_name: true } : {}), // UE-186 social-proof opt-in
    });
  });

  if (input.donorUid) {
    await usersDb
      .collection('users').doc(input.donorUid)
      .collection('contributions').doc(redemptionId)
      .set({
        sessionId: redemptionId,
        campaignId: input.campaignId,
        campaignTitle,
        amount_cents: input.grossCents,
        amount_charged_cents: 0,
        amount_discount_cents: input.discountCents,
        coupon_code: input.code,
        currency: 'usd',
        recordedAt,
      });
  }

  await recordCouponRedemption(input.code, redemptionId, {
    campaignId: input.campaignId,
    grossCents: input.grossCents,
    discountCents: input.discountCents,
    uid: input.donorUid,
    email: input.donorEmail,
  });

  // Tracking parity with the Stripe path: coupon_backings + PostHog backing_completed.
  await upsertBacking({
    idKey: redemptionId,
    campaignId: input.campaignId,
    firebaseUid: input.donorUid ?? null,
    distinctId: input.donorUid || input.posthogDistinctId || null,
    isGuest: input.isGuest,
    email: input.donorEmail ?? null,
    stripeCustomerId: null,
    promoCode: input.code,
    amountTotal: 0, // nothing charged
    amountDiscount: input.discountCents,
    utmSource: input.utmSource ?? null,
    utmCampaign: input.utmCampaign ?? null,
    utmMedium: input.utmMedium ?? null,
    utmTerm: input.utmTerm ?? null,
    utmContent: input.utmContent ?? null,
    source: 'coupon_zero_balance',
  });

  // Show the SAME score the linked report page renders: prefer the published UUTS report
  // composite, and only fall back to the legacy campaign.trust_score when no report is
  // published (legacy is intentionally never synced to the composite). Best-effort.
  try {
    const published = await getPublishedTrustReport(db, input.campaignId, { id: input.campaignId });
    if (published && typeof published.composite === 'number') campaignTrustScore = published.composite;
  } catch { /* keep legacy campaign.trust_score */ }

  // Receipt + trust report email (best-effort — never block the backing on email delivery).
  if (input.donorEmail) {
    try {
      await sendContributionReceipt({
        campaignId: input.campaignId,
        campaignTitle,
        campaignCategory,
        campaignImageUrl,
        trustScore: campaignTrustScore,
        grossCents: input.grossCents,
        discountCents: input.discountCents,
        chargedCents: 0,
        couponCode: input.code,
        donorEmail: input.donorEmail,
        donorName: input.donorName,
        paymentMethodLabel: 'Coupon (no card)',
        receiptNumber: await nextReceiptNumber(),
        paidAtIso: recordedAt,
        frontendBaseUrl: getPrimaryFrontendOrigin(),
      });
    } catch (e) {
      console.error('[receipt] coupon-only send failed:', e instanceof Error ? e.message : e);
    }
  }

  const final = await campaignRef.get();
  return { funding_current: Number((final.data() || {}).funding_current ?? 0) || 0 };
}

// POST - Validate a coupon before checkout (custom coupon system). Read-only; does not redeem.
app.post('/coupons/validate', async (req: Request, res: Response) => {
  try {
    const { code, campaignId, amountCents, uid, email } = req.body as {
      code?: string;
      campaignId?: string;
      amountCents?: number;
      uid?: string;
      email?: string;
    };
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'code is required' });
    }
    if (typeof campaignId !== 'string' || !campaignId.trim()) {
      return res.status(400).json({ error: 'campaignId is required' });
    }
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amountCents must be a positive integer (cents)' });
    }

    const donor = {
      uid: typeof uid === 'string' && uid.trim() ? uid.trim() : undefined,
      email: typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : undefined,
    };
    const result = await validateCoupon(code, campaignId.trim(), amount, donor);
    res.json(result); // only { valid, reason?, code, grossCents, discountCents, netCents } — no internals
  } catch (error: any) {
    console.error('Coupon validate error:', error);
    res.status(500).json({ error: error?.message || 'Failed to validate coupon' });
  }
});

// GET - List all coupons (admin). x-api-key gated; the /admin UI is passkey-gated.
app.get('/coupons', async (_req: Request, res: Response) => {
  try {
    const snap = await db.collection('coupons').get();
    const coupons = snap.docs
      .map((d) => d.data())
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    res.json(coupons);
  } catch (error: any) {
    console.error('List coupons error:', error);
    res.status(500).json({ error: error?.message || 'Failed to list coupons' });
  }
});

// POST - Create a coupon (admin). Code is the uppercased doc id.
app.post('/coupons', async (req: Request, res: Response) => {
  try {
    const b = req.body as {
      code?: string;
      type?: string;
      value?: number;
      currency?: string;
      campaignScope?: unknown; // 'all' | string | string[]
      expiresAt?: string | null;
      maxRedemptions?: number | null;
      fundingSource?: string;
      oncePerUser?: boolean;
    };
    const code = typeof b.code === 'string' ? b.code.trim().toUpperCase() : '';
    if (!code) return res.status(400).json({ error: 'code is required' });
    if (b.type !== 'amount_off' && b.type !== 'percent_off') {
      return res.status(400).json({ error: "type must be 'amount_off' or 'percent_off'" });
    }
    const value = Number(b.value);
    if (!Number.isInteger(value) || value <= 0) {
      return res.status(400).json({ error: 'value must be a positive integer (cents for amount_off, percent for percent_off)' });
    }
    if (b.type === 'percent_off' && value > 100) {
      return res.status(400).json({ error: 'percent_off value must be between 1 and 100' });
    }

    const ref = db.collection('coupons').doc(code);
    if ((await ref.get()).exists) {
      return res.status(409).json({ error: 'A coupon with that code already exists' });
    }

    // Scope is 'all', a single campaign id (string), or an array of ids. Normalize a bare
    // campaign-id string to a one-element array so validateCoupon's array check matches it.
    const scope = b.campaignScope;
    let campaign_scope: 'all' | string[];
    if (Array.isArray(scope) && scope.length && scope.every((s) => typeof s === 'string')) {
      campaign_scope = scope as string[];
    } else if (typeof scope === 'string' && scope.trim() && scope.trim() !== 'all') {
      campaign_scope = [scope.trim()];
    } else {
      campaign_scope = 'all';
    }

    const coupon = {
      code,
      type: b.type,
      value,
      currency: (b.currency || 'usd').toLowerCase(),
      active: true,
      campaign_scope,
      expires_at: typeof b.expiresAt === 'string' && b.expiresAt.trim() ? b.expiresAt.trim() : null,
      max_redemptions:
        typeof b.maxRedemptions === 'number' && Number.isInteger(b.maxRedemptions) && b.maxRedemptions > 0
          ? b.maxRedemptions
          : null,
      funding_source: typeof b.fundingSource === 'string' && b.fundingSource.trim() ? b.fundingSource.trim() : null,
      once_per_user: b.oncePerUser === true,
      times_redeemed: 0,
      created_at: new Date().toISOString(),
    };
    await ref.set(coupon);
    res.status(201).json(coupon);
  } catch (error: any) {
    console.error('Create coupon error:', error);
    res.status(500).json({ error: error?.message || 'Failed to create coupon' });
  }
});

// PATCH - Update a coupon (admin). Any subset of the editable fields may be sent; the code
// itself is the doc id and is never renamed, and times_redeemed/created_at are never touched.
app.patch('/coupons/:code', async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const ref = db.collection('coupons').doc(code);
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Coupon not found' });
    }
    const existing = snap.data() as Record<string, unknown>;
    const b = req.body as {
      active?: boolean;
      type?: string;
      value?: number;
      campaignScope?: unknown; // 'all' | string | string[]
      expiresAt?: string | null;
      maxRedemptions?: number | null;
      oncePerUser?: boolean;
      fundingSource?: string | null;
    };
    const patch: Record<string, unknown> = {};

    if (typeof b.active === 'boolean') patch.active = b.active;
    if (typeof b.oncePerUser === 'boolean') patch.once_per_user = b.oncePerUser;

    // type + value validate together: the value's ceiling depends on the (possibly new) type.
    const effectiveType = b.type !== undefined ? b.type : (existing.type as string);
    if (b.type !== undefined) {
      if (b.type !== 'amount_off' && b.type !== 'percent_off') {
        return res.status(400).json({ error: "type must be 'amount_off' or 'percent_off'" });
      }
      patch.type = b.type;
    }
    if (b.value !== undefined) {
      const value = Number(b.value);
      if (!Number.isInteger(value) || value <= 0) {
        return res.status(400).json({ error: 'value must be a positive integer (cents for amount_off, percent for percent_off)' });
      }
      if (effectiveType === 'percent_off' && value > 100) {
        return res.status(400).json({ error: 'percent_off value must be between 1 and 100' });
      }
      patch.value = value;
    }

    if (b.campaignScope !== undefined) {
      const scope = b.campaignScope;
      if (Array.isArray(scope) && scope.length && scope.every((s) => typeof s === 'string')) {
        patch.campaign_scope = scope as string[];
      } else if (typeof scope === 'string' && scope.trim() && scope.trim() !== 'all') {
        patch.campaign_scope = [scope.trim()];
      } else {
        patch.campaign_scope = 'all';
      }
    }

    if (b.expiresAt === null || typeof b.expiresAt === 'string') {
      patch.expires_at = b.expiresAt && b.expiresAt.trim() ? b.expiresAt.trim() : null;
    }
    if (b.maxRedemptions === null || (typeof b.maxRedemptions === 'number' && Number.isInteger(b.maxRedemptions))) {
      patch.max_redemptions =
        typeof b.maxRedemptions === 'number' && b.maxRedemptions > 0 ? b.maxRedemptions : null;
    }
    if (b.fundingSource !== undefined) {
      patch.funding_source =
        typeof b.fundingSource === 'string' && b.fundingSource.trim() ? b.fundingSource.trim() : null;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }
    patch.updatedAt = new Date().toISOString();
    await ref.update(patch);
    res.json((await ref.get()).data());
  } catch (error: any) {
    console.error('Update coupon error:', error);
    res.status(500).json({ error: error?.message || 'Failed to update coupon' });
  }
});

// DELETE - permanently remove a coupon. Past redemptions in stripe_checkout_records are kept
// (they reference the code as a string), so reporting/traceability is unaffected.
app.delete('/coupons/:code', async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    const ref = db.collection('coupons').doc(code);
    if (!(await ref.get()).exists) {
      return res.status(404).json({ error: 'Coupon not found' });
    }
    await ref.delete();
    res.json({ ok: true, code });
  } catch (error: any) {
    console.error('Delete coupon error:', error);
    res.status(500).json({ error: error?.message || 'Failed to delete coupon' });
  }
});

// POST - Create payment: Stripe Checkout (pay-what-you-want Price on Product) when campaign has stripe_product_id; else PaymentIntent + Elements
app.post('/payments/create-payment-intent', async (req: Request, res: Response) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }
  try {
    const body = req.body as {
      amount?: number;
      fixedAmountCents?: number;
      campaignId?: string;
      currency?: string;
      checkoutCancelPath?: string;
      promoCode?: string;
      posthogDistinctId?: string;
      utm?: Record<string, unknown>;
      couponCode?: string;
      email?: string;
      name?: string;
      showName?: boolean;
    };
    const { amount: amountCents, campaignId, currency = 'usd' } = body;
    const cur = (currency || 'usd').toLowerCase();

    let stripeProductId: string | undefined;
    const cidTrim = typeof campaignId === 'string' ? campaignId.trim() : '';
    if (cidTrim) {
      const campSnap = await db.collection('campaigns').doc(cidTrim).get();
      if (campSnap.exists) {
        const pid = (campSnap.data() as Record<string, unknown>)?.stripe_product_id;
        if (typeof pid === 'string' && pid.trim()) {
          stripeProductId = pid.trim();
        }
      }
    }

    if (stripeProductId) {
      const base = getPrimaryFrontendOrigin();
      const donorUid = typeof req.firebaseUid === 'string' && req.firebaseUid.trim() ? req.firebaseUid.trim() : undefined;
      const tokenEmail =
        typeof req.firebaseEmail === 'string' && req.firebaseEmail.trim()
          ? req.firebaseEmail.trim().toLowerCase()
          : undefined;
      const bodyEmail =
        typeof body.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : undefined;
      // Guest zero-balance backings skip Stripe (no page to collect email), so accept the
      // lander-collected email as a fallback for receipts + per-user coupon limits.
      const donorEmail = tokenEmail || bodyEmail || undefined;
      // Full name for the receipt + trust-score email. Guests supply it on the lander form.
      const donorName =
        typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
      // UE-186 social proof: explicit opt-in to show the first name as a recent
      // backer. Default is anonymous ("Someone") — only an explicit true opts in.
      const showName = body.showName === true;

      // Acquisition + identity context (UE-154), stamped on the session so a redemption is
      // fully recoverable from the webhook.
      const posthogDistinctId = sanitizeMetaValue(body.posthogDistinctId);
      const utmIn = body.utm && typeof body.utm === 'object' ? body.utm : {};
      const utmSource = sanitizeMetaValue(utmIn.utm_source);
      const utmCampaign = sanitizeMetaValue(utmIn.utm_campaign);
      const utmMedium = sanitizeMetaValue(utmIn.utm_medium);
      const utmTerm = sanitizeMetaValue(utmIn.utm_term);
      const utmContent = sanitizeMetaValue(utmIn.utm_content);
      const isGuest = !donorUid;
      // Canonical distinct id everywhere: Firebase UID for logged-in users, else the guest's
      // PostHog distinct id. campaignId is preserved in metadata (below).
      const canonicalRef = donorUid || posthogDistinctId || undefined;

      /** Fixed donation amount = the gross the backer chose. Required to apply a coupon. */
      const fixedRaw = body.fixedAmountCents;
      const fixedParsed =
        typeof fixedRaw === 'number' && Number.isFinite(fixedRaw) ? Math.round(fixedRaw) : NaN;
      const useFixedAmount =
        Number.isFinite(fixedParsed) &&
        fixedParsed >= DONATION_CHECKOUT_MIN_CENTS &&
        fixedParsed <= 100_000_000; // $1M cap (cents)

      // Custom coupon: validate against our DB (server-authoritative) before Stripe. A coupon
      // needs a concrete amount to discount, so it only applies to fixed-amount checkouts.
      const couponCodeIn = typeof body.couponCode === 'string' ? body.couponCode.trim() : '';
      let coupon: CouponValidationResult | null = null;
      if (couponCodeIn && useFixedAmount) {
        coupon = await validateCoupon(couponCodeIn, cidTrim, fixedParsed, { uid: donorUid, email: donorEmail });
        if (!coupon.valid) {
          return res.status(400).json({ error: 'coupon_invalid', reason: coupon.reason });
        }
      }

      // Zero-balance: the coupon covers the full contribution → skip Stripe (no $0 order / fee),
      // credit the gross directly, and return without a redirect.
      if (coupon && coupon.netCents === 0) {
        const { funding_current } = await recordCouponOnlyBacking({
          campaignId: cidTrim,
          code: coupon.code!,
          grossCents: coupon.grossCents!,
          discountCents: coupon.discountCents!,
          donorUid,
          donorEmail,
          donorName,
          showName,
          posthogDistinctId: posthogDistinctId || undefined,
          utmSource: utmSource || undefined,
          utmCampaign: utmCampaign || undefined,
          utmMedium: utmMedium || undefined,
          utmTerm: utmTerm || undefined,
          utmContent: utmContent || undefined,
          isGuest,
        });
        return res.json({ ok: true, zeroBalance: true, funding_current });
      }

      // A coupon that leaves a positive net below Stripe's minimum can't be charged — reject
      // cleanly so the client can prompt a higher amount (rather than surfacing a Stripe 500).
      if (coupon && coupon.netCents! > 0 && coupon.netCents! < STRIPE_MIN_CHARGE_CENTS) {
        return res
          .status(400)
          .json({ error: 'coupon_invalid', reason: 'net_below_minimum', netCents: coupon.netCents });
      }

      // The coupon code is the authoritative promo for tracking; fall back to any passed code.
      const promoCode = coupon?.code || sanitizeMetaValue(body.promoCode);

      const checkoutMetadata: Record<string, string> = {
        campaignId: cidTrim, // kept for the existing /payments/record-checkout-session consumer
        campaign_id: cidTrim, // canonical key per the Eng Brief
        stripe_product_id: stripeProductId,
        is_guest: isGuest ? 'true' : 'false',
      };
      if (donorUid) {
        checkoutMetadata.donorUid = donorUid; // existing key
        checkoutMetadata.firebase_uid = donorUid; // canonical key per the Eng Brief
      }
      if (promoCode) checkoutMetadata.promo_code = promoCode;
      if (showName) checkoutMetadata.show_name = 'true'; // UE-186 social-proof opt-in
      if (posthogDistinctId) checkoutMetadata.posthog_distinct_id = posthogDistinctId;
      if (utmSource) checkoutMetadata.utm_source = utmSource;
      if (utmCampaign) checkoutMetadata.utm_campaign = utmCampaign;
      if (utmMedium) checkoutMetadata.utm_medium = utmMedium;
      if (utmTerm) checkoutMetadata.utm_term = utmTerm;
      if (utmContent) checkoutMetadata.utm_content = utmContent;
      if (coupon) {
        // We charge the net, but the fund must still credit the gross — carry both so the
        // recorder uses gross_cents (Stripe's amount_subtotal would only equal the net here).
        checkoutMetadata.coupon_code = coupon.code!;
        checkoutMetadata.gross_cents = String(coupon.grossCents);
        checkoutMetadata.discount_cents = String(coupon.discountCents);
      }

      // Stamp a reusable Stripe Customer with firebase_uid + email (logged-in only).
      const stripeCustomerId = donorUid
        ? await ensureStripeCustomer(donorUid, donorEmail)
        : undefined;

      const cancelRel =
        typeof body.checkoutCancelPath === 'string' &&
        body.checkoutCancelPath.startsWith('/') &&
        body.checkoutCancelPath.length <= 512
          ? body.checkoutCancelPath.trim()
          : `/campaign/${encodeURIComponent(cidTrim)}/back`;

      const sessionCommon = {
        mode: 'payment' as const,
        ...(canonicalRef ? { client_reference_id: canonicalRef } : {}),
        // UE-185: land on the full-screen thank-you interstitial (it records the
        // session, shows verified impact, and offers the share module).
        success_url: `${base}/campaign/${encodeURIComponent(cidTrim)}/thanks?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}${cancelRel}`,
        submit_type: 'pay' as const,
        // A stamped Customer and customer_email are mutually exclusive in Checkout.
        ...(stripeCustomerId
          ? { customer: stripeCustomerId }
          : donorEmail
            ? { customer_email: donorEmail }
            : {}),
        custom_text: {
          submit: {
            message: 'Fund this campaign — complete your secure payment below.',
          },
          // Note shown below the Pay button (Stripe's only custom-text slot; the left-side
          // order summary is Stripe-controlled and can't take custom lines).
          after_submit: {
            message:
              'Upon confirmation, a link to the copy of your trust score report will be available on your email receipt. Thanks for supporting The Unravel Network!',
          },
        },
        // Generate a finalized invoice (downloadable PDF + hosted page) for every paid session.
        invoice_creation: {
          enabled: true,
          invoice_data: {
            description: 'Donation to campaign',
            footer: 'Thank you for supporting this campaign.',
            metadata: checkoutMetadata,
          },
        },
        metadata: checkoutMetadata,
        payment_intent_data: {
          metadata: checkoutMetadata,
        },
        // Coupons are applied by the platform before Stripe (custom system), so Stripe-native
        // promotion codes are intentionally not enabled here.
      };

      if (useFixedAmount) {
        // Show the receipt-style breakdown on Stripe's checkout page: two line items that sum to
        // the GROSS (80% ad amplification / 20% platform fee), plus a discount line for any
        // coupon — so Stripe renders subtotal (gross) → discount → total (net), like the receipt.
        const adBudgetCents = Math.round(fixedParsed * AD_AMPLIFICATION_SPLIT);
        const platformFeeCents = fixedParsed - adBudgetCents; // exact remainder ≈ 20%
        const feePct = Math.round((1 - AD_AMPLIFICATION_SPLIT) * 100);
        const line_items = [
          {
            quantity: 1,
            price_data: {
              currency: cur,
              unit_amount: adBudgetCents,
              product_data: {
                name: 'Ad amplification budget',
                description: 'Deployed in full to social platforms to boost your campaign.',
              },
            },
          },
          {
            quantity: 1,
            price_data: {
              currency: cur,
              unit_amount: platformFeeCents,
              product_data: {
                name: `Platform fee (${feePct}%)`,
                description: 'Campaign review, ad operations, distribution, moderation & Unravel operations.',
              },
            },
          },
        ];

        // A coupon reduces the total via a one-off Stripe discount so Stripe shows the discount
        // line and charges the net; the campaign fund still credits the gross (metadata.gross_cents).
        let discounts: { coupon: string }[] | undefined;
        if (coupon && coupon.discountCents! > 0) {
          const stripeCoupon = await stripe.coupons.create({
            amount_off: coupon.discountCents!,
            currency: cur,
            duration: 'once',
            name: `Coupon ${coupon.code}`,
          });
          discounts = [{ coupon: stripeCoupon.id }];
        }

        const session = await stripe.checkout.sessions.create({
          ...sessionCommon,
          line_items,
          ...(discounts ? { discounts } : {}),
        });
        return res.json({ checkoutUrl: session.url });
      }

      const priceId = await getOrCreateStripeDonationPriceId(cidTrim, stripeProductId);
      const session = await stripe.checkout.sessions.create({
        ...sessionCommon,
        line_items: [{ price: priceId, quantity: 1 }],
      });
      return res.json({ checkoutUrl: session.url });
    }

    const amount = Math.round(Number(amountCents));
    if (!Number.isFinite(amount) || amount < 500) {
      return res.status(400).json({ error: 'Invalid amount; minimum is $5.00' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: cur,
      payment_method_types: ['card'],
      metadata: cidTrim ? { campaignId: cidTrim } : {},
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error: any) {
    console.error('Stripe create PaymentIntent error:', error);
    res.status(500).json({ error: error?.message || 'Failed to create payment intent' });
  }
});

// POST - After Checkout success: record contribution once per session (idempotent)
app.post('/payments/record-checkout-session', async (req: Request, res: Response) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured' });
  }
  try {
    const { sessionId } = req.body as { sessionId?: string };
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    const sid = sessionId.trim();
    const session = await stripe.checkout.sessions.retrieve(sid, {
      expand: ['invoice'],
    });
    if (session.payment_status !== 'paid') {
      // UE-185: `pending` lets the thank-you page render its optimistic
      // "Confirming your contribution…" state and retry, instead of failing.
      return res.status(400).json({ error: 'This checkout session is not paid yet.', pending: true });
    }
    const campaignId = session.metadata?.campaignId;
    if (!campaignId || typeof campaignId !== 'string') {
      return res.status(400).json({ error: 'Invalid session: missing campaign' });
    }
    // Count the GROSS contribution toward the fund, not the post-coupon charge. For custom
    // coupons we charge the net directly, so Stripe's amount_subtotal equals the net — the
    // true gross/discount ride in metadata. Fall back to Stripe's fields otherwise. (UE-147)
    const md = session.metadata || {};
    const metaGross = md.gross_cents != null ? Number(md.gross_cents) : NaN;
    const metaDiscount = md.discount_cents != null ? Number(md.discount_cents) : NaN;
    const couponCode = typeof md.coupon_code === 'string' && md.coupon_code.trim() ? md.coupon_code.trim() : null;
    const amountChargedCents = session.amount_total ?? 0; // actually charged, post-coupon
    const amountDiscountCents = Number.isFinite(metaDiscount)
      ? metaDiscount
      : session.total_details?.amount_discount ?? 0;
    const amountGrossCents = Number.isFinite(metaGross)
      ? metaGross
      : session.amount_subtotal ?? amountChargedCents + amountDiscountCents;
    if (amountGrossCents < 0) {
      return res.status(400).json({ error: 'Invalid payment amount' });
    }

    // Invoice document generated by Checkout's invoice_creation (PDF + hosted page).
    const invoice =
      session.invoice && typeof session.invoice !== 'string' ? session.invoice : null;
    const invoicePdf = invoice?.invoice_pdf ?? null;
    const hostedInvoiceUrl = invoice?.hosted_invoice_url ?? null;
    const invoiceNumber = invoice?.number ?? null;

    const metadataDonorUid =
      typeof session.metadata?.donorUid === 'string' && session.metadata.donorUid.trim()
        ? session.metadata.donorUid.trim()
        : undefined;
    const donorUid =
      metadataDonorUid ||
      (typeof req.firebaseUid === 'string' && req.firebaseUid.trim() ? req.firebaseUid.trim() : undefined);
    // Email Stripe collected at checkout — kept for receipts + coupon↔user traceability,
    // especially for guests (who have no uid).
    const donorEmail =
      (session.customer_details?.email || session.customer_email || '').trim().toLowerCase() || undefined;
    // UE-186 social-proof opt-in, carried through the Checkout Session metadata.
    const showName = session.metadata?.show_name === 'true';
    const recordedAt = new Date().toISOString();

    const recordRef = db.collection('stripe_checkout_records').doc(sid);
    const campaignRef = db.collection('campaigns').doc(campaignId.trim());

    let campaignTitle = 'Campaign';
    let campaignCategory: string | null = null;
    let campaignImageUrl: string | null = null;
    let campaignTrustScore: number | null = null;
    let wroteNewRecord = false;

    await db.runTransaction(async (t) => {
      const recSnap = await t.get(recordRef);
      if (recSnap.exists) {
        return;
      }
      const campSnap = await t.get(campaignRef);
      if (!campSnap.exists) {
        throw new Error('Campaign not found');
      }
      const data = campSnap.data() || {};
      campaignTitle = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'Campaign';
      campaignCategory = typeof data.category === 'string' ? data.category : null;
      campaignImageUrl = typeof data.thumbnail_url === 'string' ? data.thumbnail_url : null;
      campaignTrustScore = typeof data.trust_score === 'number' ? data.trust_score : null;
      const currentFunding = Number(data.funding_current ?? 0) || 0;
      const newFunding = currentFunding + amountGrossCents / 100;
      t.set(recordRef, {
        campaignId: campaignId.trim(),
        amount_cents: amountGrossCents, // gross contribution — what counts toward the fund
        amount_charged_cents: amountChargedCents, // actually charged after any coupon
        amount_discount_cents: amountDiscountCents,
        recordedAt,
        invoice_pdf: invoicePdf,
        hosted_invoice_url: hostedInvoiceUrl,
        invoice_number: invoiceNumber,
        ...(couponCode ? { coupon_code: couponCode } : {}),
        ...(donorUid ? { donor_uid: donorUid } : {}),
        ...(donorEmail ? { donor_email: donorEmail } : {}),
        ...(showName ? { show_name: true } : {}), // UE-186 social-proof opt-in
      });
      t.update(campaignRef, {
        funding_current: newFunding,
        updatedAt: recordedAt,
      });
      wroteNewRecord = true;
    });

    if (wroteNewRecord && donorUid) {
      const contributionRef = usersDb.collection('users').doc(donorUid).collection('contributions').doc(sid);
      await contributionRef.set({
        sessionId: sid,
        campaignId: campaignId.trim(),
        campaignTitle,
        amount_cents: amountGrossCents, // gross contribution (UE-147)
        amount_charged_cents: amountChargedCents,
        amount_discount_cents: amountDiscountCents,
        currency: (session.currency || 'usd').toLowerCase(),
        recordedAt,
        invoice_pdf: invoicePdf,
        hosted_invoice_url: hostedInvoiceUrl,
        invoice_number: invoiceNumber,
        ...(couponCode ? { coupon_code: couponCode } : {}),
      });
    }

    // Count the coupon redemption once per session (partial-discount Stripe path).
    if (wroteNewRecord && couponCode) {
      await recordCouponRedemption(couponCode, sid, {
        campaignId: campaignId.trim(),
        grossCents: amountGrossCents,
        discountCents: amountDiscountCents,
        uid: donorUid,
        email: session.customer_details?.email || undefined,
      });
    }

    // Receipt + trust report email — once per session (guarded by wroteNewRecord so a webhook
    // + client double-fire doesn't double-send). Best-effort; never fails the recording.
    if (wroteNewRecord && donorEmail) {
      // Show the SAME score the linked report page renders: prefer the published UUTS report
      // composite, falling back to the legacy campaign.trust_score only when none is published.
      try {
        const published = await getPublishedTrustReport(db, campaignId.trim(), { id: campaignId.trim() });
        if (published && typeof published.composite === 'number') campaignTrustScore = published.composite;
      } catch { /* keep legacy campaign.trust_score */ }
      try {
        await sendContributionReceipt({
          campaignId: campaignId.trim(),
          campaignTitle,
          campaignCategory,
          campaignImageUrl,
          trustScore: campaignTrustScore,
          grossCents: amountGrossCents,
          discountCents: amountDiscountCents,
          chargedCents: amountChargedCents,
          couponCode: couponCode || null,
          donorEmail,
          donorName: session.customer_details?.name || undefined,
          paymentMethodLabel: 'Card',
          receiptNumber: await nextReceiptNumber(),
          paidAtIso: recordedAt,
          frontendBaseUrl: getPrimaryFrontendOrigin(),
        });
      } catch (e) {
        console.error('[receipt] paid send failed:', e instanceof Error ? e.message : e);
      }
    }

    const final = await campaignRef.get();
    const funding_current = Number((final.data() || {}).funding_current ?? 0) || 0;
    res.json({
      ok: true,
      funding_current,
      // UE-185: server-verified figures for the thank-you interstitial — the
      // impact statement renders from these, never from client-side state.
      campaignId: campaignId.trim(),
      amount_gross_cents: amountGrossCents,
      amount_charged_cents: amountChargedCents,
      amount_discount_cents: amountDiscountCents,
      receipt: {
        invoicePdf,
        hostedInvoiceUrl,
        invoiceNumber,
      },
    });
  } catch (error: any) {
    console.error('Record checkout session error:', error);
    if (error?.message === 'Campaign not found') {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.status(500).json({ error: error?.message || 'Failed to record checkout' });
  }
});

// POST - Record a successful payment: add amount to campaign's amount_raised (called by frontend after Stripe confirms)
app.post('/payments/record-contribution', async (req: Request, res: Response) => {
  try {
    const { campaignId, amount: amountCents } = req.body as { campaignId?: string; amount?: number };
    if (!campaignId || typeof campaignId !== 'string' || campaignId.trim() === '') {
      return res.status(400).json({ error: 'campaignId is required' });
    }
    const amount = Math.round(Number(amountCents));
    if (!Number.isFinite(amount) || amount < 500) {
      return res.status(400).json({ error: 'Invalid amount; minimum is $5.00' });
    }
    const amountDollars = amount / 100;
    const ref = db.collection('campaigns').doc(campaignId.trim());
    const doc = await ref.get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const data = doc.data() || {};
    const currentFunding = Number(data.funding_current ?? 0) || 0;
    const newFunding = currentFunding + amountDollars;
    await ref.update({ funding_current: newFunding });
    res.json({ ok: true, funding_current: newFunding });
  } catch (error: any) {
    console.error('Record contribution error:', error);
    res.status(500).json({ error: error?.message || 'Failed to record contribution' });
  }
});

// ============ FACEBOOK AD PUBLISHING ============
// Requires .env: FACEBOOK_ACCESS_TOKEN, FACEBOOK_AD_ACCOUNT_ID, FACEBOOK_PAGE_ID, FRONTEND_BASE_URL

function toISO(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '-0000');
}

/** Extract a readable error message from Facebook SDK or generic Error. */
function getFacebookErrorMessage(error: any, step?: string): string {
  const stepPrefix = step ? `[${step}] ` : '';
  if (!error) return stepPrefix + 'Unknown error';
  const msg = error?.message || error?.error?.message || '';
  const userMsg = error?.error?.error_user_msg ?? error?.error_user_msg ?? error?.error?.error_user_title;
  const code = error?.code ?? error?.error?.code;
  const subcode = error?.error_subcode ?? error?.error?.error_subcode;
  const full = error?.error?.error_data ?? error?.error_data;
  const parts: string[] = [];
  if (userMsg && String(userMsg).trim()) parts.push(String(userMsg).trim());
  else if (msg && String(msg).trim()) parts.push(String(msg).trim());
  if (code != null) parts.push(`(code: ${code}` + (subcode != null ? `, subcode: ${subcode}` : '') + ')');
  if (full && typeof full === 'string') parts.push(full);
  const message = parts.length ? parts.join(' ') : 'Facebook API request failed';
  return stepPrefix + message;
}

/** Poster URL for Meta link_data.picture when the first hero slide is a YouTube embed (no imageUrl). */
function heroSlideYoutubePosterCandidate(slide: unknown): string {
  if (!slide || typeof slide !== 'object') return '';
  const o = slide as Record<string, unknown>;
  const idRaw = typeof o.youtubeVideoId === 'string' ? o.youtubeVideoId.trim() : '';
  if (/^[\w-]{11}$/.test(idRaw)) {
    return `https://img.youtube.com/vi/${idRaw}/maxresdefault.jpg`;
  }
  const url = typeof o.youtubeUrl === 'string' ? o.youtubeUrl.trim() : '';
  if (!url) return '';
  try {
    let ustr = url;
    if (!/^https?:\/\//i.test(ustr)) ustr = `https://${ustr}`;
    const u = new URL(ustr);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    let vid = '';
    if (host === 'youtu.be') {
      vid = (u.pathname.slice(1).split('/')[0] || '').split('?')[0];
    } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const v = u.searchParams.get('v');
      if (v) vid = v;
      else {
        const m = u.pathname.match(/\/(?:shorts|embed|v)\/([\w-]{11})/);
        if (m) vid = m[1];
      }
    }
    if (/^[\w-]{11}$/.test(vid)) return `https://img.youtube.com/vi/${vid}/maxresdefault.jpg`;
  } catch {
    /* ignore */
  }
  return '';
}

/** Resolves link_data.picture like all campaign types: dedicated ad_image_url first; then campaign thumbnail_url; slideshow falls back to hero_slideshow[0].imageUrl; optional thumbnailOverride last. Absolutizes paths and rewrites localhost to API_BASE_URL. */
function resolveCreativeImageUrlForFacebookAd(data: any, thumbnailOverride?: string): string {
  const apiPublicBase = (process.env.API_BASE_URL || '').replace(/\/$/, '');

  const isUnscrapableLocalUrl = (urlStr: string): boolean => {
    try {
      const u = new URL(urlStr);
      const h = u.hostname.toLowerCase();
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    } catch {
      return false;
    }
  };

  const absolutize = (raw: string): string => {
    const s = (raw || '').trim();
    if (!s) return '';
    if (s.startsWith('data:')) return '';
    if (s.startsWith('https://')) {
      // Meta cannot fetch images from your machine; only public URLs work for link_data.picture.
      if (isUnscrapableLocalUrl(s) && !apiPublicBase) return '';
      if (apiPublicBase && isUnscrapableLocalUrl(s)) {
        try {
          const u = new URL(s);
          return `${apiPublicBase}${u.pathname}${u.search}`;
        } catch {
          return '';
        }
      }
      return s;
    }
    if (s.startsWith('http://')) {
      if (isUnscrapableLocalUrl(s)) {
        if (apiPublicBase) {
          try {
            const u = new URL(s);
            return `${apiPublicBase}${u.pathname}${u.search}`;
          } catch {
            return '';
          }
        }
        return '';
      }
      return s;
    }
    if (s.startsWith('/')) {
      return apiPublicBase ? `${apiPublicBase}${s}` : '';
    }
    if (!s.includes('/') && !s.includes(':')) {
      return apiPublicBase ? `${apiPublicBase}/images/${s}` : '';
    }
    return '';
  };

  const candidates: string[] = [];
  const adImageUrl = String(data?.ad_image_url ?? '').trim();
  if (adImageUrl) candidates.push(adImageUrl);
  const thumb = String(data?.thumbnail_url ?? '').trim();
  if (thumb) candidates.push(thumb);
  const slides = data?.hero_slideshow;
  if (Array.isArray(slides) && slides[0]) {
    const s0 = slides[0] as Record<string, unknown>;
    if (s0.imageUrl) candidates.push(String(s0.imageUrl).trim());
    const ytPoster = heroSlideYoutubePosterCandidate(s0);
    if (ytPoster) candidates.push(ytPoster);
  }
  if (typeof thumbnailOverride === 'string' && thumbnailOverride.trim()) {
    candidates.push(thumbnailOverride.trim());
  }

  for (const raw of candidates) {
    const resolved = absolutize(raw);
    if (resolved && (resolved.startsWith('https://') || resolved.startsWith('http://'))) {
      return resolved;
    }
  }

  return 'https://www.facebook.com/images/fb_icon_325x325.png';
}

async function publishFacebookAdForCampaign(
  campaignId: string,
  thumbnailOverride?: string
): Promise<{ campaignId: string; adId: string }> {
  const bizSdk = require('facebook-nodejs-business-sdk');
  const AdAccount = bizSdk.AdAccount;
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
  const adAccountId = process.env.FACEBOOK_AD_ACCOUNT_ID;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const frontendBaseUrl = (process.env.FRONTEND_BASE_URL || '').replace(/\/$/, '');

  if (!accessToken || !adAccountId || !pageId || !frontendBaseUrl) {
    throw new Error('Facebook ad config missing: set FACEBOOK_ACCESS_TOKEN, FACEBOOK_AD_ACCOUNT_ID, FACEBOOK_PAGE_ID, FRONTEND_BASE_URL in .env');
  }

  const doc = await db.collection('campaigns').doc(campaignId).get();
  if (!doc.exists) {
    throw new Error('Campaign not found');
  }
  const data = doc.data() as any;
  const status = data?.status;
  if (status !== 'Approved') {
    throw new Error('Only approved campaigns can be published to Facebook');
  }

  const title = (data?.title as string) || 'Campaign';
  const shortDescription = String(data?.short_description ?? data?.tagline ?? data?.description ?? '');
  const primaryText = String(data?.ad_primary_text ?? '').trim() || shortDescription;
  const headline = String(data?.ad_headline ?? '').trim() || title;
  const imageUrl = resolveCreativeImageUrlForFacebookAd(data, thumbnailOverride);
  const landingUrl = `${frontendBaseUrl}/campaign/${campaignId}`;

  const api = bizSdk.FacebookAdsApi.init(accessToken);
  api.setDebug(false);
  const account = new AdAccount(adAccountId);
  const baseName = title.slice(0, 80) + ' ' + Date.now();

  let fbCampaignId: string;
  try {
    const campaign = await account.createCampaign([], {
      name: baseName + ' Campaign',
      objective: 'OUTCOME_TRAFFIC',
status: 'PAUSED',
    special_ad_categories: [],
    is_adset_budget_sharing_enabled: false,
  });
  fbCampaignId = campaign.id;
  } catch (err: any) {
    console.error('Facebook createCampaign failed:', err?.response ?? err);
    throw new Error(getFacebookErrorMessage(err, 'Create Campaign'));
  }

  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + 3);
  const targeting = {
    geo_locations: { countries: ['US'] },
    publisher_platforms: ['facebook', 'audience_network'],
    facebook_positions: ['feed'],
  };
  let adSetId: string;
  try {
    const adSet = await account.createAdSet([], {
      name: baseName + ' Ad Set',
      campaign_id: fbCampaignId,
      daily_budget: '100',
      bid_amount: '10',
      start_time: toISO(start),
      end_time: toISO(end),
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LINK_CLICKS',
      targeting: JSON.stringify(targeting),
      status: 'PAUSED',
    });
    adSetId = adSet.id;
  } catch (err: any) {
    console.error('Facebook createAdSet failed:', err?.response ?? err);
    throw new Error(getFacebookErrorMessage(err, 'Create Ad Set'));
  }

  let creativeId: string;
  try {
    const creative = await account.createAdCreative([], {
      name: baseName + ' Creative',
      object_story_spec: JSON.stringify({
        page_id: pageId,
        link_data: {
          link: landingUrl,
          message: primaryText.slice(0, 125) || title,
          name: headline.slice(0, 40),
          picture: imageUrl,
          call_to_action: { type: 'LEARN_MORE', value: { link: landingUrl } },
        },
      }),
    });
    creativeId = creative.id;
  } catch (err: any) {
    console.error('Facebook createAdCreative failed:', err?.response ?? err);
    throw new Error(getFacebookErrorMessage(err, 'Create Creative'));
  }

  let adId: string;
  try {
    const ad = await account.createAd([], {
      name: baseName + ' Ad',
      adset_id: adSetId,
      creative: JSON.stringify({ creative_id: creativeId }),
      status: 'PAUSED',
    });
    adId = ad.id;
  } catch (err: any) {
    console.error('Facebook createAd failed:', err?.response ?? err);
    throw new Error(getFacebookErrorMessage(err, 'Create Ad'));
  }

  await db.collection('campaigns').doc(campaignId).update({
    facebook_ad_id: adId,
    facebook_campaign_id: fbCampaignId,
    facebook_ad_set_id: adSetId,
    facebook_published_at: new Date(),
  });

  return { campaignId: fbCampaignId, adId };
}

app.post('/facebook/publish-ad', async (req: Request, res: Response) => {
  const { campaignId, thumbnail_url } = req.body;
  if (!campaignId || typeof campaignId !== 'string') {
    return res.status(400).json({ error: 'campaignId is required' });
  }
  const thumbnailOverride =
    typeof thumbnail_url === 'string' && thumbnail_url.trim() ? thumbnail_url.trim() : undefined;
  try {
    const result = await publishFacebookAdForCampaign(campaignId, thumbnailOverride);
    return res.json({ ok: true, ...result });
  } catch (error: any) {
    const message = error?.message || 'Failed to publish ad to Facebook';
    console.error('Facebook publish-ad error:', message, error);
    return res.status(500).json({ error: message });
  }
});

// GET Facebook ad insights for a campaign (impressions, reach, clicks, spend, etc.)
app.get('/facebook/campaign/:campaignId/insights', async (req: Request, res: Response) => {
  const { campaignId } = req.params;
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
  if (!accessToken) {
    return res.status(503).json({ error: 'Facebook is not configured' });
  }
  try {
    const doc = await db.collection('campaigns').doc(campaignId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const data = doc.data() as any;
    const facebookAdId = data?.facebook_ad_id;
    if (!facebookAdId || typeof facebookAdId !== 'string') {
      return res.status(404).json({ error: 'Campaign has not been published to Facebook' });
    }

    const { summary, rows } = await fetchFacebookAdInsights(facebookAdId, accessToken);

    // Persist latest metrics so GET /data/campaigns/:id and impact reports use real numbers.
    try {
      await db.collection('campaigns').doc(campaignId).update(insightsToCampaignPatch(summary));
    } catch (persistErr) {
      console.error('Failed to persist Facebook insights to campaign:', persistErr);
    }

    return res.json({
      campaignId,
      facebookAdId,
      insights: {
        impressions: summary.impressions,
        reach: summary.reach,
        frequency: summary.frequency,
        inline_link_clicks: summary.inlineLinkClicks,
        clicks: summary.clicks,
        spend: summary.spend,
        cpc: summary.cpc,
        cpm: summary.cpm,
        ctr: summary.ctr,
        cost_per_inline_link_click: summary.costPerInlineLinkClick,
        objective: summary.objective,
        results: summary.objectiveResults,
        result_rate: summary.objectiveResultRate,
        video_p75_watched_actions: summary.videoP75Watched,
        total_actions: summary.totalActions,
        actions: summary.actions,
      },
      rows,
    });
  } catch (error: any) {
    const message = error?.message || 'Failed to fetch Facebook insights';
    console.error('Facebook insights error:', message, error);
    return res.status(500).json({ error: message });
  }
});

/** Sync Meta ad insights for one published campaign (includes audience breakdowns). */
app.post('/facebook/campaign/:campaignId/sync-insights', async (req: Request, res: Response) => {
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
  if (!accessToken) {
    return res.status(503).json({ error: 'Facebook is not configured' });
  }
  try {
    const { campaignId } = req.params;
    const includeBreakdowns = req.body?.includeBreakdowns !== false;
    const result = await syncCampaignFacebookInsights(db, campaignId, { includeBreakdowns });
    return res.json({
      campaignId: result.campaignId,
      facebookAdId: result.facebookAdId,
      insights: insightsToCampaignPatch(result.summary),
      breakdowns: Object.fromEntries(
        Object.entries(result.breakdowns).map(([key, rows]) => [key, rows?.length ?? 0])
      ),
    });
  } catch (error: any) {
    const message = error?.message || 'Failed to sync Facebook insights';
    console.error('Facebook sync-insights error:', message, error);
    const status = message.includes('not found') ? 404 : 500;
    return res.status(status).json({ error: message });
  }
});

/** Bulk sync Meta insights for all campaigns with facebook_ad_id (Cloud Scheduler / admin). */
app.post('/facebook/sync-insights', async (req: Request, res: Response) => {
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
  if (!accessToken) {
    return res.status(503).json({ error: 'Facebook is not configured' });
  }
  try {
    const limit = Number(req.body?.limit ?? req.query.limit);
    const includeBreakdowns = req.body?.includeBreakdowns === true || req.query.includeBreakdowns === 'true';
    const result = await syncAllPublishedCampaignFacebookInsights(db, { limit, includeBreakdowns });
    return res.json({
      synced: result.synced.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
      campaigns: result.synced.map((item) => ({
        campaignId: item.campaignId,
        reach: item.summary.reach,
        impressions: item.summary.impressions,
        inlineLinkClicks: item.summary.inlineLinkClicks,
      })),
      skippedDetails: result.skipped,
      errorDetails: result.errors,
    });
  } catch (error: any) {
    const message = error?.message || 'Failed to sync Facebook insights';
    console.error('Facebook bulk sync-insights error:', message, error);
    return res.status(500).json({ error: message });
  }
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received — flushing Langfuse and closing server`);
  try {
    await forceFlushLangfuse();
  } catch (err) {
    console.warn('[Langfuse] flush on shutdown failed:', err);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

