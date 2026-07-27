import type { Firestore } from 'firebase-admin/firestore';
import type { VertexAI } from '@google-cloud/vertexai';
import {
  computeComposite,
  type CommsIntegrityLayer,
  type FactCheckLayer,
  type ScoreSnapshot,
  type SharedRealityLayer,
  upsertTrustReport,
} from './trustReport';

export const UUTS_PRESCREEN_PROMPT_FIELD = 'uuts_prescreen';

const DEFAULT_PROMPT_DOC_ID = 'ucZnWEWd4t1f32H9f9Tj';
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const MAX_ATTEMPTS = MAX_RETRIES + 1;

/** Opt-in kill switch. Off unless UUTS_PRESCREEN_ENABLED=true (deploy without connecting). */
export function isUutsPrescreenEnabled(): boolean {
  const raw = (process.env.UUTS_PRESCREEN_ENABLED || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

type JsonObject = Record<string, unknown>;

const COMMS_DIMS = [
  { code: 'E', name: 'Evidence Quality', def: 'Strength, reliability, and diversity of sourcing.' },
  { code: 'F', name: 'Framing', def: 'Balance of presentation versus one-sided steering.' },
  { code: 'P', name: 'Perspective', def: 'Quality of engagement with serious opposing views.' },
  { code: 'T', name: 'Tone', def: 'Measured delivery versus inflammatory or manipulative language.' },
  { code: 'L', name: 'Language', def: 'Precision of wording versus loaded or tribal language.' },
  { code: 'C', name: 'Context', def: 'Completeness of essential background and caveats.' },
  { code: 'A', name: 'Audience Respect', def: 'Whether the audience is empowered rather than condescended to.' },
  { code: 'D', name: 'Disclosure', def: 'Transparency about authorship, funding, agenda, and limitations.' },
] as const;

const SHARED_REALITY_SUBS = [
  { name: 'Accessibility', weight: 0.3, max: 100, def: 'Reaches skeptical audiences without identity threat.' },
  { name: 'Bridge Potential', weight: 0.35, max: 100, def: 'Creates room for constructive conversation across disagreement.' },
  { name: 'Epistemic Humility', weight: 0.2, max: 100, def: 'Discloses uncertainty and distinguishes confidence levels.' },
  { name: 'Values Bridge', weight: 0.15, max: 100, def: 'Connects across moral foundations and shared goals.' },
] as const;

const FALLBACK_PROMPT = `You are the UUTS Pre-screening skill for Unravel.

Score the campaign in ONE pass across three layers. Be strict, evidence-based, and consistent.
Do NOT invent sources. If a claim has no citation, treat it as unverifiable/weak.
Return ONLY valid JSON (no markdown, no commentary).

================================================================
LAYER 1 — FACT-CHECK / ACCURACY (45% of composite)
================================================================
Goal: Are the factual claims true, sourced, and honestly framed?

Score each claim 0–100 using evidence tiers:
- Tier 1 (base ~100): meta-analysis / systematic review / gold-standard consensus
- Tier 2 (base ~90): 3+ independent reputable fact-checkers/sources agree
- Tier 3 (base ~80): authoritative source + corroboration
- Tier 4 (base ~70): credentialed expert opinion with caveats
- Tier 5 (base ~60): emerging/single study, clearly labeled preliminary
- Unverifiable (0–40): anecdotes, "studies show" with no link, social media-only

Penalties (apply when present):
- Missing citation for a factual claim: -5 to -15
- Misleading stats (no denominator/baseline, cherry-picked window): -10 to -20
- Correlation presented as causation: -10 to -15
- Overconfident predictions stated as proven fact: -10 to -15

Subscores (0–100):
- claimAccuracy: average strength of claim verdicts
- sourceQuality: quality/diversity of cited sources
- contextIntegrity: necessary caveats/baselines included
- uncertaintyDisclosure: uncertainty labeled where needed

factCheck.score = overall Accuracy 0–100 after penalties.
Extract atomic claims (3–12 max). For each: id, text, source, tier, verdict
(Supported | Partially supported | Unsupported | Unverifiable | Needs context).

================================================================
LAYER 2 — COMMUNICATION INTEGRITY (30% of composite)
================================================================
Score each dimension 1–5 (5 = best). Then convert to 0–100.

E Evidence Quality — source strength AND ideological diversity of sourcing
F Framing — presenting vs steering (no anchor-and-dismiss, cherry-picking, unfair comparisons)
P Perspective — strongest opposing view engaged fairly (steelman), not both-sidesing everything
T Tone — measured vs inflammatory; emotion serves clarity, not manipulation
L Language — precise vs loaded/tribal words; low affect-word density
C Context — essential background included; "what would change your mind?" test
A Audience Respect — empowering adults vs condescension/shaming
D Disclosure — who created this, why, funding/agenda, acknowledged limits

Category modifiers (apply to raw CI score when category is clear):
- Medical/Health: 0.85
- Political/Civic: 0.90
- Feel-good/Cultural: 1.10
- Other/unknown: 1.00

commsIntegrity.raw = average of 8 dims mapped to 0–100
  (dimScore 1→20, 2→40, 3→60, 4→80, 5→100; average those)
commsIntegrity.score = clamp(raw * categoryModifier - framePenalty, 0, 100)
Include short framing rationale.

================================================================
LAYER 3 — SHARED REALITY / BRIDGE-BUILDING (25% of composite)
================================================================
Score each sub 0–100:

1) Accessibility (weight 0.30)
   Reaches skeptical audiences without identity threat; validates questioning;
   avoids "trust the science" tribal slogans; uses concrete independent evidence.

2) Bridge Potential (weight 0.35)
   Invites curiosity; acknowledges trade-offs; ends in a way that allows
   constructive disagreement rather than demanding agreement.

3) Epistemic Humility (weight 0.20)
   Distinguishes what we know vs what we're learning; discloses limitations;
   uses probabilistic language for predictions.

4) Values Bridge (weight 0.15)
   Appeals across multiple moral foundations (care, fairness, loyalty, liberty, etc.)
   and names shared goals across disagreement.

sharedReality.score = weighted sum of the four subs (0–100).
For each sub, include 1–4 elements with {label, got, max}.

================================================================
COMPOSITE
================================================================
composite = round(
  factCheck.score * 0.45 +
  commsIntegrity.score * 0.30 +
  sharedReality.score * 0.25
)

Be calibrated:
- 90–100 Gold Standard
- 80–89 High Trust
- 70–79 Moderate Trust
- 60–69 Low Trust
- <60 Returned / needs major revision

If content is too thin to score fairly, still return the JSON with low scores,
explicit Unverifiable claims, and clear penalties — do not invent evidence.

REQUIRED JSON SHAPE:
{
  "factCheck": {
    "score": 0,
    "subscores": {
      "claimAccuracy": 0,
      "sourceQuality": 0,
      "contextIntegrity": 0,
      "uncertaintyDisclosure": 0
    },
    "claims": [
      { "id": "C1", "text": "", "source": null, "tier": "", "verdict": "" }
    ],
    "penalties": [
      { "type": "", "points": 0 }
    ]
  },
  "commsIntegrity": {
    "score": 0,
    "raw": 0,
    "dims": [
      { "code": "E", "name": "Evidence Quality", "score": 1, "def": "" },
      { "code": "F", "name": "Framing", "score": 1, "def": "" },
      { "code": "P", "name": "Perspective", "score": 1, "def": "" },
      { "code": "T", "name": "Tone", "score": 1, "def": "" },
      { "code": "L", "name": "Language", "score": 1, "def": "" },
      { "code": "C", "name": "Context", "score": 1, "def": "" },
      { "code": "A", "name": "Audience Respect", "score": 1, "def": "" },
      { "code": "D", "name": "Disclosure", "score": 1, "def": "" }
    ],
    "categoryModifier": 1,
    "crossDimModifier": 1,
    "framePenalty": 0,
    "framing": ""
  },
  "sharedReality": {
    "score": 0,
    "subs": [
      { "name": "Accessibility", "weight": 0.3, "score": 0, "max": 100, "def": "", "elements": [] },
      { "name": "Bridge Potential", "weight": 0.35, "score": 0, "max": 100, "def": "", "elements": [] },
      { "name": "Epistemic Humility", "weight": 0.2, "score": 0, "max": 100, "def": "", "elements": [] },
      { "name": "Values Bridge", "weight": 0.15, "score": 0, "max": 100, "def": "", "elements": [] }
    ]
  },
  "composite": 0
}

Campaign content will be provided after this rubric.`;

export interface RunUutsPrescreenParams {
  db: Firestore;
  vertexAI: VertexAI;
  campaignId: string;
  campaign: JsonObject;
  promptDocId?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  return String(value).trim();
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: unknown, min: number, max: number): number | null {
  const n = numberOrNull(value);
  if (n == null) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function pickObject(source: JsonObject, keys: string[]): JsonObject {
  for (const key of keys) {
    const candidate = source[key];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as JsonObject;
    }
  }
  return {};
}

function firstPresent(source: JsonObject, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

function sourceList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        const row = asObject(item);
        return [row.name, row.detail, row.url].map((part) => text(part)).filter(Boolean).join(' - ');
      })
      .filter(Boolean)
      .slice(0, 50);
  }
  if (typeof raw === 'string') {
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 50);
  }
  return [];
}

