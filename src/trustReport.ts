/**
 * UUTS Trust Score report — Phase 0 persistence + read payload (UE-163 / UE-167).
 *
 * Firestore layout (named DB `unravel`):
 *   trust_reports/{campaignId}
 *     publishedVersionId, latestVersionId, updatedAt
 *   trust_reports/{campaignId}/versions/{versionId}
 *     version, status (draft|published|archived), initial, final, review, timestamps
 *
 * Refresh creates a new draft version; publishing never mutates a prior published doc.
 * Legacy campaign.trust_score is left untouched.
 */

import type { Firestore, DocumentData } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

export const TRUST_REPORTS_COLLECTION = 'trust_reports';
export const TRUST_REPORT_VERSIONS_SUB = 'versions';

export const TRUST_LAYER_WEIGHTS = {
  factCheck: 0.45,
  commsIntegrity: 0.3,
  sharedReality: 0.25,
} as const;

export type LayerStatus = 'scored' | 'not_scored' | 'pending';
export type VersionStatus = 'draft' | 'published' | 'archived';
/** Canonical review-console decisions. Legacy aliases are accepted on read/write. */
export type ReviewDecision = 'pending' | 'accepted' | 'rejected' | 'on_hold';
export type LayerKey = 'factCheck' | 'commsIntegrity' | 'sharedReality';

export const HUMAN_REVIEW_CONFIDENCE_FACTOR = 0.85;
export const HUMAN_REVIEW_UNCERTAINTY_VISIBILITY = 1.0;

export const REVIEW_LAYER_KEYS: LayerKey[] = ['factCheck', 'commsIntegrity', 'sharedReality'];

/**
 * One atomic claim. `evidenceWeight` / `consensusFactor` / `regionalBonus` / `score` carry the
 * Layer 1 per-claim formula so the layer score can be recomputed from the rows shown in the UI.
 */
export interface FactCheckClaim {
  id: string;
  text: string;
  source: string | null;
  tier: string;
  verdict: string;
  tierBase?: number | null;
  evidenceWeight?: number | null;
  consensusFactor?: number | null;
  regionalBonus?: number | null;
  score?: number | null;
}

export interface FactCheckLayer {
  status: LayerStatus;
  score: number | null;
  subscores: {
    claimAccuracy: number;
    sourceQuality: number;
    contextIntegrity: number;
    uncertaintyDisclosure: number;
  } | null;
  claims: FactCheckClaim[];
  penalties: Array<{ type: string; points: number }>;
  /** Mean of scored claims before penalties (Layer 1 Σ/n × 100). */
  claimsMean?: number | null;
}

export interface CommsIntegrityLayer {
  status: LayerStatus;
  score: number | null;
  raw: number | null;
  dims: Array<{ code: string; name: string; score: number; def?: string }>;
  categoryModifier: number | null;
  crossDimModifier: number | null;
  framePenalty: number | null;
  framing: string | null;
}

export interface SharedRealityLayer {
  status: LayerStatus;
  score: number | null;
  subs: Array<{
    name: string;
    weight: number;
    score: number;
    max: number;
    def?: string | null;
    elements: Array<{ label: string; got: number; max: number }>;
  }>;
}

/** One complete scoring snapshot (AI initial or human final). */
export interface ScoreSnapshot {
  composite: number | null;
  /** Layer-weighted composite before Confidence Factor / Uncertainty Visibility. */
  compositeBase?: number | null;
  /** Confidence Factor (0.70–1.00). 0.70 = automated pre-screen with no human validation. */
  confidenceFactor?: number | null;
  /** Uncertainty Visibility modifier (0.95–1.05). */
  uncertaintyVisibility?: number | null;
  factCheck: FactCheckLayer;
  commsIntegrity: CommsIntegrityLayer;
  sharedReality: SharedRealityLayer;
}

/** Per-component acknowledgement that AI / human review is official. */
export interface LayerReviewAck {
  aiReviewed: boolean;
  humanReviewed: boolean;
}

export type LayerReviews = Record<LayerKey, LayerReviewAck>;

export interface ReviewState {
  aiReviewed: boolean;
  humanReviewed: boolean;
  assignedReviewer: string | null;
  decision: ReviewDecision;
  reviewedAt: string | null;
  decidedAt: string | null;
  reviewer: string | null;
  notes: string | null;
  layers: LayerReviews;
}

export interface TrustReportVersionDoc {
  version: number;
  status: VersionStatus;
  createdAt: unknown;
  updatedAt: unknown;
  publishedAt: unknown | null;
  createdBy: string | null;
  /** Model id that produced `initial` (e.g. gemini-2.5-flash-lite, claude-opus-…). */
  model: string | null;
  /** Provider that produced `initial` (gemini | anthropic). */
  provider: string | null;
  initial: ScoreSnapshot;
  final: ScoreSnapshot | null;
  review: ReviewState;
}

