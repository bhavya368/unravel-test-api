import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { VertexAI } from '@google-cloud/vertexai';
import Anthropic from '@anthropic-ai/sdk';
import {
  applyConfidenceModifiers,
  computeComposite,
  type CommsIntegrityLayer,
  type FactCheckLayer,
  type ScoreSnapshot,
  type SharedRealityLayer,
  upsertTrustReport,
} from './trustReport';

import {
  extractVertexUsage,
  getActiveLangfuseTraceId,
  metaStr,
  traceGeminiCall,
} from './langfuseInstrumentation';
import {
  evaluateUutsSchemaHealth,
  loadUutsPromptTemplate,
  scoreActiveUutsFailure,
  scoreActiveUutsRun,
  type UutsPromptSource,
} from './uutsLangfuseEval';

export const UUTS_PRESCREEN_PROMPT_FIELD = 'uuts_prescreen';

const DEFAULT_PROMPT_DOC_ID = 'ucZnWEWd4t1f32H9f9Tj';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-6';
// A reasoning model scoring the full three-layer rubric routinely runs past a minute.
// Worst case across all attempts is roughly TIMEOUT_MS * MAX_ATTEMPTS plus backoff; the
// admin preview's poll window must stay above that or it reports a false timeout.
const TIMEOUT_MS = 120_000;
/** External research (web search / grounding) needs headroom beyond the base score call. */
const RESEARCH_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 2;
const MAX_ATTEMPTS = MAX_RETRIES + 1;
const ANTHROPIC_MAX_TOKENS = 8192;
const ANTHROPIC_RESEARCH_MAX_TOKENS = 16384;

/** Fair external research: fetch Sources-box URLs only (no open-web roaming). */
const MAX_SOURCE_FETCHES = 15;
/** Slow agency/journal pages often exceed 8s under parallel load. */
const SOURCE_FETCH_TIMEOUT_MS = 20_000;
const SOURCE_FETCH_CONCURRENCY = 3;
const MAX_CHARS_PER_SOURCE = 12_000;
const MAX_EVIDENCE_CHARS_TOTAL = 60_000;
/** Cap download size so huge HTML pages don't blow the timeout budget. */
const MAX_SOURCE_DOWNLOAD_BYTES = 1_500_000;

const SOURCE_FETCH_HEADERS_BROWSER: Record<string, string> = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,text/plain;q=0.8,*/*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
  // Browser-like UA: some agencies block custom bot UAs.
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

const SOURCE_FETCH_HEADERS_BOT: Record<string, string> = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,text/plain;q=0.8,*/*;q=0.5',
  'Accept-Language': 'en-US,en;q=0.9',
  // Honest bot UA: some publishers (e.g. BMC) serve full HTML to bots but cookie-walls to browsers.
  'User-Agent': 'UnravelUUTSPrescreen/1.0 (+https://unravel.network; source-verification)',
};

/** Retry with the other UA when the first response is blocked or nearly empty. */
const SHORT_SOURCE_TEXT_CHARS = 400;

const EXTERNAL_RESEARCH_ADDENDUM = `
================================================================
EXTERNAL RESEARCH MODE — SOURCES BOX ONLY (fair)
================================================================
We fetched pages linked in the campaign Sources box and included their text below
(or noted fetch failures). That evidence pack is the ONLY allowed source set for Fact-Check.

Hard rules for sources:
- The Sources box (numbered list + fetched pack below) is the exclusive evidence list.
- Do NOT web-search, invent, or add sources mentioned only in the campaign description,
  slideshow, or body text unless that same source also appears in the Sources box.
- Do NOT treat inline URLs/citations in the description as Sources-box entries.
- Do NOT use open-web knowledge to "fill in" missing Sources-box evidence.

Fair scoring stance — evidence-based, not harsh:
- Still analyze the full campaign description, slideshow, and framing for all three layers.
- For Fact-Check support, rely only on Sources-box entries and the fetched pack.
- Give credit when a claim is substantially true and reasonably supported by a Sources-box item,
  even if wording is imperfect.
- Prefer Partially supported over Unsupported when the core fact holds but details need nuance.
- Prefer Unverifiable over false/Unsupported when evidence is missing or inconclusive —
  a missing Sources-box citation or failed fetch is NOT the same as "false".
- Apply penalties only for clear, material issues. Do not stack minor deductions.
- Honest advocacy can score well on Comms / Shared Reality; do not punish taking a side.
- Score Comms Integrity and Shared Reality independently of Fact-Check.
- Return ONLY the COMPLETE JSON object matching the schema — no prose, no markdown fences.
`.trim();

const NO_RESEARCH_CLARIFICATION = `
Scoring clarification (no external research on this run):
- Analyze the full campaign description and framing.
- For Fact-Check, only use Sources listed in the Sources box (as listed — pages were not fetched).
- Do NOT treat URLs/citations that appear only in the description as Sources-box entries.
- If a claim has no Sources-box citation, mark it Unverifiable — do not treat a missing citation as "false".
- Give credit when claims are substantially supported by Sources-box entries; prefer Partially supported over Unsupported when the core fact holds.
- Score Comms Integrity and Shared Reality independently of Fact-Check.
`.trim();

export type UutsProvider = 'gemini' | 'anthropic';

export interface UutsModelOption {
  id: string;
  provider: UutsProvider;
  label: string;
}