function slideshowDescriptions(raw: unknown): string[] {
  return asArray(raw)
    .map((slide) => text(asObject(slide).description))
    .filter(Boolean)
    .slice(0, 30);
}

function buildCampaignContent(campaign: JsonObject): string {
  const parts = [
    `Title: ${text(campaign.title, 'N/A')}`,
    `Category: ${text(campaign.category, 'N/A')}`,
    `Short description: ${text(campaign.short_description ?? campaign.tagline, 'N/A')}`,
    `Long description: ${text(campaign.long_description ?? campaign.description, 'N/A')}`,
  ];

  const creator = text(campaign.creator_name ?? campaign.creator ?? campaign.creator_username);
  if (creator) parts.push(`Creator disclosure: ${creator}`);

  const sources = sourceList(campaign.campaign_sources ?? campaign.sources);
  if (sources.length) {
    parts.push(`Sources:\n${sources.map((source, i) => `${i + 1}. ${source}`).join('\n')}`);
  }

  const slides = slideshowDescriptions(campaign.hero_slideshow);
  if (slides.length) {
    parts.push(`Slideshow descriptions:\n${slides.map((slide, i) => `${i + 1}. ${slide}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

function buildPrompt(promptTemplate: string, campaign: JsonObject): string {
  const campaignContent = buildCampaignContent(campaign);
  const template = promptTemplate.trim() || FALLBACK_PROMPT;
  if (template.includes('{{campaign_content}}')) {
    return template.split('{{campaign_content}}').join(campaignContent);
  }
  if (template.includes('{campaign_content}')) {
    return template.split('{campaign_content}').join(campaignContent);
  }
  return `${template}\n\nCampaign to evaluate:\n---\n${campaignContent}\n---`;
}

async function loadPrompt(db: Firestore, promptDocId: string): Promise<string> {
  try {
    const snap = await db.collection('ai_prompts').doc(promptDocId).get();
    const prompt = snap.exists ? snap.data()?.[UUTS_PRESCREEN_PROMPT_FIELD] : null;
    if (typeof prompt === 'string' && prompt.trim()) return prompt;
    console.warn(`UUTS pre-screen prompt missing at ai_prompts/${promptDocId}.${UUTS_PRESCREEN_PROMPT_FIELD}; using fallback prompt`);
  } catch (error) {
    console.warn('UUTS pre-screen prompt load failed; using fallback prompt:', error);
  }
  return FALLBACK_PROMPT;
}

function extractJson(textValue: string): JsonObject {
  const trimmed = textValue.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('UUTS pre-screen response did not contain a JSON object');
  }
  return JSON.parse(candidate.slice(start, end + 1)) as JsonObject;
}

function mapFactCheck(raw: JsonObject): FactCheckLayer {
  const score = clamp(firstPresent(raw, ['score', 'overallScore']), 0, 100);
  if (score == null) throw new Error('UUTS fact-check score is missing');

  const subs = asObject(raw.subscores);
  const claims = asArray(firstPresent(raw, ['claims', 'atomicClaims'])).map((claim, index) => {
    const row = asObject(claim);
    return {
      id: text(row.id, `C${index + 1}`),
      text: text(firstPresent(row, ['text', 'claim'])),
      source: row.source == null ? null : text(row.source),
      tier: text(row.tier, 'Unverifiable'),
      verdict: text(row.verdict, 'Needs review'),
    };
  });

  const penalties = asArray(raw.penalties).map((penalty) => {
    const row = asObject(penalty);
    return {
      type: text(row.type, 'unspecified'),
      points: Math.max(0, Number(row.points) || 0),
    };
  });

  return {
    status: 'scored',
    score,
    subscores: {
      claimAccuracy: clamp(subs.claimAccuracy, 0, 100) ?? 0,
      sourceQuality: clamp(subs.sourceQuality, 0, 100) ?? 0,
      contextIntegrity: clamp(subs.contextIntegrity, 0, 100) ?? 0,
      uncertaintyDisclosure: clamp(subs.uncertaintyDisclosure, 0, 100) ?? 0,
    },
    claims,
    penalties,
  };
}

function findDim(rawDims: unknown[], code: string): JsonObject {
  for (const dim of rawDims) {
    const row = asObject(dim);
    if (text(row.code).toUpperCase() === code) return row;
  }
  return {};
}

function mapCommsIntegrity(raw: JsonObject): CommsIntegrityLayer {
  const score = clamp(firstPresent(raw, ['score', 'overallScore']), 0, 100);
  if (score == null) throw new Error('UUTS communication integrity score is missing');

  const dimsRaw = asArray(raw.dims ?? raw.dimensions);
  const dims = COMMS_DIMS.map((canonical) => {
    const row = findDim(dimsRaw, canonical.code);
    const dimScore = clamp(row.score, 1, 5);
    if (dimScore == null) {
      throw new Error(`UUTS communication integrity dimension ${canonical.code} score is missing`);
    }
    return {
      code: canonical.code,
      name: text(row.name, canonical.name),
      score: dimScore,
      def: text(row.def ?? row.definition, canonical.def),
    };
  });

  return {
    status: 'scored',
    score,
    raw: numberOrNull(raw.raw) ?? score,
    dims,
    categoryModifier: numberOrNull(raw.categoryModifier) ?? 1,
    crossDimModifier: numberOrNull(raw.crossDimModifier) ?? 1,
    framePenalty: numberOrNull(raw.framePenalty) ?? 0,
    framing: raw.framing == null ? null : text(raw.framing),
  };
}

function findSharedSub(rawSubs: unknown[], name: string): JsonObject {
  const target = name.toLowerCase();
  for (const sub of rawSubs) {
    const row = asObject(sub);
    if (text(row.name).toLowerCase() === target) return row;
  }
  return {};
}

function mapSharedReality(raw: JsonObject): SharedRealityLayer {
  const score = clamp(firstPresent(raw, ['score', 'overallScore']), 0, 100);
  if (score == null) throw new Error('UUTS shared reality score is missing');

  const rawSubs = asArray(raw.subs ?? raw.elements ?? raw.questions);
  const subs = SHARED_REALITY_SUBS.map((canonical) => {
    const row = findSharedSub(rawSubs, canonical.name);
    const subScore = clamp(row.score, 0, 100);
    if (subScore == null) {
      throw new Error(`UUTS shared reality subscore ${canonical.name} is missing`);
    }
    return {
      name: canonical.name,
      weight: numberOrNull(row.weight) ?? canonical.weight,
      score: subScore,
      max: numberOrNull(row.max) ?? canonical.max,
      def: text(row.def ?? row.definition, canonical.def),
      elements: asArray(row.elements).map((element) => {
        const el = asObject(element);
        return {
          label: text(el.label, 'criterion'),
          got: Math.max(0, Number(el.got) || 0),
          max: Math.max(0, Number(el.max) || 0),
        };
      }),
    };
  });

  return {
    status: 'scored',
    score,
    subs,
  };
}

export function mapUutsPrescreenOutput(raw: unknown): ScoreSnapshot {
  const root = asObject(raw);
  const factCheck = mapFactCheck(pickObject(root, ['factCheck', 'fact_check', 'accuracy']));
  const commsIntegrity = mapCommsIntegrity(
    pickObject(root, ['commsIntegrity', 'communicationsIntegrity', 'communicationIntegrity', 'fairness'])
  );
  const sharedReality = mapSharedReality(
    pickObject(root, ['sharedReality', 'shared_reality', 'bridgeBuilding', 'bridge_building'])
  );
  const computed = computeComposite(factCheck.score, commsIntegrity.score, sharedReality.score);
  const composite = clamp(root.composite, 0, 100) ?? computed;
  if (composite == null) throw new Error('UUTS composite score could not be computed');

  return {
    composite,
    factCheck,
    commsIntegrity,
    sharedReality,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`UUTS pre-screen timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function generatePrescreen(
  vertexAI: VertexAI,
  prompt: string
): Promise<ScoreSnapshot> {
  const model = vertexAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL_UUTS_PRESCREEN || DEFAULT_MODEL,
  });
  const result = await withTimeout(
    model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    }),
    TIMEOUT_MS
  );
  const responseText =
    result.response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  if (!responseText) {
    throw new Error('UUTS pre-screen returned an empty response');
  }
  return mapUutsPrescreenOutput(extractJson(responseText));
}

export async function runUutsPrescreenAndPersist({
  db,
  vertexAI,
  campaignId,
  campaign,
  promptDocId = DEFAULT_PROMPT_DOC_ID,
}: RunUutsPrescreenParams): Promise<void> {
  const campaignRef = db.collection('campaigns').doc(campaignId);
  const promptTemplate = await loadPrompt(db, promptDocId);
  const prompt = buildPrompt(promptTemplate, campaign);
  let attempts = 0;

  await campaignRef.update({
    uuts_prescreen_status: 'in_progress',
    uuts_prescreen_attempts: attempts,
    uuts_prescreen_error: null,
    uuts_prescreen_started_at: nowIso(),
    uuts_prescreen_updated_at: nowIso(),
  });

  try {
    let snapshot: ScoreSnapshot | null = null;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      await campaignRef.update({
        uuts_prescreen_attempts: attempts,
        uuts_prescreen_updated_at: nowIso(),
      });
      try {
        snapshot = await generatePrescreen(vertexAI, prompt);
        break;
      } catch (error) {
        lastError = error;
        console.warn(`UUTS pre-screen attempt ${attempt}/${MAX_ATTEMPTS} failed for ${campaignId}:`, error);
        if (attempt < MAX_ATTEMPTS) {
          await delay(500 * attempt);
        }
      }
    }

    if (!snapshot) {
      throw lastError || new Error('UUTS pre-screen failed');
    }

    const result = await upsertTrustReport(db, campaignId, {
      initial: snapshot,
      final: null,
      review: {
        aiReviewed: true,
        humanReviewed: false,
        assignedReviewer: null,
        decision: 'pending',
        reviewedAt: nowIso(),
        reviewer: 'UUTS Pre-screening skill',
      },
      createdBy: 'uuts-prescreen',
      refresh: true,
      publish: false,
    });

    await campaignRef.update({
      uuts_prescreen_status: 'complete',
      uuts_prescreen_attempts: attempts,
      uuts_prescreen_error: null,
      uuts_prescreen_composite: snapshot.composite,
      uuts_prescreen_version_id: result.versionId,
      uuts_prescreen_version_number: result.version,
      uuts_prescreen_completed_at: nowIso(),
      uuts_prescreen_updated_at: nowIso(),
      updatedAt: nowIso(),
    });
  } catch (error) {
    await campaignRef.update({
      uuts_prescreen_status: 'manual_required',
      uuts_prescreen_attempts: attempts,
      uuts_prescreen_error: errorMessage(error).slice(0, 1000),
      uuts_prescreen_failed_at: nowIso(),
      uuts_prescreen_updated_at: nowIso(),
      updatedAt: nowIso(),
    });
    throw error;
  }
}