export interface TrustReportSource {
  name: string;
  detail: string | null;
  url: string | null;
}

/** Public + admin read payload (matches UI TrustReport + Phase 0 distinction fields). */
export interface TrustReportPayload {
  campaign: {
    id: string;
    title: string;
    category: string | null;
    reviewedAt: string | null;
    reviewer: string | null;
  };
  composite: number | null;
  band: string | null;
  factCheck: FactCheckLayer;
  commsIntegrity: CommsIntegrityLayer;
  sharedReality: SharedRealityLayer;
  sources: TrustReportSource[];
  /** AI-generated scores */
  initial: ScoreSnapshot;
  /** Human-adjusted scores (null if not yet human-reviewed) */
  final: ScoreSnapshot | null;
  review: ReviewState;
  version: {
    id: string;
    number: number;
    status: VersionStatus;
    publishedAt: string | null;
    model: string | null;
    provider: string | null;
  };
}

const EMPTY_FACT_CHECK: FactCheckLayer = {
  status: 'not_scored',
  score: null,
  subscores: null,
  claims: [],
  penalties: [],
  claimsMean: null,
};

const EMPTY_COMMS: CommsIntegrityLayer = {
  status: 'not_scored',
  score: null,
  raw: null,
  dims: [],
  categoryModifier: null,
  crossDimModifier: null,
  framePenalty: null,
  framing: null,
};

const EMPTY_SHARED: SharedRealityLayer = {
  status: 'not_scored',
  score: null,
  subs: [],
};

export function emptySnapshot(): ScoreSnapshot {
  return {
    composite: null,
    compositeBase: null,
    confidenceFactor: null,
    uncertaintyVisibility: null,
    factCheck: { ...EMPTY_FACT_CHECK, claims: [], penalties: [] },
    commsIntegrity: { ...EMPTY_COMMS, dims: [] },
    sharedReality: { ...EMPTY_SHARED, subs: [] },
  };
}

export function emptyLayerReview(): LayerReviewAck {
  return { aiReviewed: false, humanReviewed: false };
}

export function emptyLayerReviews(): LayerReviews {
  return {
    factCheck: emptyLayerReview(),
    commsIntegrity: emptyLayerReview(),
    sharedReality: emptyLayerReview(),
  };
}

export function emptyReview(): ReviewState {
  return {
    aiReviewed: false,
    humanReviewed: false,
    assignedReviewer: null,
    decision: 'pending',
    reviewedAt: null,
    decidedAt: null,
    reviewer: null,
    notes: null,
    layers: emptyLayerReviews(),
  };
}

function normalizeDecisionToken(raw: unknown): string {
  return String(raw ?? 'pending')
    .trim()
    .toLowerCase()
    .replace(/[\s–—-]+/g, '_');
}

/** Map stored / incoming decision strings onto the review-console values. */
export function canonicalReviewDecision(raw: unknown): ReviewDecision {
  const v = normalizeDecisionToken(raw);
  if (v === 'accepted' || v === 'approved' || v === 'approved_with_edits') return 'accepted';
  if (v === 'rejected' || v === 'disapproved') return 'rejected';
  if (
    v === 'on_hold' ||
    v === 'on_hold_for_escalation' ||
    v === 'hold' ||
    v === 'escalation' ||
    v === 'returned'
  ) {
    return 'on_hold';
  }
  return 'pending';
}

export function isAcceptedDecision(raw: unknown): boolean {
  return canonicalReviewDecision(raw) === 'accepted';
}

/** Denormalize review state onto the campaign doc for admin queue / list views. */
export function campaignReviewDenorm(
  review: ReviewState,
  extra?: { trustScore?: number | null }
): Record<string, unknown> {
  const trustScore =
    extra?.trustScore != null && Number.isFinite(Number(extra.trustScore))
      ? Math.round(Number(extra.trustScore))
      : undefined;
  return {
    uuts_review_decision: review.decision,
    uuts_review_reviewer: review.assignedReviewer || review.reviewer || null,
    uuts_review_decided_at: review.decidedAt || null,
    uuts_review_updated_at: review.reviewedAt || null,
    uuts_review_publish_eligible: isAcceptedDecision(review.decision),
    ...(trustScore != null ? { trust_score: trustScore } : {}),
  };
}

export function anyLayerHumanReviewed(review: ReviewState | null | undefined): boolean {
  if (!review) return false;
  if (review.humanReviewed) return true;
  return REVIEW_LAYER_KEYS.some((key) => review.layers?.[key]?.humanReviewed === true);
}

function sanitizeLayerAck(raw: unknown, fallback: LayerReviewAck): LayerReviewAck {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const hasAi = o.aiReviewed != null;
  const hasHuman = o.humanReviewed != null;
  return {
    aiReviewed: hasAi ? Boolean(o.aiReviewed) : fallback.aiReviewed,
    humanReviewed: hasHuman ? Boolean(o.humanReviewed) : fallback.humanReviewed,
  };
}