function envFlagEnabled(name: string): boolean {
  const raw = (process.env[name] || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Opt-in kill switch. Off unless UUTS_PRESCREEN_ENABLED=true (deploy without connecting). */
export function isUutsPrescreenEnabled(): boolean {
  return envFlagEnabled('UUTS_PRESCREEN_ENABLED');
}

/**
 * When false (default), POST .../trust-report/publish is blocked so admin republish
 * cannot affect the live public trust-report pipeline yet.
 */
export function isUutsPublishLiveEnabled(): boolean {
  return envFlagEnabled('UUTS_PUBLISH_LIVE_ENABLED');
}

/** Opt-in scheduled UUTS batch runner. Off unless UUTS_SCHEDULER_ENABLED=true. */
export function isUutsSchedulerEnabled(): boolean {
  return envFlagEnabled('UUTS_SCHEDULER_ENABLED');
}

export function defaultGeminiModel(): string {
  return (process.env.GEMINI_MODEL_UUTS_PRESCREEN || DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
}

export function defaultAnthropicModel(): string {
  return (
    (process.env.ANTHROPIC_MODEL_UUTS_PRESCREEN || DEFAULT_ANTHROPIC_MODEL).trim() ||
    DEFAULT_ANTHROPIC_MODEL
  );
}

/** Models available for Admin model picker / request allowlist. */
export function listUutsModels(): UutsModelOption[] {
  const geminiLiteId = DEFAULT_GEMINI_MODEL;
  const geminiDefaultId = defaultGeminiModel();
  const models: UutsModelOption[] = [
    {
      id: geminiLiteId,
      provider: 'gemini',
      label: 'Gemini 2.5 Flash Lite',
    },
  ];
  // If GEMINI_MODEL_UUTS_PRESCREEN points at a different Gemini id, offer it too.
  if (geminiDefaultId && geminiDefaultId !== geminiLiteId) {
    models.push({
      id: geminiDefaultId,
      provider: 'gemini',
      label: `Gemini (${geminiDefaultId})`,
    });
  }
  models.push({
    id: defaultAnthropicModel(),
    provider: 'anthropic',
    label: 'Claude Opus',
  });
  return models;
}

export function resolveUutsModel(requested?: string | null): UutsModelOption {
  const models = listUutsModels();
  const want = (requested || '').trim();
  if (want) {
    const match = models.find((m) => m.id === want);
    if (!match) {
      throw Object.assign(
        new Error(`Unsupported UUTS model "${want}". Allowed: ${models.map((m) => m.id).join(', ')}`),
        { status: 400 }
      );
    }
    return match;
  }
  return models[0];
}

export function getUutsConfig() {
  return {
    prescreenEnabled: isUutsPrescreenEnabled(),
    publishLiveEnabled: isUutsPublishLiveEnabled(),
    schedulerEnabled: isUutsSchedulerEnabled(),
    models: listUutsModels(),
    defaultModel: defaultGeminiModel(),
    /** Admin can opt into web search / grounding per run for A/B tests. Default off. */
    externalResearchSupported: true,
    externalResearchDefault: false,
  };
}

/** Coerce request/body flags into a boolean (default false). */
export function parseExternalResearchFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const raw = value.trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  }
  return false;
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

/**
 * Layer 3 checklists are fixed by the Shared Reality ops manual. Element labels and point
 * maxes are enforced here so the model cannot invent its own denominators; it only supplies
 * the points awarded per element.
 */
const SHARED_REALITY_SUBS = [
  {
    name: 'Accessibility',
    weight: 0.3,
    def: 'Reaches fact-resistant audiences who distrust institutions, without identity threat.',
    elements: [
      { label: 'Validates skepticism', max: 10 },
      { label: 'Non-institutional sources', max: 8 },
      { label: 'Avoids tribal language', max: 7 },
      { label: 'International evidence', max: 5 },
      { label: 'Personal relevance', max: 5 },
    ],
  },
  {
    name: 'Bridge Potential',
    weight: 0.35,
    def: 'Can people who disagree still think together after reading this?',
    elements: [
      { label: 'Invites curiosity over agreement', max: 12 },
      { label: 'Multiple valid interpretations', max: 10 },
      { label: 'Legitimate competing values', max: 10 },
      { label: '"Reasonable disagreement" framing', max: 8 },
    ],
  },
  {
    name: 'Epistemic Humility',
    weight: 0.2,
    def: 'Signals uncertainty where evidence is incomplete.',
    elements: [
      { label: 'Discloses study limitations', max: 8 },
      { label: 'Probabilistic language', max: 7 },
      { label: '"What we know" vs "what we\'re learning"', max: 6 },
      { label: 'Invites further investigation', max: 4 },
    ],
  },
  {
    name: 'Values Bridge',
    weight: 0.15,
    def: 'Connects across moral foundations rather than one tribal perspective (+3 each).',
    elements: [
      { label: 'Care/Harm', max: 3 },
      { label: 'Fairness/Justice', max: 3 },
      { label: 'Loyalty/Community', max: 3 },
      { label: 'Authority/Tradition', max: 3 },
      { label: 'Liberty/Autonomy', max: 3 },
    ],
  },
] as const;

/**
 * Layer 1 evidence tiers. `base` alone prices tier quality — it is what the admin tier
 * legend displays. evidenceWeight defaults to 1.0 and exists to discount a source that is
 * a partial fit for its specific claim; defaulting it per tier charged every claim below
 * Tier 1 for its tier twice (a Tier 3 claim capped at 68 while the UI advertised 80).
 */
const FACT_CHECK_TIERS = [
  { match: /(^|\D)1(\D|$)|meta-?analysis|systematic review/i, base: 100, weight: 1.0 },
  { match: /(^|\D)2(\D|$)|fact-?checker/i, base: 90, weight: 1.0 },
  { match: /(^|\D)3(\D|$)|authoritative/i, base: 80, weight: 1.0 },
  { match: /(^|\D)4(\D|$)|expert opinion/i, base: 70, weight: 1.0 },
  { match: /(^|\D)5(\D|$)|emerging|preliminary/i, base: 60, weight: 1.0 },
] as const;

/** Unverifiable / contested claims score 0–40 with no tier multiplier. */
const UNVERIFIABLE_TIER = { base: 20, weight: 1.0 } as const;

/** Layer 1 penalty matrix (magnitudes; subtracted from the claim mean). */
const FACT_CHECK_PENALTIES: Array<{ match: RegExp; points: number }> = [
  { match: /critical|factual error|false/i, points: 25 },
  { match: /cherry/i, points: 20 },
  { match: /mislead|statistic/i, points: 15 },
  { match: /omit|contrary/i, points: 10 },
];

const MAX_FACT_CHECK_PENALTY_PER_ITEM = 25;

/**
 * Penalties scale the claim mean instead of subtracting flat points, so a single finding
 * cannot take a fixed quarter of the layer regardless of how well-sourced the claims are.
 * The total is capped so an accumulation of minor findings cannot zero out the layer.
 */
const MAX_FACT_CHECK_PENALTY_TOTAL = 25;

/** Layer 2 category severity modifiers (lower = stricter). */
const COMMS_CATEGORY_MODIFIERS: Array<{ match: RegExp; modifier: number }> = [
  { match: /medical|health/i, modifier: 0.85 },
  { match: /politic|civic|election/i, modifier: 0.9 },
  { match: /financ|econom|invest/i, modifier: 0.9 },
  { match: /feel-?good|cultur|art|sport/i, modifier: 1.1 },
  { match: /environment|climate|conservation/i, modifier: 1.0 },
  { match: /social|advocacy|community|education/i, modifier: 1.0 },
];

const COMMS_MODIFIER_MIN = 0.85;
const COMMS_MODIFIER_MAX = 1.1;
/** Frame penalties are cumulative but capped so framing never outweighs dimensional weakness. */
const MAX_FRAME_PENALTY = 25;
const CROSS_DIM_MODIFIER_FLOOR = 0.75;

/**
 * Confidence Factor for an automated pre-screen with no human validation, and the neutral
 * Uncertainty Visibility value (score disclosure is not decided at pre-screen time).
 */
export const PRESCREEN_CONFIDENCE_FACTOR = 0.7;
export const PRESCREEN_UNCERTAINTY_VISIBILITY = 1.0;

const FALLBACK_PROMPT = `You are the UUTS Pre-screening skill for Unravel.

Score the campaign in ONE pass across three layers. Be fair, evidence-based, and consistent — not harsh.
Do NOT invent sources. If a claim has no citation, treat it as Unverifiable (not as false).
Return ONLY valid JSON (no markdown, no commentary).

================================================================
LAYER 1 — FACT-CHECK / ACCURACY (45% of composite)
================================================================
Goal: Are the factual claims true, sourced, and honestly framed?

Extract atomic claims (3–12). Score EACH claim with the per-claim formula:
  claimScore = tierBase × evidenceWeight × consensusFactor × regionalBonus   (cap at 100)

Evidence tiers — tierBase:
- Tier 1 — 100: peer-reviewed meta-analysis / systematic review
  (Cochrane, NEJM/Lancet/Nature/Science, IPCC assessment, WHO evidence review)
- Tier 2 — 90: 3+ independent IFCN-certified fact-checkers agree.
  Fact-checkers citing each other count as ONE source.
- Tier 3 — 80: one authoritative primary source + independent corroboration
  (CDC/WHO guideline + supporting papers, agency data + academic analysis)
- Tier 4 — 70: credentialed expert opinion with disclosed uncertainty.
  Weakest accepted evidence; never sufficient alone for a high-stakes claim.
- Tier 5 — 60: emerging evidence explicitly labeled preliminary
  (single unreplicated study, credible preprint, observational data, disclosed survey)
- Unverifiable/Contested — tierBase 0–40: anecdote, unattributed assertion,
  "some people say", social-media-only, or contradicted by credible sources.

evidenceWeight defaults to 1.00. The tier already prices source quality, so do NOT discount
a second time for the tier. Lower it (0.50–0.99) only when the cited source is a partial or
tangential fit for THIS claim — it backs part of the sentence, or backs a narrower point
than the one being made.

consensusFactor = 1.0 - (0.15 × proportion of sources disagreeing). Range 0.40–1.00.
  All agree 1.00 · some dispute 0.85–0.95 · significant dispute 0.70–0.84

regionalBonus by source composition (range 0.90–1.10):
  single country only 0.90 · 2 regions 1.00 · 3+ regions 1.05 · global consensus body 1.10

Claims that are obvious hyperbole or clearly labelled opinion are NOT scored:
set tier "Not scored" and they are excluded from the mean. Opinion presented as fact
is scored and penalised instead.

Penalty matrix (report as positive magnitudes):
- Critical factual error (source does not support the claim, wrong figure): 25 per claim
- Cherry-picked data (ignoring contrary evidence of equal/greater quality): 20 per instance
- Misleading statistical framing (no baseline/denominator, abused time window): 15 per instance
- Omitted contrary evidence (passive failure to acknowledge known counter-evidence): 10 each

Penalties are PERCENTAGE deductions, not flat points, and total no more than 25.
factCheck.score = mean(scored claimScores) × (1 - totalPenalties/100), clamped 0–100.

Subscores (0–100, diagnostic only):
- claimAccuracy: average strength of claim verdicts
- sourceQuality: quality/diversity of cited sources
- contextIntegrity: necessary caveats/baselines included
- uncertaintyDisclosure: uncertainty labeled where needed

For each claim return: id, text, source, tier, verdict
(Supported | Partially supported | Unsupported | Unverifiable | Needs context | Not scored),
plus tierBase, evidenceWeight, consensusFactor, regionalBonus.

================================================================
LAYER 2 — COMMUNICATION INTEGRITY (30% of composite)
================================================================
This layer does NOT measure whether a position is correct. It measures whether framing is
manipulative, one-sided, contextually incomplete, or tribally coded. Honest advocacy can score
well; hidden or manipulative advocacy cannot.

Score each dimension 1–5 using these tables (1 = worst, 5 = best):

E Evidence Quality — strength, diversity and transparency of sourcing
  1 single-source, partisan outlets only, opinion blogs, social posts as evidence
  2 1–2 sources of mixed reliability; narrow or ideologically leaning
  3 mix of mainstream and niche; credible but not compelling
  4 multiple independent reputable sources spanning perspectives
  5 systematic reviews / consensus statements / cross-ideological agreement on facts

F Framing — balance versus one-sidedness of presentation
  1 entirely structured toward one conclusion; no complexity or trade-offs
  2 nods to complexity then dismisses it; all framing devices point one way
  3 some balance; acknowledges trade-offs but weights one side disproportionately
  4 multiple framings acknowledged; emphasis proportionate to evidence
  5 competing framings treated fairly; contested claims presented as contested
  Watch for: anchor-and-dismiss, question begging, selective comparison,
  temporal cherry-picking, denominator blindness.

P Perspective — range and seriousness of viewpoints engaged
  1 single viewpoint; opposing views absent or caricatured
  2 token acknowledgment / strawman ("some say X, but they're wrong")
  3 one serious counter-view present but shallow; clearly favours one side
  4 multiple views summarised with empathy; reader could articulate both sides
  5 systematic discussion of major perspectives; functions as a guide to the debate
  Steelman test: would an opponent say "they represented my position fairly"?

T Tone — emotional temperature of delivery
  1 alarmist, shaming, villains/heroes, urgency without justification
  2 strong emotive language; urgency dialled high; reader feels pushed
  3 mixed; shifts between measured and heated
  4 calm overall; emotion used sparingly and contextually
  5 calm and analytical; emotion only in personal stories, not core claims
  Substitution test: if the emotional language were removed, does the argument survive?
  Judge against subject matter — urgency about a real emergency is appropriate.

L Language — specific word choices (distinct from Tone)
  1 pervasive loaded, coded, or weaponised words
  2 regular loaded terms; key claims wrapped in emotional language
  3 mix of neutral and loaded terms
  4 predominantly neutral and descriptive; occasional appropriate emotion
  5 descriptive, specific, accurate throughout; emotional words absent or marked subjective
  Loaded categories: political coding, dehumanising terms, catastrophising,
  certainty inflation, moral smuggling ("any decent person", "obviously").
  Affect-word density per 100 words: 0–2 → 5 · 3–4 → 4 · 5–7 → 3 · 8–10 → 2 · 11+ → 1

C Context — critical background needed to understand the claims
  1 key context omitted; reader would conclude differently with full context
  2 important context missing; partial picture that skews understanding
  3 main context present; secondary nuance missing
  4 all major context present; minor gaps only
  5 full background: history, scale, comparison baselines, uncertainties, limitations
  Tactics to catch: missing baseline, temporal window abuse, denominator suppression,
  correlation-as-causation, survivorship bias, scope mismatch.

A Audience Respect — empowerment versus condescension
  1 talks down; implies readers are stupid for not agreeing; dismisses concerns as ignorance
  2 patronising; "let me explain simply"; treats skepticism as deficiency
  3 neutral, informational but flat
  4 validates intelligence and concerns; presents info as empowering, not corrective
  5 actively validates the right to question; normalises skepticism; provides tools to evaluate

D Disclosure — transparency about agenda, funding, backing, bias
  1 no disclosure of who or why; astroturfing; false-flag neutrality
  2 identity visible but motivation and funding hidden
  3 creator and general purpose stated; funding/conflicts unaddressed
  4 creator, purpose and major backing disclosed; potential biases acknowledged
  5 full disclosure: who, why, funding, sought outcome, acknowledged biases and limits
  Grassroots is fine — a named individual with a stated concern can score 5.
  Failures: astroturfing, false neutrality, funding opacity, undisclosed conflict, mission washing.

Cross-dimensional modifier (bias compounds, it does not merely add):
  crossDimModifier = 1.0 - (0.05 × number of dimensions scoring ≤ 2)
  0–1 weak dimensions → 1.00 · 2 → 0.90 · 3 → 0.85 · 4 → 0.80 · 5+ → 0.75 (floor)

Category severity modifiers (lower = stricter):
- Medical/Health: 0.85
- Political/Civic: 0.90
- Financial/Economic: 0.90
- Environmental: 1.00
- Social Cause: 1.00
- Feel-Good/Cultural: 1.10
- Other/unknown: 1.00

Frame penalties (cumulative, capped at 25 total; report as a positive number):
  guilt by association 10 · misleading context 8 · false equivalence 6 ·
  motte-and-bailey 6 · slippery slope 5 · nirvana fallacy 5 · gish gallop 5 ·
  appeal to nature 4

commsIntegrity.raw = sum of the 8 dimension scores, out of 40.
commsIntegrity.score = round(clamp((raw / 40) * 100 * categoryModifier * crossDimModifier - framePenalty, 0, 100)).
The dimension scores must match the framing rationale. If the framing says the campaign is inflammatory,
loaded, accusatory, condescending, one-sided, or manipulative, lower the relevant F/T/L/A dimensions.
Do not return all 5s with a negative framing rationale.

================================================================
LAYER 3 — SHARED REALITY / BRIDGE-BUILDING (25% of composite)
================================================================
Measures whether the campaign helps audiences think together across divides.

Each sub has a FIXED checklist. Use these exact element labels and point maxes — do NOT
invent elements, rename them, or change any max. Award whole points from 0 up to each max.

1) Accessibility (weight 0.30) — reaches fact-resistant audiences who distrust institutions
   Validates skepticism ................... max 10  ("You're right to ask questions—that's smart")
   Non-institutional sources ..............  max 8  ("independent researchers" over "the CDC says")
   Avoids tribal language .................  max 7  (no coded terms, no "trust the science" slogans)
   International evidence .................  max 5  (research from multiple countries/regions)
   Personal relevance .....................  max 5  ("why this matters to you/your family")

2) Bridge Potential (weight 0.35) — can people who disagree still think together?
   Invites curiosity over agreement ....... max 12  (ends with a question or invitation)
   Multiple valid interpretations ......... max 10  ("evidence suggests X, though some read it as Y")
   Legitimate competing values ............ max 10  ("both sides want [goal], disagree on [mechanism]")
   "Reasonable disagreement" framing ......  max 8  ("experts disagree on X but agree on Y")

3) Epistemic Humility (weight 0.20) — signals uncertainty where evidence is incomplete
   Discloses study limitations ............  max 8  (population, short-term data, design limits)
   Probabilistic language .................  max 7  ("suggests", "indicates", "may", "likely")
   "What we know" vs "what we're learning"   max 6  (separates settled from emerging evidence)
   Invites further investigation ..........  max 4  ("researchers continue studying...")

4) Values Bridge (weight 0.15) — +3 per moral foundation AUTHENTICALLY engaged
   Care/Harm ..............................  max 3
   Fairness/Justice .......................  max 3
   Loyalty/Community ......................  max 3
   Authority/Tradition ....................  max 3
   Liberty/Autonomy .......................  max 3
   Award 3 only for a substantive appeal (a full sentence with a specific example),
   never for a token mention. Aim for foundations on both political sides.

Reward appropriate humility; do NOT reward false balance on settled questions
(manufactured doubt is penalised in Layer 2, not rewarded here).

Each sub is normalized to 0–100 from its own checklist total, then weighted:
sharedReality.score = (Accessibility × 0.30) + (Bridge Potential × 0.35)
                    + (Epistemic Humility × 0.20) + (Values Bridge × 0.15)

================================================================
COMPOSITE
================================================================
compositeBase = round(
  factCheck.score * 0.45 +
  commsIntegrity.score * 0.30 +
  sharedReality.score * 0.25
)

Report compositeBase only. This is an automated pre-screen with no human validation, so the
Confidence Factor (CF = 0.70) and Uncertainty Visibility are applied downstream, not by you.

Calibrate compositeBase against these bands:
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
      {
        "id": "C1",
        "text": "",
        "source": null,
        "tier": "Tier 3",
        "verdict": "",
        "tierBase": 80,
        "evidenceWeight": 1,
        "consensusFactor": 1,
        "regionalBonus": 1
      }
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
      {
        "name": "Accessibility",
        "elements": [
          { "label": "Validates skepticism", "got": 0, "max": 10 },
          { "label": "Non-institutional sources", "got": 0, "max": 8 },
          { "label": "Avoids tribal language", "got": 0, "max": 7 },
          { "label": "International evidence", "got": 0, "max": 5 },
          { "label": "Personal relevance", "got": 0, "max": 5 }
        ]
      },
      {
        "name": "Bridge Potential",
        "elements": [
          { "label": "Invites curiosity over agreement", "got": 0, "max": 12 },
          { "label": "Multiple valid interpretations", "got": 0, "max": 10 },
          { "label": "Legitimate competing values", "got": 0, "max": 10 },
          { "label": "\\"Reasonable disagreement\\" framing", "got": 0, "max": 8 }
        ]
      },
      {
        "name": "Epistemic Humility",
        "elements": [
          { "label": "Discloses study limitations", "got": 0, "max": 8 },
          { "label": "Probabilistic language", "got": 0, "max": 7 },
          { "label": "\\"What we know\\" vs \\"what we're learning\\"", "got": 0, "max": 6 },
          { "label": "Invites further investigation", "got": 0, "max": 4 }
        ]
      },
      {
        "name": "Values Bridge",
        "elements": [
          { "label": "Care/Harm", "got": 0, "max": 3 },
          { "label": "Fairness/Justice", "got": 0, "max": 3 },
          { "label": "Loyalty/Community", "got": 0, "max": 3 },
          { "label": "Authority/Tradition", "got": 0, "max": 3 },
          { "label": "Liberty/Autonomy", "got": 0, "max": 3 }
        ]
      }
    ]
  },
  "compositeBase": 0
}

Campaign content will be provided after this rubric.`;

export interface RunUutsPrescreenParams {
  db: Firestore;
  vertexAI: VertexAI;
  campaignId: string;
  campaign: JsonObject;
  promptDocId?: string;
  /** Optional allowlisted model id (Gemini or Claude Opus). */
  model?: string | null;
  /**
   * When true, enable provider web search / Google Search grounding so the model can
   * research claims beyond sources cited in the submission. Default false (cited-only).
   */
  externalResearch?: boolean;
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

function addSourceUrl(candidate: string, found: string[]): void {
  const cleaned = candidate.trim().replace(/[.,;:]+$/g, '');
  if (!cleaned) return;
  try {
    const u = new URL(/^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host.endsWith('.local') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return;
    }
    if (!found.includes(u.toString())) found.push(u.toString());
  } catch {
    // ignore invalid URLs
  }
}

/** Pull URLs from Sources-box entries only (never from description text). */
export function extractSourceUrls(campaign: JsonObject): string[] {
  const raw = campaign.campaign_sources ?? campaign.sources;
  const found: string[] = [];
  const pushUrl = (value: unknown) => {
    const s = text(value);
    if (!s) return;
    const matches =
      s.match(/https?:\/\/[^\s<>"'`)\]]+/gi) ||
      s.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"'`)\]]*)?/gi) ||
      [];
    for (const match of matches) addSourceUrl(match, found);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') pushUrl(item);
      else {
        const row = asObject(item);
        pushUrl(row.url);
        pushUrl(row.detail);
        pushUrl(row.name);
        pushUrl([row.name, row.detail, row.url].filter(Boolean).join(' '));
      }
    }
  } else if (typeof raw === 'string') {
    pushUrl(raw);
  }

  return found.slice(0, MAX_SOURCE_FETCHES);
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export type FetchedSourceEvidence = {
  url: string;
  ok: boolean;
  status?: number;
  title?: string;
  text?: string;
  error?: string;
  chars?: number;
};

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function isRetryableFetchFailure(row: FetchedSourceEvidence): boolean {
  if (row.ok) return false;
  const err = (row.error || '').toLowerCase();
  if (err.includes('abort') || err.includes('timeout') || err.includes('network') || err.includes('fetch failed')) {
    return true;
  }
  return row.status === 408 || row.status === 425 || row.status === 429 || row.status === 500 || row.status === 502 || row.status === 503 || row.status === 504;
}

async function readResponseBytes(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) {
    const ab = await res.arrayBuffer();
    return Buffer.from(ab).subarray(0, maxBytes);
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    const buf = Buffer.from(value);
    const room = maxBytes - total;
    chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
    total += Math.min(buf.length, room);
    if (buf.length > room) {
      try {
        await reader.cancel();
      } catch {
        // ignore cancel errors
      }
      break;
    }
  }
  return Buffer.concat(chunks, total);
}

async function extractPdfText(buf: Buffer): Promise<string> {
  // pdf-parse is CJS; keep require so ts-node/dev doesn't need esModuleInterop tweaks.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = require('pdf-parse') as (data: Buffer) => Promise<{ text?: string }>;
  const parsed = await pdfParse(buf);
  return text(parsed?.text);
}

async function fetchOneSourceUrlOnce(
  url: string,
  headers: Record<string, string>
): Promise<FetchedSourceEvidence> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers,
    });
    if (!res.ok) {
      return { url, ok: false, status: res.status, error: `HTTP ${res.status}` };
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const buf = await readResponseBytes(res, MAX_SOURCE_DOWNLOAD_BYTES);
    const looksPdf =
      contentType.includes('application/pdf') ||
      url.toLowerCase().includes('.pdf') ||
      buf.subarray(0, 5).toString('utf8') === '%PDF-';

    if (looksPdf) {
      try {
        const pdfText = (await extractPdfText(buf)).replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS_PER_SOURCE);
        if (!pdfText) {
          return { url, ok: false, status: res.status, error: 'Empty PDF text after extract' };
        }
        return {
          url,
          ok: true,
          status: res.status,
          title: 'PDF document',
          text: pdfText,
          chars: pdfText.length,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { url, ok: false, status: res.status, error: `PDF extract failed: ${msg}`.slice(0, 300) };
      }
    }

    const raw = buf.toString('utf8');
    let body = raw;
    if (contentType.includes('html') || /<html[\s>]/i.test(raw.slice(0, 500))) {
      body = stripHtmlToText(raw);
    } else {
      body = raw.replace(/\s+/g, ' ').trim();
    }
    body = body.slice(0, MAX_CHARS_PER_SOURCE);
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtmlToText(titleMatch[1]).slice(0, 200) : undefined;
    if (!body.trim()) {
      return { url, ok: false, status: res.status, title, error: 'Empty page text after fetch' };
    }
    return { url, ok: true, status: res.status, title, text: body, chars: body.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const normalized =
      /aborted|abort/i.test(msg) ? `Timeout after ${SOURCE_FETCH_TIMEOUT_MS}ms` : msg;
    return { url, ok: false, error: normalized.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

function preferBetterFetch(a: FetchedSourceEvidence, b: FetchedSourceEvidence): FetchedSourceEvidence {
  const aChars = a.ok ? a.chars || a.text?.length || 0 : 0;
  const bChars = b.ok ? b.chars || b.text?.length || 0 : 0;
  if (b.ok && bChars > aChars) return b;
  if (!a.ok && b.ok) return b;
  return a;
}

async function fetchOneSourceUrl(url: string): Promise<FetchedSourceEvidence> {
  let best = await fetchOneSourceUrlOnce(url, SOURCE_FETCH_HEADERS_BROWSER);

  const tryAlt = async () => {
    const alt = await fetchOneSourceUrlOnce(url, SOURCE_FETCH_HEADERS_BOT);
    best = preferBetterFetch(best, alt);
  };

  if (
    !best.ok ||
    best.status === 403 ||
    best.status === 429 ||
    (best.ok && (best.chars || 0) < SHORT_SOURCE_TEXT_CHARS)
  ) {
    await tryAlt();
  }

  if (isRetryableFetchFailure(best) || (best.ok && (best.chars || 0) < SHORT_SOURCE_TEXT_CHARS)) {
    await delay(400);
    const retry = await fetchOneSourceUrlOnce(url, SOURCE_FETCH_HEADERS_BOT);
    best = preferBetterFetch(best, retry);
    if (!best.ok || (best.chars || 0) < SHORT_SOURCE_TEXT_CHARS) {
      const retryBrowser = await fetchOneSourceUrlOnce(url, SOURCE_FETCH_HEADERS_BROWSER);
      best = preferBetterFetch(best, retryBrowser);
    }
  }

  if (best.ok && (best.chars || 0) < SHORT_SOURCE_TEXT_CHARS) {
    return {
      ...best,
      ok: false,
      text: undefined,
      chars: undefined,
      error: `Page text too short after fetch (${best.chars || 0} chars) — likely bot/cookie wall`,
    };
  }
  return best;
}

export async function fetchSourcesBoxEvidence(campaign: JsonObject): Promise<{
  urls: string[];
  results: FetchedSourceEvidence[];
  pack: string;
  fetchedOk: number;
  fetchedFailed: number;
  fetchErrors: Array<{ url: string; error: string; status?: number }>;
}> {
  const urls = extractSourceUrls(campaign);
  if (!urls.length) {
    return {
      urls: [],
      results: [],
      fetchedOk: 0,
      fetchedFailed: 0,
      fetchErrors: [],
      pack:
        'Fetched Sources-box evidence:\n(none — no http(s) URLs found in the Sources box. Do not invent sources from description text. Mark unsupported claims Unverifiable, not false.)',
    };
  }

  const results = await mapPool(urls, SOURCE_FETCH_CONCURRENCY, (url) => fetchOneSourceUrl(url));
  let remaining = MAX_EVIDENCE_CHARS_TOTAL;
  const blocks: string[] = [
    'Fetched Sources-box evidence (EXCLUSIVE Fact-Check source set — ignore description-only citations):',
  ];
  let fetchedOk = 0;
  let fetchedFailed = 0;
  const fetchErrors: Array<{ url: string; error: string; status?: number }> = [];

  results.forEach((row, index) => {
    if (row.ok && row.text) {
      fetchedOk += 1;
      const slice = row.text.slice(0, Math.max(0, remaining));
      remaining -= slice.length;
      blocks.push(
        `\n--- Source fetch ${index + 1} OK ---\nURL: ${row.url}${row.title ? `\nTitle: ${row.title}` : ''}\nExcerpt:\n${slice}${
          slice.length < row.text.length ? '…' : ''
        }`
      );
    } else {
      fetchedFailed += 1;
      fetchErrors.push({
        url: row.url,
        error: (row.error || 'unknown').slice(0, 200),
        status: row.status,
      });
      blocks.push(
        `\n--- Source fetch ${index + 1} FAILED ---\nURL: ${row.url}\nError: ${row.error || 'unknown'}${
          row.status != null ? ` (HTTP ${row.status})` : ''
        }\nTreat this Sources-box item as listed-but-unread; do not invent its contents or replace it with open-web results.`
      );
    }
  });

  return { urls, results, pack: blocks.join('\n'), fetchedOk, fetchedFailed, fetchErrors };
}

function slideshowDescriptions(raw: unknown): string[] {
  return asArray(raw)
    .map((slide) => text(asObject(slide).description))
    .filter(Boolean)
    .slice(0, 30);
}

export function buildCampaignContent(campaign: JsonObject): string {
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
    parts.push(`Sources box (authoritative source list):\n${sources.map((source, i) => `${i + 1}. ${source}`).join('\n')}`);
  } else {
    parts.push('Sources box (authoritative source list):\n(none provided)');
  }

  const slides = slideshowDescriptions(campaign.hero_slideshow);
  if (slides.length) {
    parts.push(`Slideshow descriptions:\n${slides.map((slide, i) => `${i + 1}. ${slide}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

function buildPrompt(
  promptTemplate: string,
  campaign: JsonObject,
  options?: { externalResearch?: boolean; evidencePack?: string }
): string {
  const campaignContent = buildCampaignContent(campaign);
  const template = promptTemplate.trim() || FALLBACK_PROMPT;
  let prompt: string;
  if (template.includes('{{campaign_content}}')) {
    prompt = template.split('{{campaign_content}}').join(campaignContent);
  } else if (template.includes('{campaign_content}')) {
    prompt = template.split('{campaign_content}').join(campaignContent);
  } else {
    prompt = `${template}\n\nCampaign to evaluate:\n---\n${campaignContent}\n---`;
  }
  const addendum = options?.externalResearch ? EXTERNAL_RESEARCH_ADDENDUM : NO_RESEARCH_CLARIFICATION;
  const evidence =
    options?.externalResearch && options.evidencePack
      ? `\n\n================================================================\nSOURCES-BOX EVIDENCE PACK\n================================================================\n${options.evidencePack}`
      : '';
  return `${prompt}\n\n${addendum}${evidence}`;
}

async function loadPromptFromFirestore(db: Firestore, promptDocId: string): Promise<string> {
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

async function loadPrompt(db: Firestore, promptDocId: string): Promise<UutsPromptSource> {
  return loadUutsPromptTemplate({
    fallback: FALLBACK_PROMPT,
    firestoreLoader: () => loadPromptFromFirestore(db, promptDocId),
  });
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

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function inRange(value: unknown, min: number, max: number, fallback: number): number {
  const n = numberOrNull(value);
  if (n == null) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Map a free-text tier label onto its base points and default evidence weight. */
function resolveTier(tierLabel: string): { base: number; weight: number } {
  if (/unverifiab|contested|unattributed|anecdot/i.test(tierLabel)) {
    return { base: UNVERIFIABLE_TIER.base, weight: UNVERIFIABLE_TIER.weight };
  }
  for (const tier of FACT_CHECK_TIERS) {
    if (tier.match.test(tierLabel)) return { base: tier.base, weight: tier.weight };
  }
  return { base: UNVERIFIABLE_TIER.base, weight: UNVERIFIABLE_TIER.weight };
}

/** Rhetorical flourishes and labelled opinion are recorded but excluded from the claim mean. */
function isUnscoredClaim(tierLabel: string, verdict: string): boolean {
  return /not scored|not applicable|n\/a|opinion|hyperbole/i.test(`${tierLabel} ${verdict}`);
}

/** Normalize a penalty to the Layer 1 matrix magnitude so the model cannot inflate deductions. */
function resolvePenaltyPoints(type: string, rawPoints: unknown): number {
  const provided = Math.abs(Number(rawPoints) || 0);
  if (provided > 0) return Math.min(MAX_FACT_CHECK_PENALTY_PER_ITEM, provided);
  for (const entry of FACT_CHECK_PENALTIES) {
    if (entry.match.test(type)) return entry.points;
  }
  return 0;
}

function mapFactCheck(raw: JsonObject): FactCheckLayer {
  const modelScore = clamp(firstPresent(raw, ['score', 'overallScore']), 0, 100);
  const subs = asObject(raw.subscores);

  const claims = asArray(firstPresent(raw, ['claims', 'atomicClaims'])).map((claim, index) => {
    const row = asObject(claim);
    const tier = text(row.tier, 'Unverifiable');
    const verdict = text(row.verdict, 'Needs review');
    const defaults = resolveTier(tier);
    const tierBase = clamp(row.tierBase, 0, 100) ?? defaults.base;
    const evidenceWeight = inRange(row.evidenceWeight, 0.5, 1, defaults.weight);
    const consensusFactor = inRange(row.consensusFactor, 0.4, 1, 1);
    const regionalBonus = inRange(row.regionalBonus, 0.9, 1.1, 1);
    const scored = !isUnscoredClaim(tier, verdict);
    const score = scored
      ? Math.max(0, Math.min(100, round1(tierBase * evidenceWeight * consensusFactor * regionalBonus)))
      : null;

    return {
      id: text(row.id, `C${index + 1}`),
      text: text(firstPresent(row, ['text', 'claim'])),
      source: row.source == null ? null : text(row.source),
      tier,
      verdict,
      tierBase,
      evidenceWeight,
      consensusFactor,
      regionalBonus,
      score,
    };
  });

  const penalties = asArray(raw.penalties).map((penalty) => {
    const row = asObject(penalty);
    const type = text(row.type, 'unspecified');
    return { type, points: resolvePenaltyPoints(type, row.points) };
  });

  const scoredClaims = claims.filter((claim) => claim.score != null);
  const claimsMean = scoredClaims.length
    ? round1(scoredClaims.reduce((sum, claim) => sum + (claim.score as number), 0) / scoredClaims.length)
    : null;
  const penaltyTotal = Math.min(
    MAX_FACT_CHECK_PENALTY_TOTAL,
    penalties.reduce((sum, penalty) => sum + penalty.points, 0)
  );

  // Recompute from the claim rows so the header score can never disagree with what admins see.
  const recomputed =
    claimsMean == null
      ? null
      : Math.max(0, Math.min(100, Math.round(claimsMean * (1 - penaltyTotal / 100))));
  const score = recomputed ?? modelScore;
  if (score == null) throw new Error('UUTS fact-check score is missing');

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
    claimsMean,
  };
}

function findDim(rawDims: unknown[], code: string): JsonObject {
  for (const dim of rawDims) {
    const row = asObject(dim);
    if (text(row.code).toUpperCase() === code) return row;
  }
  return {};
}

function computeCommsScoreFromDims(
  dims: CommsIntegrityLayer['dims'],
  categoryModifier: number,
  crossDimModifier: number,
  framePenalty: number
): { raw: number; score: number } {
  const raw = dims.reduce((sum, dim) => sum + (Number(dim.score) || 0), 0);
  const normalized = (raw / (COMMS_DIMS.length * 5)) * 100;
  const adjusted = normalized * categoryModifier * crossDimModifier - framePenalty;
  return {
    raw: Math.round(raw * 100) / 100,
    score: Math.max(0, Math.min(100, Math.round(adjusted))),
  };
}

/**
 * Cross-dimensional modifier: bias across several dimensions compounds rather than adds.
 * 1.0 - (0.05 x dimensions scoring <= 2), no effect below two, floored at 0.75.
 */
function computeCrossDimModifier(dims: CommsIntegrityLayer['dims']): number {
  const weak = dims.filter((dim) => (Number(dim.score) || 0) <= 2).length;
  if (weak < 2) return 1;
  return Math.max(CROSS_DIM_MODIFIER_FLOOR, 1 - 0.05 * weak);
}

/** Prefer the category modifier implied by the campaign category over the model's guess. */
function resolveCategoryModifier(category: string, provided: unknown): number {
  for (const entry of COMMS_CATEGORY_MODIFIERS) {
    if (entry.match.test(category)) return entry.modifier;
  }
  return inRange(provided, COMMS_MODIFIER_MIN, COMMS_MODIFIER_MAX, 1);
}

function mapCommsIntegrity(raw: JsonObject, category: string): CommsIntegrityLayer {
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
  const categoryModifier = resolveCategoryModifier(category, raw.categoryModifier);
  const crossDimModifier = computeCrossDimModifier(dims);
  const framePenalty = Math.min(
    MAX_FRAME_PENALTY,
    Math.abs(numberOrNull(raw.framePenalty) ?? 0)
  );
  const computed = computeCommsScoreFromDims(
    dims,
    categoryModifier,
    crossDimModifier,
    framePenalty
  );

  return {
    status: 'scored',
    score: computed.score,
    raw: computed.raw,
    dims,
    categoryModifier,
    crossDimModifier,
    framePenalty,
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

/** Match a model-supplied element to a fixed checklist row by label (loose, order-independent). */
function findElementPoints(rawElements: unknown[], label: string): number | null {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const target = normalize(label);
  for (const element of rawElements) {
    const row = asObject(element);
    const rowLabel = normalize(text(row.label ?? row.name));
    if (!rowLabel) continue;
    if (rowLabel === target || rowLabel.includes(target) || target.includes(rowLabel)) {
      return numberOrNull(firstPresent(row, ['got', 'points', 'score']));
    }
  }
  return null;
}

/**
 * Shared Reality uses the manual's fixed checklists. Each sub is normalized to 0-100 from its
 * own point total, then weighted, so a sub's stated point budget (30/35/20/15) is exactly its
 * contribution to the 100-point layer score.
 */
function mapSharedReality(raw: JsonObject): SharedRealityLayer {
  const rawSubs = asArray(raw.subs ?? raw.subComponents ?? raw.questions);
  const subs = SHARED_REALITY_SUBS.map((canonical) => {
    const row = findSharedSub(rawSubs, canonical.name);
    const rawElements = asArray(row.elements ?? row.checklist);
    const elements = canonical.elements.map((element) => {
      const got = findElementPoints(rawElements, element.label) ?? 0;
      return {
        label: element.label,
        got: Math.max(0, Math.min(element.max, Math.round(got))),
        max: element.max,
      };
    });
    const gotTotal = elements.reduce((sum, element) => sum + element.got, 0);
    const maxTotal = elements.reduce((sum, element) => sum + element.max, 0);

    return {
      name: canonical.name,
      weight: canonical.weight,
      score: maxTotal > 0 ? Math.round((gotTotal / maxTotal) * 100) : 0,
      max: 100,
      def: text(row.def ?? row.definition, canonical.def),
      elements,
    };
  });

  const weighted = subs.reduce((sum, sub) => sum + sub.score * sub.weight, 0);
  return {
    status: 'scored',
    score: Math.max(0, Math.min(100, Math.round(weighted))),
    subs,
  };
}

export function mapUutsPrescreenOutput(raw: unknown, category = ''): ScoreSnapshot {
  const root = asObject(raw);
  const factCheck = mapFactCheck(pickObject(root, ['factCheck', 'fact_check', 'accuracy']));
  const commsIntegrity = mapCommsIntegrity(
    pickObject(root, ['commsIntegrity', 'communicationsIntegrity', 'communicationIntegrity', 'fairness']),
    category
  );
  const sharedReality = mapSharedReality(
    pickObject(root, ['sharedReality', 'shared_reality', 'bridgeBuilding', 'bridge_building'])
  );

  // Always recompute from the layer scores; a model-supplied composite can contradict them.
  const compositeBase = computeComposite(factCheck.score, commsIntegrity.score, sharedReality.score);
  if (compositeBase == null) throw new Error('UUTS composite score could not be computed');
  const composite = applyConfidenceModifiers(
    compositeBase,
    PRESCREEN_CONFIDENCE_FACTOR,
    PRESCREEN_UNCERTAINTY_VISIBILITY
  );

  return {
    composite,
    compositeBase,
    confidenceFactor: PRESCREEN_CONFIDENCE_FACTOR,
    uncertaintyVisibility: PRESCREEN_UNCERTAINTY_VISIBILITY,
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

export type PrescreenGenerationResult = {
  snapshot: ScoreSnapshot;
  langfuseTraceId: string | null;
};

type PrescreenCallOptions = {
  externalResearch?: boolean;
};

async function generatePrescreenGemini(
  vertexAI: VertexAI,
  modelName: string,
  prompt: string,
  category: string,
  campaignId: string,
  promptMeta?: Pick<UutsPromptSource, 'promptName' | 'promptVersion' | 'source'>,
  callOptions?: PrescreenCallOptions
): Promise<PrescreenGenerationResult> {
  const externalResearch = callOptions?.externalResearch === true;
  const timeoutMs = externalResearch ? RESEARCH_TIMEOUT_MS : TIMEOUT_MS;
  // Sources-box research prefetches URL text into the prompt — no open-web tools.
  const model = vertexAI.getGenerativeModel({
    model: modelName,
    generationConfig: { temperature: 0.5 },
  });

  return traceGeminiCall({
    name: 'prescreen-uuts',
    model: modelName,
    tags: [
      'uuts-prescreen',
      'gemini',
      externalResearch ? 'sources-box-research' : 'cited-only',
    ],
    metadata: {
      campaignId: metaStr(campaignId),
      category: metaStr(category, 80),
      provider: 'gemini',
      promptSource: metaStr(promptMeta?.source || 'unknown', 40),
      promptName: metaStr(promptMeta?.promptName || '', 80),
      promptVersion: metaStr(promptMeta?.promptVersion ?? '', 20),
      externalResearch: externalResearch ? 'true' : 'false',
      researchMode: externalResearch ? 'sources-box' : 'none',
    },
    input: {
      campaignId,
      category,
      externalResearch,
      prompt: prompt.length > 8000 ? `${prompt.slice(0, 8000)}…` : prompt,
    },
    run: async () => {
      const result = await withTimeout(
        model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }),
        timeoutMs
      );
      const responseText =
        result.response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      if (!responseText) {
        scoreActiveUutsFailure('UUTS pre-screen returned an empty response');
        throw new Error('UUTS pre-screen returned an empty response');
      }
      let snapshot: ScoreSnapshot;
      try {
        snapshot = mapUutsPrescreenOutput(extractJson(responseText), category);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        scoreActiveUutsFailure(msg);
        throw err;
      }
      const health = evaluateUutsSchemaHealth(snapshot);
      scoreActiveUutsRun(snapshot, health, {
        promptName: promptMeta?.promptName,
        promptVersion: promptMeta?.promptVersion,
      });
      return {
        result: { snapshot, langfuseTraceId: getActiveLangfuseTraceId() },
        output: {
          composite: snapshot.composite,
          compositeBase: snapshot.compositeBase ?? null,
          confidenceFactor: snapshot.confidenceFactor ?? null,
          factCheck: snapshot.factCheck?.score ?? null,
          commsIntegrity: snapshot.commsIntegrity?.score ?? null,
          sharedReality: snapshot.sharedReality?.score ?? null,
          schemaValid: health.schemaValid,
          externalResearch,
          researchMode: externalResearch ? 'sources-box' : 'none',
          raw: responseText.length > 6000 ? `${responseText.slice(0, 6000)}…` : responseText,
        },
        usageDetails: extractVertexUsage(result),
      };
    },
  });
}

async function generatePrescreenAnthropic(
  modelName: string,
  prompt: string,
  category: string,
  campaignId: string,
  promptMeta?: Pick<UutsPromptSource, 'promptName' | 'promptVersion' | 'source'>,
  callOptions?: PrescreenCallOptions
): Promise<PrescreenGenerationResult> {
  const externalResearch = callOptions?.externalResearch === true;
  const timeoutMs = externalResearch ? RESEARCH_TIMEOUT_MS : TIMEOUT_MS;
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY is required for Claude UUTS models'), {
      status: 500,
    });
  }
  const client = new Anthropic({ apiKey });

  return traceGeminiCall({
    name: 'prescreen-uuts',
    model: modelName,
    tags: [
      'uuts-prescreen',
      'anthropic',
      externalResearch ? 'sources-box-research' : 'cited-only',
    ],
    metadata: {
      campaignId: metaStr(campaignId),
      category: metaStr(category, 80),
      provider: 'anthropic',
      promptSource: metaStr(promptMeta?.source || 'unknown', 40),
      promptName: metaStr(promptMeta?.promptName || '', 80),
      promptVersion: metaStr(promptMeta?.promptVersion ?? '', 20),
      externalResearch: externalResearch ? 'true' : 'false',
      researchMode: externalResearch ? 'sources-box' : 'none',
    },
    input: {
      campaignId,
      category,
      externalResearch,
      prompt: prompt.length > 8000 ? `${prompt.slice(0, 8000)}…` : prompt,
    },
    run: async () => {
      const result = await withTimeout(
        client.messages.create({
          model: modelName,
          max_tokens: externalResearch ? ANTHROPIC_RESEARCH_MAX_TOKENS : ANTHROPIC_MAX_TOKENS,
          temperature: 0.5,
          messages: [{ role: 'user', content: prompt }],
        }),
        timeoutMs
      );
      const responseText = result.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n')
        .trim();
      if (!responseText) {
        scoreActiveUutsFailure('UUTS pre-screen (Claude) returned an empty response');
        throw new Error('UUTS pre-screen (Claude) returned an empty response');
      }
      let snapshot: ScoreSnapshot;
      try {
        snapshot = mapUutsPrescreenOutput(extractJson(responseText), category);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        scoreActiveUutsFailure(msg);
        throw err;
      }
      const health = evaluateUutsSchemaHealth(snapshot);
      scoreActiveUutsRun(snapshot, health, {
        promptName: promptMeta?.promptName,
        promptVersion: promptMeta?.promptVersion,
      });
      return {
        result: { snapshot, langfuseTraceId: getActiveLangfuseTraceId() },
        output: {
          composite: snapshot.composite,
          compositeBase: snapshot.compositeBase ?? null,
          confidenceFactor: snapshot.confidenceFactor ?? null,
          factCheck: snapshot.factCheck?.score ?? null,
          commsIntegrity: snapshot.commsIntegrity?.score ?? null,
          sharedReality: snapshot.sharedReality?.score ?? null,
          schemaValid: health.schemaValid,
          externalResearch,
          researchMode: externalResearch ? 'sources-box' : 'none',
          raw: responseText.length > 6000 ? `${responseText.slice(0, 6000)}…` : responseText,
        },
        usageDetails: {
          input: result.usage?.input_tokens,
          output: result.usage?.output_tokens,
          total:
            result.usage?.input_tokens != null && result.usage?.output_tokens != null
              ? result.usage.input_tokens + result.usage.output_tokens
              : undefined,
        },
      };
    },
  });
}

async function generatePrescreen(
  vertexAI: VertexAI,
  modelOption: UutsModelOption,
  prompt: string,
  category: string,
  campaignId: string,
  promptMeta?: Pick<UutsPromptSource, 'promptName' | 'promptVersion' | 'source'>,
  callOptions?: PrescreenCallOptions
): Promise<PrescreenGenerationResult> {
  if (modelOption.provider === 'anthropic') {
    return generatePrescreenAnthropic(
      modelOption.id,
      prompt,
      category,
      campaignId,
      promptMeta,
      callOptions
    );
  }
  return generatePrescreenGemini(
    vertexAI,
    modelOption.id,
    prompt,
    category,
    campaignId,
    promptMeta,
    callOptions
  );
}

export async function runUutsPrescreenAndPersist({
  db,
  vertexAI,
  campaignId,
  campaign,
  promptDocId = DEFAULT_PROMPT_DOC_ID,
  model: requestedModel,
  externalResearch: externalResearchRaw,
}: RunUutsPrescreenParams): Promise<void> {
  const campaignRef = db.collection('campaigns').doc(campaignId);
  const modelOption = resolveUutsModel(requestedModel);
  const externalResearch = externalResearchRaw === true;
  const promptSource = await loadPrompt(db, promptDocId);

  let evidencePack = '';
  let sourcesFetchedOk = 0;
  let sourcesFetchedFailed = 0;
  let sourcesUrlCount = 0;
  let sourcesFetchErrors: Array<{ url: string; error: string; status?: number }> = [];
  if (externalResearch) {
    const evidence = await fetchSourcesBoxEvidence(campaign);
    evidencePack = evidence.pack;
    sourcesFetchedOk = evidence.fetchedOk;
    sourcesFetchedFailed = evidence.fetchedFailed;
    sourcesUrlCount = evidence.urls.length;
    sourcesFetchErrors = evidence.fetchErrors.slice(0, 20);
    console.log(
      `UUTS sources-box research for ${campaignId}: ${sourcesUrlCount} urls, ${sourcesFetchedOk} ok, ${sourcesFetchedFailed} failed`
    );
    if (sourcesFetchErrors.length) {
      console.warn(
        `UUTS sources-box fetch failures for ${campaignId}:`,
        sourcesFetchErrors.map((row) => `${row.url} → ${row.error}`).join(' | ')
      );
    }
  }

  const prompt = buildPrompt(promptSource.template, campaign, {
    externalResearch,
    evidencePack: externalResearch ? evidencePack : undefined,
  });
  const category = text(campaign.category);
  let attempts = 0;

  await campaignRef.update({
    uuts_prescreen_status: 'in_progress',
    uuts_prescreen_attempts: attempts,
    uuts_prescreen_error: null,
    uuts_prescreen_model: modelOption.id,
    uuts_prescreen_provider: modelOption.provider,
    uuts_prescreen_external_research: externalResearch,
    uuts_prescreen_research_mode: externalResearch ? 'sources-box' : null,
    uuts_prescreen_sources_fetched_ok: externalResearch ? sourcesFetchedOk : null,
    uuts_prescreen_sources_fetched_failed: externalResearch ? sourcesFetchedFailed : null,
    uuts_prescreen_sources_url_count: externalResearch ? sourcesUrlCount : null,
    uuts_prescreen_sources_fetch_errors: externalResearch ? sourcesFetchErrors : null,
    uuts_prescreen_prompt_source: promptSource.source,
    uuts_prescreen_prompt_version: promptSource.promptVersion ?? null,
    uuts_prescreen_started_at: nowIso(),
    uuts_prescreen_updated_at: nowIso(),
  });

  try {
    let generation: PrescreenGenerationResult | null = null;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      await campaignRef.update({
        uuts_prescreen_attempts: attempts,
        uuts_prescreen_updated_at: nowIso(),
      });
      try {
        generation = await generatePrescreen(
          vertexAI,
          modelOption,
          prompt,
          category,
          campaignId,
          promptSource,
          { externalResearch }
        );
        break;
      } catch (error) {
        lastError = error;
        console.warn(`UUTS pre-screen attempt ${attempt}/${MAX_ATTEMPTS} failed for ${campaignId}:`, error);
        if (attempt < MAX_ATTEMPTS) {
          await delay(500 * attempt);
        }
      }
    }

    if (!generation) {
      throw lastError || new Error('UUTS pre-screen failed');
    }

    const { snapshot, langfuseTraceId } = generation;

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
      createdBy: externalResearch ? 'uuts-prescreen-external-research' : 'uuts-prescreen',
      model: modelOption.id,
      provider: modelOption.provider,
      refresh: true,
      publish: false,
    });

    await campaignRef.update({
      uuts_prescreen_status: 'complete',
      uuts_prescreen_attempts: attempts,
      uuts_prescreen_error: null,
      uuts_prescreen_composite: snapshot.composite,
      uuts_prescreen_composite_base: snapshot.compositeBase ?? null,
      uuts_prescreen_confidence_factor: snapshot.confidenceFactor ?? null,
      uuts_prescreen_version_id: result.versionId,
      uuts_prescreen_version_number: result.version,
      uuts_prescreen_model: modelOption.id,
      uuts_prescreen_provider: modelOption.provider,
      uuts_prescreen_external_research: externalResearch,
      uuts_prescreen_prompt_source: promptSource.source,
      uuts_prescreen_prompt_version: promptSource.promptVersion ?? null,
      uuts_prescreen_langfuse_trace_id: langfuseTraceId,
      uuts_prescreen_completed_at: nowIso(),
      uuts_prescreen_updated_at: nowIso(),
      updatedAt: nowIso(),
    });
  } catch (error) {
    await campaignRef.update({
      uuts_prescreen_status: 'manual_required',
      uuts_prescreen_attempts: attempts,
      uuts_prescreen_error: errorMessage(error).slice(0, 1000),
      uuts_prescreen_external_research: externalResearch,
      uuts_prescreen_failed_at: nowIso(),
      uuts_prescreen_updated_at: nowIso(),
      updatedAt: nowIso(),
    });
    throw error;
  }
}

export interface RunUutsSchedulerOptions {
  db: Firestore;
  vertexAI: VertexAI;
  dryRun?: boolean;
  limit?: number;
  campaignIds?: string[];
  model?: string | null;
  promptDocId?: string;
  externalResearch?: boolean;
}

/**
 * Batch UUTS re-score for Cloud Scheduler. Creates draft versions only (never publishes).
 * Gated by isUutsSchedulerEnabled() at the HTTP layer.
 */
export async function runUutsPrescreenScheduler(
  options: RunUutsSchedulerOptions
): Promise<{
  ok: boolean;
  dryRun: boolean;
  schedulerEnabled: true;
  model: string;
  provider: UutsProvider;
  externalResearch: boolean;
  considered: number;
  queued: number;
  skipped: number;
  results: Array<{ campaignId: string; action: 'queued' | 'would_queue' | 'skipped'; reason?: string }>;
}> {
  const {
    db,
    vertexAI,
    dryRun = false,
    limit = 20,
    campaignIds,
    model,
    promptDocId,
    externalResearch: externalResearchRaw,
  } = options;
  const modelOption = resolveUutsModel(model);
  const externalResearch = externalResearchRaw === true;
  const results: Array<{
    campaignId: string;
    action: 'queued' | 'would_queue' | 'skipped';
    reason?: string;
  }> = [];

  let docs: QueryDocumentSnapshot[] = [];
  if (campaignIds && campaignIds.length > 0) {
    const snaps = await Promise.all(
      campaignIds.slice(0, Math.max(1, limit)).map((id) => db.collection('campaigns').doc(id).get())
    );
    docs = snaps.filter((s) => s.exists) as QueryDocumentSnapshot[];
  } else {
    const snap = await db.collection('campaigns').limit(Math.max(1, Math.min(limit, 100))).get();
    docs = snap.docs;
  }

  let queued = 0;
  let skipped = 0;

  for (const doc of docs) {
    const campaignId = doc.id;
    const data = doc.data() || {};
    const status = String(data.status || '');
    // Skip campaigns already mid-run to avoid duplicate draft versions.
    if (data.uuts_prescreen_status === 'in_progress' || data.uuts_prescreen_status === 'queued') {
      skipped += 1;
      results.push({ campaignId, action: 'skipped', reason: `status=${data.uuts_prescreen_status}` });
      continue;
    }
    if (status && !['Approved', 'Pending', 'Completed', 'Draft'].includes(status)) {
      skipped += 1;
      results.push({ campaignId, action: 'skipped', reason: `campaign status=${status}` });
      continue;
    }

    if (dryRun) {
      results.push({ campaignId, action: 'would_queue' });
      queued += 1;
      continue;
    }

    const queuedAt = nowIso();
    await doc.ref.update({
      uuts_prescreen_status: 'queued',
      uuts_prescreen_attempts: 0,
      uuts_prescreen_error: null,
      uuts_prescreen_external_research: externalResearch,
      uuts_prescreen_updated_at: queuedAt,
      updatedAt: queuedAt,
    });

    void runUutsPrescreenAndPersist({
      db,
      vertexAI,
      campaignId,
      campaign: { id: campaignId, ...data },
      promptDocId,
      model: modelOption.id,
      externalResearch,
    }).catch((err) => console.error(`UUTS scheduler background error for ${campaignId}:`, err));

    queued += 1;
    results.push({ campaignId, action: 'queued' });
  }

  return {
    ok: true,
    dryRun,
    schedulerEnabled: true,
    model: modelOption.id,
    provider: modelOption.provider,
    externalResearch,
    considered: docs.length,
    queued,
    skipped,
    results,
  };
}
