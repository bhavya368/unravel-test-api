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
const DONATION_CHECKOUT_MIN_CENTS = 500;
const DONATION_CHECKOUT_PRESET_CENTS = 500;

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
    
    const model = vertexAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL_AI_MODERATION || 'gemini-2.5-flash-lite',
    });

    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
    });
    
    const response = result.response;
    const recommendation = response.candidates?.[0]?.content?.parts?.[0]?.text || 
                          'AI moderation analysis unavailable';
    
    return recommendation.trim();
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
  longDescription: string
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

    const model = vertexAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL_BIAS_WHEEL || 'gemini-2.5-flash-lite',
    });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('Bias wheel: no JSON in AI response, text:', text?.substring(0, 200));
      return DEFAULT_BIAS_WHEEL;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch (parseErr) {
      console.warn('Bias wheel: JSON parse failed:', parseErr, 'raw:', jsonMatch[0]);
      return DEFAULT_BIAS_WHEEL;
    }
    const evidence = Math.min(5, Math.max(1, Number(parsed.evidence) || 1));
    const facts = Math.min(5, Math.max(1, Number(parsed.facts) || 1));
    const perspective = Math.min(5, Math.max(1, Number(parsed.perspective) || 1));
    const tone = Math.min(5, Math.max(1, Number(parsed.tone) || 1));
    const direction = typeof parsed.direction === 'string' && VALID_DIRECTIONS.includes(parsed.direction.toLowerCase())
      ? parsed.direction.toLowerCase()
      : 'none';

    return { evidence, facts, perspective, tone, direction };
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
    console.log('Bias wheel input:', { titleLen: title.length, shortLen: shortDescription.length, longLen: longDescription.length });
    const biasWheel = await analyzeBiasWheel(title, shortDescription, longDescription);
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