function sanitizeLayerReviews(
  raw: unknown,
  fallbackGlobal: { aiReviewed: boolean; humanReviewed: boolean }
): LayerReviews {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const inherited: LayerReviewAck = {
    aiReviewed: fallbackGlobal.aiReviewed,
    humanReviewed: fallbackGlobal.humanReviewed,
  };
  return {
    factCheck: sanitizeLayerAck(o.factCheck, inherited),
    commsIntegrity: sanitizeLayerAck(o.commsIntegrity, inherited),
    sharedReality: sanitizeLayerAck(o.sharedReality, inherited),
  };
}

export function bandLabelForScore(score: number | null | undefined): string | null {
  if (score == null || score === ('' as unknown)) return null;
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  if (s >= 90) return 'Gold Standard';
  if (s >= 80) return 'High Trust';
  if (s >= 70) return 'Moderate Trust';
  if (s >= 60) return 'Low Trust';
  return 'Returned';
}

export function computeComposite(
  factCheck: number | null | undefined,
  commsIntegrity: number | null | undefined,
  sharedReality: number | null | undefined
): number | null {
  const fc = Number(factCheck);
  const ci = Number(commsIntegrity);
  const sr = Number(sharedReality);
  if (![fc, ci, sr].every((n) => Number.isFinite(n))) return null;
  return Math.round(
    fc * TRUST_LAYER_WEIGHTS.factCheck +
      ci * TRUST_LAYER_WEIGHTS.commsIntegrity +
      sr * TRUST_LAYER_WEIGHTS.sharedReality
  );
}

/**
 * UUTS Mathematical Framework: final = base × Confidence Factor × Uncertainty Visibility.
 * CF reflects review rigor (0.70 automated pre-screen … 1.00 three agreeing reviewers).
 */
export function applyConfidenceModifiers(
  compositeBase: number | null | undefined,
  confidenceFactor: number,
  uncertaintyVisibility: number
): number | null {
  const base = Number(compositeBase);
  if (!Number.isFinite(base)) return null;
  const adjusted = base * confidenceFactor * uncertaintyVisibility;
  return Math.max(0, Math.min(100, Math.round(adjusted)));
}