// ============ USERS (default Firestore DB) ============

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
    const now = new Date().toISOString();
    const payload: Record<string, unknown> = {
      firstName: fn,
      lastName: ln,
      email: normEmail,
      updatedAt: now,
    };

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
      await ref.set({
        ...payload,
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

    res.json({ ok: true, uid, ...payload });
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

    const documents = snapshot.docs.map(doc => {
      const data = { id: doc.id, ...doc.data() } as Record<string, unknown>;
      return enrichCampaignResponse(data);
    });

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

// ============ FIRESTORE ROUTES (unravel DB) ============

// GET approved campaigns only (sorted by newest first)
app.get('/campaigns/approved', async (req: Request, res: Response) => {
  try {
    const snapshot = await db.collection('campaigns')
      .where('status', '==', 'Approved')
      .get();

    const documents = snapshot.docs.map(doc => {
      const data = { id: doc.id, ...doc.data() } as Record<string, unknown>;
      return enrichCampaignResponse(data);
    });

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
    
    const documents = snapshot.docs.map(doc => {
      const data = { id: doc.id, ...doc.data() } as Record<string, unknown>;
      return collection === 'campaigns' ? enrichCampaignResponse(data) : data;
    });
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
      out.facebook_impressions = data.facebook_impressions ?? 0;
      out.facebook_clicks = data.facebook_clicks ?? 0;
    }

    const response =
      collection === 'campaigns' ? enrichCampaignResponse(out) : out;

    res.json(response);
  } catch (error) {
    console.error('Error fetching document:', error);
    res.status(500).json({ error: 'Failed to fetch document' });
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

    return res.redirect(302, canonicalUrl);
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

    return res.redirect(302, canonicalUrl);
  } catch (error) {
    console.error('OG lander error:', error);
    res.status(500).send('Error loading lander');
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

      if (data.slideshow_back_button_url !== undefined) {
        data.slideshow_back_button_url = sanitizeSlideshowBackButtonUrl(data.slideshow_back_button_url);
      }

      // Creator-listed sources (optional); ignore bad shapes for legacy clients
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

      // Ad preview overrides (optional). Trimmed + length-capped; empty values dropped.
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

      // Creator UID from verified Firebase token only (not client-supplied)
      delete data.created_by;
      delete data.created_by_uid;
      delete data.creator;
      delete data.creator_name;
      delete data.creator_first_name;
      delete data.creator_last_name;
      delete data.creator_email;
      if (req.firebaseUid) {
        data.created_by = req.firebaseUid;
        data.created_by_uid = req.firebaseUid;

        // Snapshot creator profile for display on campaign cards/detail pages.
        // Ownership remains tied to `created_by` UID.
        try {
          const userDoc = await usersDb.collection('users').doc(req.firebaseUid).get();
          const userData = userDoc.exists ? (userDoc.data() as Record<string, unknown>) : null;
          const firstName = String(userData?.firstName ?? '').trim();
          const lastName = String(userData?.lastName ?? '').trim();
          const fullName = `${firstName} ${lastName}`.trim();
          const email = String(userData?.email ?? req.firebaseEmail ?? '').trim().toLowerCase();
          if (firstName) data.creator_first_name = firstName;
          if (lastName) data.creator_last_name = lastName;
          if (fullName) {
            data.creator = fullName;
            data.creator_name = fullName;
          }
          if (email) data.creator_email = email;
        } catch (creatorProfileErr) {
          console.error('Failed to attach creator profile snapshot:', creatorProfileErr);
        }
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
      if (data.slideshow_back_button_url !== undefined) {
        data.slideshow_back_button_url = sanitizeSlideshowBackButtonUrl(data.slideshow_back_button_url);
      }
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

      if (data.slideshow_back_button_url !== undefined) {
        data.slideshow_back_button_url = sanitizeSlideshowBackButtonUrl(data.slideshow_back_button_url);
      }

      const durationResult = applyCampaignDurationPatch(data, prev);
      if (!durationResult.ok) {
        return res.status(400).json({ error: durationResult.error });
      }
      data = durationResult.patch;
      durationDeleteFields = durationResult.deleteFields;

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
  try {
    const imagenModel = vertexAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL_IMAGE_GENERATION || 'gemini-2.0-flash-exp',
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      } as any,
    });

    const result = await imagenModel.generateContent({
      contents: [{
        role: 'user',
        parts: [{ text: `Generate an image of: ${description}. Only respond with the image.` }]
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
      return null;
    }

    const bucketName = process.env.GCS_BUCKET || 'unravel-generated-images';
    const bucket = storage.bucket(bucketName);
    const fileName = `generated-${Date.now()}-${Math.random().toString(36).substring(7)}.png`;
    const file = bucket.file(fileName);
    await file.save(Buffer.from(imageData, 'base64'), {
      metadata: { contentType: mimeType },
    });

    return {
      imageBase64: `data:${mimeType};base64,${imageData}`,
      imageUrl: '',
      storagePath: `gs://${bucketName}/${fileName}`,
      fileName,
    };
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
      const donorEmail =
        typeof req.firebaseEmail === 'string' && req.firebaseEmail.trim()
          ? req.firebaseEmail.trim().toLowerCase()
          : undefined;
      const checkoutMetadata: Record<string, string> = {
        campaignId: cidTrim,
        stripe_product_id: stripeProductId,
      };
      if (donorUid) {
        checkoutMetadata.donorUid = donorUid;
      }

      /** Optional: lock Checkout to an exact donation (e.g. lander preset). Omit for pay-what-you-want on Stripe’s page. */
      const fixedRaw = body.fixedAmountCents;
      const fixedParsed =
        typeof fixedRaw === 'number' && Number.isFinite(fixedRaw) ? Math.round(fixedRaw) : NaN;
      const useFixedAmount =
        Number.isFinite(fixedParsed) &&
        fixedParsed >= DONATION_CHECKOUT_MIN_CENTS &&
        fixedParsed <= 100_000_000; // $1M cap (cents)

      const cancelRel =
        typeof body.checkoutCancelPath === 'string' &&
        body.checkoutCancelPath.startsWith('/') &&
        body.checkoutCancelPath.length <= 512
          ? body.checkoutCancelPath.trim()
          : `/campaign/${encodeURIComponent(cidTrim)}/back`;

      const sessionCommon = {
        mode: 'payment' as const,
        client_reference_id: cidTrim,
        success_url: `${base}/campaign/${encodeURIComponent(cidTrim)}?donation=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}${cancelRel}`,
        submit_type: 'pay' as const,
        ...(donorEmail ? { customer_email: donorEmail } : {}),
        custom_text: {
          submit: {
            message: 'Fund this campaign — complete your secure payment below.',
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
        allow_promotion_codes: true,
      };

      if (useFixedAmount) {
        const session = await stripe.checkout.sessions.create({
          ...sessionCommon,
          line_items: [
            {
              price_data: {
                currency: cur,
                unit_amount: fixedParsed,
                product: stripeProductId,
              },
              quantity: 1,
            },
          ],
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
      return res.status(400).json({ error: 'This checkout session is not paid yet.' });
    }
    const campaignId = session.metadata?.campaignId;
    if (!campaignId || typeof campaignId !== 'string') {
      return res.status(400).json({ error: 'Invalid session: missing campaign' });
    }
    // Use the actual amount charged (post-coupon). Stripe already confirmed the
    // session is paid, so a discounted total below the usual minimum is valid.
    const amountCents = session.amount_total;
    if (amountCents == null || amountCents < 0) {
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
    const recordedAt = new Date().toISOString();

    const recordRef = db.collection('stripe_checkout_records').doc(sid);
    const campaignRef = db.collection('campaigns').doc(campaignId.trim());

    let campaignTitle = 'Campaign';
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
      const currentFunding = Number(data.funding_current ?? 0) || 0;
      const newFunding = currentFunding + amountCents / 100;
      t.set(recordRef, {
        campaignId: campaignId.trim(),
        amount_cents: amountCents,
        recordedAt,
        invoice_pdf: invoicePdf,
        hosted_invoice_url: hostedInvoiceUrl,
        invoice_number: invoiceNumber,
        ...(donorUid ? { donor_uid: donorUid } : {}),
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
        amount_cents: amountCents,
        currency: (session.currency || 'usd').toLowerCase(),
        recordedAt,
        invoice_pdf: invoicePdf,
        hosted_invoice_url: hostedInvoiceUrl,
        invoice_number: invoiceNumber,
      });
    }

    const final = await campaignRef.get();
    const funding_current = Number((final.data() || {}).funding_current ?? 0) || 0;
    res.json({
      ok: true,
      funding_current,
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

    const bizSdk = require('facebook-nodejs-business-sdk');
    bizSdk.FacebookAdsApi.init(accessToken);
    const Ad = bizSdk.Ad;
    const ad = new Ad(facebookAdId);

    const fields = ['impressions', 'reach', 'clicks', 'spend', 'cpc', 'cpm', 'ctr'];
    const params: Record<string, unknown> = { date_preset: 'maximum' };
    const insights = await ad.getInsights(fields, params);

    const rows = Array.isArray(insights) ? insights : (insights ? [insights] : []);
    const dataRows = rows.map((r: any) => r._data || r);
    const summary = dataRows.length > 0 ? dataRows[0] : {};

    // Persist latest impressions/clicks so GET /data/campaigns/:id returns real
    // numbers without a second Facebook call. Fire-and-forget — never block or
    // fail the insights response if the write fails.
    try {
      await db.collection('campaigns').doc(campaignId).update({
        facebook_impressions: Number(summary.impressions ?? 0),
        facebook_clicks: Number(summary.clicks ?? 0),
        facebook_insights_updated_at: new Date().toISOString(),
      });
    } catch (persistErr) {
      console.error('Failed to persist Facebook insights to campaign:', persistErr);
    }

    return res.json({ campaignId, facebookAdId, insights: summary, rows: dataRows });
  } catch (error: any) {
    const message = error?.message || 'Failed to fetch Facebook insights';
    console.error('Facebook insights error:', message, error);
    return res.status(500).json({ error: message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