function clampScore100(n: unknown): number | null {
  if (n == null || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function finiteOrNull(n: unknown): number | null {
  if (n == null || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function asLayerStatus(raw: unknown): LayerStatus {
  if (raw === 'scored' || raw === 'pending' || raw === 'not_scored') return raw;
  return 'not_scored';
}

function sanitizeFactCheck(raw: unknown): FactCheckLayer {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const score = clampScore100(o.score);
  const status = o.status != null ? asLayerStatus(o.status) : score != null ? 'scored' : 'not_scored';
  let subscores: FactCheckLayer['subscores'] = null;
  if (o.subscores && typeof o.subscores === 'object') {
    const s = o.subscores as Record<string, unknown>;
    subscores = {
      claimAccuracy: Number(s.claimAccuracy) || 0,
      sourceQuality: Number(s.sourceQuality) || 0,
      contextIntegrity: Number(s.contextIntegrity) || 0,
      uncertaintyDisclosure: Number(s.uncertaintyDisclosure) || 0,
    };
  }
  const claims = Array.isArray(o.claims)
    ? o.claims.map((c, i) => {
        const row = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
        return {
          id: String(row.id ?? `C${i + 1}`),
          text: String(row.text ?? ''),
          source: row.source != null ? String(row.source) : null,
          tier: String(row.tier ?? ''),
          verdict: String(row.verdict ?? ''),
          tierBase: finiteOrNull(row.tierBase),
          evidenceWeight: finiteOrNull(row.evidenceWeight),
          consensusFactor: finiteOrNull(row.consensusFactor),
          regionalBonus: finiteOrNull(row.regionalBonus),
          score: finiteOrNull(row.score),
        };
      })
    : [];
  const penalties = Array.isArray(o.penalties)
    ? o.penalties.map((p) => {
        const row = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
        return { type: String(row.type ?? ''), points: Number(row.points) || 0 };
      })
    : [];
  return { status, score, subscores, claims, penalties, claimsMean: finiteOrNull(o.claimsMean) };
}

function sanitizeComms(raw: unknown): CommsIntegrityLayer {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const score = clampScore100(o.score);
  const status = o.status != null ? asLayerStatus(o.status) : score != null ? 'scored' : 'not_scored';
  const dims = Array.isArray(o.dims)
    ? o.dims.map((d) => {
        const row = d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
        return {
          code: String(row.code ?? ''),
          name: String(row.name ?? ''),
          score: Number(row.score) || 0,
          def: row.def != null ? String(row.def) : undefined,
        };
      })
    : [];
  const rawScore = o.raw == null || o.raw === '' ? null : Number(o.raw);
  return {
    status,
    score,
    raw: Number.isFinite(rawScore as number) ? (rawScore as number) : null,
    dims,
    categoryModifier: o.categoryModifier == null ? null : Number(o.categoryModifier),
    crossDimModifier: o.crossDimModifier == null ? null : Number(o.crossDimModifier),
    framePenalty: o.framePenalty == null ? null : Number(o.framePenalty),
    framing: o.framing != null ? String(o.framing) : null,
  };
}

function sanitizeShared(raw: unknown): SharedRealityLayer {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const score = clampScore100(o.score);
  const status = o.status != null ? asLayerStatus(o.status) : score != null ? 'scored' : 'not_scored';
  const subs = Array.isArray(o.subs)
    ? o.subs.map((s) => {
        const row = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
        const elements = Array.isArray(row.elements)
          ? row.elements.map((e) => {
              const el = e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
              return {
                label: String(el.label ?? ''),
                got: Number(el.got) || 0,
                max: Number(el.max) || 0,
              };
            })
          : [];
        return {
          name: String(row.name ?? ''),
          weight: Number(row.weight) || 0,
          score: Number(row.score) || 0,
          max: Number(row.max) || 0,
          def: row.def != null ? String(row.def) : null,
          elements,
        };
      })
    : [];
  return { status, score, subs };
}

export function sanitizeSnapshot(raw: unknown): ScoreSnapshot {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const factCheck = sanitizeFactCheck(o.factCheck);
  const commsIntegrity = sanitizeComms(o.commsIntegrity);
  const sharedReality = sanitizeShared(o.sharedReality);
  const computed = computeComposite(factCheck.score, commsIntegrity.score, sharedReality.score);
  const composite = o.composite != null ? clampScore100(o.composite) : computed;
  return {
    composite: composite ?? computed,
    compositeBase: o.compositeBase != null ? clampScore100(o.compositeBase) : computed,
    confidenceFactor: finiteOrNull(o.confidenceFactor),
    uncertaintyVisibility: finiteOrNull(o.uncertaintyVisibility),
    factCheck,
    commsIntegrity,
    sharedReality,
  };
}

export function sanitizeReview(raw: unknown): ReviewState {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const assignedReviewer =
    o.assignedReviewer != null && String(o.assignedReviewer).trim()
      ? String(o.assignedReviewer).trim()
      : null;
  const reviewerRaw = o.reviewer != null && String(o.reviewer).trim() ? String(o.reviewer).trim() : null;
  const globalAi = o.aiReviewed != null ? Boolean(o.aiReviewed) : false;
  const globalHuman = o.humanReviewed != null ? Boolean(o.humanReviewed) : false;
  const layers = sanitizeLayerReviews(o.layers, { aiReviewed: globalAi, humanReviewed: globalHuman });
  const aiReviewedAll = REVIEW_LAYER_KEYS.every((key) => layers[key].aiReviewed);
  const humanReviewedAll = REVIEW_LAYER_KEYS.every((key) => layers[key].humanReviewed);
  return {
    aiReviewed: o.aiReviewed != null ? globalAi : aiReviewedAll,
    humanReviewed: o.humanReviewed != null ? globalHuman : humanReviewedAll,
    assignedReviewer,
    decision: canonicalReviewDecision(o.decision),
    reviewedAt: o.reviewedAt != null ? String(o.reviewedAt) : null,
    decidedAt: o.decidedAt != null ? String(o.decidedAt) : null,
    reviewer: reviewerRaw || assignedReviewer,
    notes: o.notes != null ? String(o.notes).slice(0, 4000) : null,
    layers,
  };
}

function cloneSnapshot(snap: ScoreSnapshot): ScoreSnapshot {
  return sanitizeSnapshot(snap);
}

function patchLayerScore<T extends { score: number | null; status: LayerStatus }>(
  layer: T,
  score: unknown
): T {
  if (score === undefined) return layer;
  const next = clampScore100(score);
  return {
    ...layer,
    score: next,
    status: next != null ? 'scored' : layer.status,
  };
}

export interface LayerScorePatch {
  factCheck?: number | null;
  commsIntegrity?: number | null;
  sharedReality?: number | null;
}

/**
 * Clone a snapshot and overlay human-adjusted layer scores (0–100).
 * Recomputes compositeBase and, when `humanReviewed`, applies the human CF.
 */
export function applyLayerScores(
  base: ScoreSnapshot,
  scores: LayerScorePatch | null | undefined,
  opts?: { humanReviewed?: boolean }
): ScoreSnapshot {
  const next = cloneSnapshot(base);
  if (scores && typeof scores === 'object') {
    next.factCheck = patchLayerScore(next.factCheck, scores.factCheck);
    next.commsIntegrity = patchLayerScore(next.commsIntegrity, scores.commsIntegrity);
    next.sharedReality = patchLayerScore(next.sharedReality, scores.sharedReality);
  }
  const compositeBase = computeComposite(
    next.factCheck.score,
    next.commsIntegrity.score,
    next.sharedReality.score
  );
  const humanReviewed = opts?.humanReviewed === true;
  const confidenceFactor = humanReviewed
    ? HUMAN_REVIEW_CONFIDENCE_FACTOR
    : next.confidenceFactor ?? null;
  const uncertaintyVisibility = humanReviewed
    ? HUMAN_REVIEW_UNCERTAINTY_VISIBILITY
    : next.uncertaintyVisibility ?? null;
  const composite =
    humanReviewed && compositeBase != null && confidenceFactor != null && uncertaintyVisibility != null
      ? applyConfidenceModifiers(compositeBase, confidenceFactor, uncertaintyVisibility)
      : compositeBase;
  return {
    ...next,
    compositeBase,
    composite: composite ?? compositeBase,
    confidenceFactor,
    uncertaintyVisibility,
  };
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

/** Creator-entered sources from campaign doc (mirrors UI getCampaignSources). */
export function getCampaignSources(campaign: Record<string, unknown> | null | undefined): TrustReportSource[] {
  if (!campaign || typeof campaign !== 'object') return [];
  const raw = campaign.campaign_sources ?? campaign.sources;
  if (raw == null) return [];
  try {
    const lines = Array.isArray(raw)
      ? raw.map((s) => (typeof s === 'string' ? s.trim() : String(s).trim()))
      : typeof raw === 'string'
        ? raw.split('\n').map((s) => s.trim())
        : [];
    return lines
      .filter(Boolean)
      .slice(0, 50)
      .map((line) =>
        isHttpUrl(line) ? { name: line, detail: null, url: line } : { name: line, detail: null, url: null }
      );
  } catch {
    return [];
  }
}

function timestampToIso(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'toDate' in value) {
    try {
      const d = (value as { toDate: () => Date }).toDate();
      return d.toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

/** Prefer human final snapshot when any component is human-reviewed; otherwise AI initial. */
export function effectiveSnapshot(version: TrustReportVersionDoc): ScoreSnapshot {
  if (version.final && anyLayerHumanReviewed(version.review)) {
    return version.final;
  }
  return version.initial;
}

export function buildTrustReportPayload(
  campaignId: string,
  campaign: Record<string, unknown>,
  versionId: string,
  version: TrustReportVersionDoc
): TrustReportPayload {
  const effective = effectiveSnapshot(version);
  const review = version.review || emptyReview();
  return {
    campaign: {
      id: campaignId,
      title: typeof campaign.title === 'string' ? campaign.title : '',
      category: typeof campaign.category === 'string' ? campaign.category : null,
      reviewedAt: review.reviewedAt,
      reviewer: review.reviewer,
    },
    composite: effective.composite,
    band: bandLabelForScore(effective.composite),
    factCheck: effective.factCheck,
    commsIntegrity: effective.commsIntegrity,
    sharedReality: effective.sharedReality,
    sources: getCampaignSources(campaign),
    initial: version.initial,
    final: version.final,
    review,
    version: {
      id: versionId,
      number: version.version,
      status: version.status,
      publishedAt: timestampToIso(version.publishedAt),
      model: version.model,
      provider: version.provider,
    },
  };
}

function metaRef(db: Firestore, campaignId: string) {
  return db.collection(TRUST_REPORTS_COLLECTION).doc(campaignId);
}

function versionsCol(db: Firestore, campaignId: string) {
  return metaRef(db, campaignId).collection(TRUST_REPORT_VERSIONS_SUB);
}

function parseVersionDoc(data: DocumentData | undefined): TrustReportVersionDoc | null {
  if (!data) return null;
  return {
    version: Number(data.version) || 1,
    status: (data.status as VersionStatus) || 'draft',
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
    publishedAt: data.publishedAt ?? null,
    createdBy: data.createdBy != null ? String(data.createdBy) : null,
    model: data.model != null ? String(data.model) : null,
    provider: data.provider != null ? String(data.provider) : null,
    initial: sanitizeSnapshot(data.initial),
    final: data.final == null ? null : sanitizeSnapshot(data.final),
    review: sanitizeReview(data.review),
  };
}

/** Load published report payload, or null if none. */
export async function getPublishedTrustReport(
  db: Firestore,
  campaignId: string,
  campaign: Record<string, unknown>
): Promise<TrustReportPayload | null> {
  const metaSnap = await metaRef(db, campaignId).get();
  if (!metaSnap.exists) return null;
  const publishedVersionId = metaSnap.data()?.publishedVersionId;
  if (!publishedVersionId || typeof publishedVersionId !== 'string') return null;

  const verSnap = await versionsCol(db, campaignId).doc(publishedVersionId).get();
  const version = parseVersionDoc(verSnap.data());
  if (!version || version.status !== 'published') return null;

  return buildTrustReportPayload(campaignId, campaign, verSnap.id, version);
}

/** Load a specific version (admin), or latest draft/published. */
export async function getTrustReportVersion(
  db: Firestore,
  campaignId: string,
  campaign: Record<string, unknown>,
  versionId?: string | null
): Promise<TrustReportPayload | null> {
  const metaSnap = await metaRef(db, campaignId).get();
  if (!metaSnap.exists) return null;
  const meta = metaSnap.data() || {};
  const id =
    (versionId && String(versionId)) ||
    (typeof meta.latestVersionId === 'string' ? meta.latestVersionId : null) ||
    (typeof meta.publishedVersionId === 'string' ? meta.publishedVersionId : null);
  if (!id) return null;
  const verSnap = await versionsCol(db, campaignId).doc(id).get();
  const version = parseVersionDoc(verSnap.data());
  if (!version) return null;
  return buildTrustReportPayload(campaignId, campaign, verSnap.id, version);
}

export async function getLatestTrustReportReview(
  db: Firestore,
  campaignId: string
): Promise<{ versionId: string; review: ReviewState; status: VersionStatus } | null> {
  const metaSnap = await metaRef(db, campaignId).get();
  if (!metaSnap.exists) return null;
  const meta = metaSnap.data() || {};
  const id =
    (typeof meta.latestVersionId === 'string' ? meta.latestVersionId : null) ||
    (typeof meta.publishedVersionId === 'string' ? meta.publishedVersionId : null);
  if (!id) return null;
  const verSnap = await versionsCol(db, campaignId).doc(id).get();
  const version = parseVersionDoc(verSnap.data());
  if (!version) return null;
  return { versionId: verSnap.id, review: version.review || emptyReview(), status: version.status };
}

export interface SaveTrustReportReviewInput {
  /** Overlay 0–100 layer scores onto the current final (or initial) snapshot. */
  layerScores?: LayerScorePatch | null;
  /** Full final snapshot; takes precedence over layerScores when provided. */
  final?: unknown;
  review?: unknown;
  createdBy?: string | null;
}

/**
 * Persist human-adjusted scores + review decision on the latest version (copy-on-write if published).
 */
export async function saveTrustReportReview(
  db: Firestore,
  campaignId: string,
  input: SaveTrustReportReviewInput
): Promise<{
  versionId: string;
  version: number;
  status: VersionStatus;
  created: boolean;
  review: ReviewState;
  final: ScoreSnapshot;
  previousDecision: ReviewDecision;
}> {
  const current = await getTrustReportVersion(db, campaignId, { id: campaignId }, null);
  if (!current) {
    throw Object.assign(new Error('No trust report to review'), { status: 404 });
  }
  const existingReview = sanitizeReview(current.review);
  const incoming = sanitizeReview({
    ...existingReview,
    ...(input.review && typeof input.review === 'object' ? (input.review as object) : {}),
  });
  const nowIso = new Date().toISOString();
  const decisionChanged = incoming.decision !== existingReview.decision;
  const reviewer = incoming.reviewer || incoming.assignedReviewer;
  const review: ReviewState = {
    ...incoming,
    reviewer,
    assignedReviewer: incoming.assignedReviewer || reviewer,
    reviewedAt: nowIso,
    decidedAt:
      incoming.decision === 'pending'
        ? existingReview.decidedAt
        : decisionChanged || !existingReview.decidedAt
          ? nowIso
          : existingReview.decidedAt,
  };

  const base = current.final || current.initial;
  const humanReviewed = anyLayerHumanReviewed(review);
  let final: ScoreSnapshot;
  if (input.final !== undefined && input.final !== null) {
    final = applyLayerScores(sanitizeSnapshot(input.final), null, { humanReviewed });
  } else {
    const scores = input.layerScores ?? {
      factCheck: base.factCheck?.score ?? null,
      commsIntegrity: base.commsIntegrity?.score ?? null,
      sharedReality: base.sharedReality?.score ?? null,
    };
    final = applyLayerScores(base, scores, { humanReviewed });
  }

  const result = await upsertTrustReport(db, campaignId, {
    final,
    review,
    createdBy: input.createdBy ?? reviewer,
    publish: false,
  });
  return {
    ...result,
    review,
    final,
    previousDecision: existingReview.decision,
  };
}

export interface UpsertTrustReportInput {
  /** AI layer scores (required on create / refresh). */
  initial?: unknown;
  /** Human-adjusted layer scores. */
  final?: unknown | null;
  review?: unknown;
  /** Who wrote this (optional display / audit). */
  createdBy?: string | null;
  /** Model id used for AI scoring (optional; stored on new versions). */
  model?: string | null;
  /** Provider used for AI scoring (optional; stored on new versions). */
  provider?: string | null;
  /**
   * If true, archive published (if any) is NOT done here — create a new draft version
   * from `initial` (refresh). Previous published stays published.
   */
  refresh?: boolean;
  /** When true, also mark this version published after write (first publish path). */
  publish?: boolean;
}

/**
 * Create or update trust report scores.
 * - Default: upsert latest draft (or create v1).
 * - refresh: always create a new draft version; leave published pointer alone.
 * - publish: after write, set this version published and archive prior published.
 */
export async function upsertTrustReport(
  db: Firestore,
  campaignId: string,
  input: UpsertTrustReportInput
): Promise<{ versionId: string; version: number; status: VersionStatus; created: boolean }> {
  const meta = metaRef(db, campaignId);
  const versions = versionsCol(db, campaignId);

  return db.runTransaction(async (tx) => {
    const metaSnap = await tx.get(meta);
    const metaData = metaSnap.exists ? metaSnap.data() || {} : {};
    const latestVersionId =
      typeof metaData.latestVersionId === 'string' ? metaData.latestVersionId : null;
    const publishedVersionId =
      typeof metaData.publishedVersionId === 'string' ? metaData.publishedVersionId : null;

    const reviewPatch = input.review !== undefined ? sanitizeReview(input.review) : null;
    const initialPatch = input.initial !== undefined ? sanitizeSnapshot(input.initial) : null;
    const finalProvided = input.final !== undefined;
    const finalPatch =
      input.final === null ? null : input.final !== undefined ? sanitizeSnapshot(input.final) : undefined;

    const priorVersionNumber = Number(metaData.latestVersionNumber) || 0;

    // Create first version, or refresh → always new draft (published pointer unchanged unless publish)
    if (input.refresh || !metaSnap.exists || !latestVersionId) {
      if (!initialPatch && !metaSnap.exists) {
        throw Object.assign(new Error('initial scores are required to create a trust report'), {
          status: 400,
        });
      }

      let baseInitial = initialPatch || emptySnapshot();
      let baseFinal: ScoreSnapshot | null = finalProvided ? (finalPatch as ScoreSnapshot | null) : null;
      let baseReview = reviewPatch || emptyReview();

      if (input.refresh && latestVersionId && !initialPatch) {
        const prevSnap = await tx.get(versions.doc(latestVersionId));
        const prev = parseVersionDoc(prevSnap.data());
        if (prev) {
          baseInitial = prev.initial;
          baseFinal = finalProvided ? (finalPatch as ScoreSnapshot | null) : null;
          baseReview = {
            ...(reviewPatch || emptyReview()),
            aiReviewed: false,
            humanReviewed: false,
            decision: 'pending',
            reviewedAt: null,
            decidedAt: null,
            layers: emptyLayerReviews(),
          };
        }
      }

      if (initialPatch) {
        const aiReviewed = reviewPatch?.aiReviewed ?? true;
        const layers = reviewPatch?.layers ?? {
          factCheck: { aiReviewed, humanReviewed: false },
          commsIntegrity: { aiReviewed, humanReviewed: false },
          sharedReality: { aiReviewed, humanReviewed: false },
        };
        baseReview = {
          ...baseReview,
          aiReviewed,
          layers,
        };
      }

      const newRef = versions.doc();
      const status: VersionStatus = input.publish ? 'published' : 'draft';
      const versionNum = priorVersionNumber + 1;

      tx.set(newRef, {
        version: versionNum,
        status,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        publishedAt: input.publish ? FieldValue.serverTimestamp() : null,
        createdBy: input.createdBy ?? null,
        model: input.model ?? null,
        provider: input.provider ?? null,
        initial: baseInitial,
        final: baseFinal,
        review: baseReview,
      });

      const metaUpdate: Record<string, unknown> = {
        campaignId,
        latestVersionId: newRef.id,
        latestVersionNumber: versionNum,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (input.publish) {
        if (publishedVersionId && publishedVersionId !== newRef.id) {
          tx.update(versions.doc(publishedVersionId), {
            status: 'archived',
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        metaUpdate.publishedVersionId = newRef.id;
      } else if (!metaSnap.exists) {
        metaUpdate.publishedVersionId = null;
      }
      if (metaSnap.exists) tx.set(meta, metaUpdate, { merge: true });
      else tx.set(meta, metaUpdate);

      return { versionId: newRef.id, version: versionNum, status, created: true };
    }

    // Update existing latest draft (or published copy-on-write if latest is published and not publishing in place)
    const latestRef = versions.doc(latestVersionId);
    const latestSnap = await tx.get(latestRef);
    const existing = parseVersionDoc(latestSnap.data());
    if (!existing) {
      throw Object.assign(new Error('Latest trust report version missing'), { status: 500 });
    }

    // Never mutate a published version in place — clone to a new draft first
    if (existing.status === 'published' && !input.publish) {
      const versionNum = (Number(metaData.latestVersionNumber) || existing.version) + 1;
      const newRef = versions.doc();
      const mergedInitial = initialPatch || existing.initial;
      const mergedFinal =
        finalProvided ? (finalPatch as ScoreSnapshot | null) : existing.final;
      const mergedReview = reviewPatch
        ? { ...existing.review, ...reviewPatch }
        : existing.review;
      tx.set(newRef, {
        version: versionNum,
        status: 'draft',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        publishedAt: null,
        createdBy: input.createdBy ?? existing.createdBy,
        model: input.model !== undefined ? input.model : existing.model,
        provider: input.provider !== undefined ? input.provider : existing.provider,
        initial: mergedInitial,
        final: mergedFinal,
        review: mergedReview,
      });
      tx.set(
        meta,
        {
          campaignId,
          latestVersionId: newRef.id,
          latestVersionNumber: versionNum,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return { versionId: newRef.id, version: versionNum, status: 'draft' as VersionStatus, created: true };
    }

    const update: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (initialPatch) update.initial = initialPatch;
    if (finalProvided) update.final = finalPatch;
    if (reviewPatch) {
      update.review = { ...existing.review, ...reviewPatch };
    }
    if (input.createdBy !== undefined) update.createdBy = input.createdBy;
    if (input.model !== undefined) update.model = input.model;
    if (input.provider !== undefined) update.provider = input.provider;

    if (input.publish) {
      update.status = 'published';
      update.publishedAt = FieldValue.serverTimestamp();
      if (publishedVersionId && publishedVersionId !== latestVersionId) {
        tx.update(versions.doc(publishedVersionId), {
          status: 'archived',
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      tx.set(
        meta,
        {
          publishedVersionId: latestVersionId,
          latestVersionId,
          latestVersionNumber: existing.version,
          updatedAt: FieldValue.serverTimestamp(),
          campaignId,
        },
        { merge: true }
      );
    }

    tx.update(latestRef, update);
    return {
      versionId: latestVersionId,
      version: existing.version,
      status: input.publish ? ('published' as VersionStatus) : existing.status,
      created: false,
    };
  });
}

/** Publish the latest draft (or a given version id). Archives previous published. */
export async function publishTrustReport(
  db: Firestore,
  campaignId: string,
  versionId?: string | null
): Promise<{ versionId: string; version: number }> {
  const meta = metaRef(db, campaignId);
  const versions = versionsCol(db, campaignId);

  return db.runTransaction(async (tx) => {
    const metaSnap = await tx.get(meta);
    if (!metaSnap.exists) {
      throw Object.assign(new Error('No trust report for campaign'), { status: 404 });
    }
    const metaData = metaSnap.data() || {};
    const targetId =
      (versionId && String(versionId)) ||
      (typeof metaData.latestVersionId === 'string' ? metaData.latestVersionId : null);
    if (!targetId) {
      throw Object.assign(new Error('No version to publish'), { status: 404 });
    }
    const verRef = versions.doc(targetId);
    const verSnap = await tx.get(verRef);
    if (!verSnap.exists) {
      throw Object.assign(new Error('Version not found'), { status: 404 });
    }
    const version = parseVersionDoc(verSnap.data());
    if (!isAcceptedDecision(version?.review?.decision)) {
      throw Object.assign(
        new Error('Trust report can only be published after an Accepted review decision'),
        { status: 409 }
      );
    }
    const versionNum = Number(verSnap.data()?.version) || 1;
    const prevPublished =
      typeof metaData.publishedVersionId === 'string' ? metaData.publishedVersionId : null;

    if (prevPublished && prevPublished !== targetId) {
      tx.update(versions.doc(prevPublished), {
        status: 'archived',
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(verRef, {
      status: 'published',
      publishedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      meta,
      {
        publishedVersionId: targetId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { versionId: targetId, version: versionNum };
  });
}

export async function listTrustReportVersions(
  db: Firestore,
  campaignId: string
): Promise<
  Array<{
    id: string;
    version: number;
    status: VersionStatus;
    createdAt: string | null;
    publishedAt: string | null;
    createdBy: string | null;
    model: string | null;
    provider: string | null;
    review: ReviewState;
    compositeInitial: number | null;
    compositeFinal: number | null;
  }>
> {
  const snap = await versionsCol(db, campaignId).orderBy('version', 'desc').get();
  return snap.docs.map((doc) => {
    const v = parseVersionDoc(doc.data());
    return {
      id: doc.id,
      version: v?.version ?? 0,
      status: v?.status ?? 'draft',
      createdAt: timestampToIso(v?.createdAt),
      publishedAt: timestampToIso(v?.publishedAt),
      createdBy: v?.createdBy ?? null,
      model: v?.model ?? null,
      provider: v?.provider ?? null,
      review: v?.review ?? emptyReview(),
      compositeInitial: v?.initial?.composite ?? null,
      compositeFinal: v?.final?.composite ?? null,
    };
  });
}
