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
export type ReviewDecision =
  | 'pending'
  | 'approved'
  | 'approved_with_edits'
  | 'returned'
  | 'rejected'
  | null;

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

export interface ReviewState {
  aiReviewed: boolean;
  humanReviewed: boolean;
  assignedReviewer: string | null;
  decision: ReviewDecision;
  reviewedAt: string | null;
  reviewer: string | null;
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

export function emptyReview(): ReviewState {
  return {
    aiReviewed: false,
    humanReviewed: false,
    assignedReviewer: null,
    decision: 'pending',
    reviewedAt: null,
    reviewer: null,
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
  const decisionRaw = o.decision == null ? 'pending' : String(o.decision);
  const allowed: ReviewDecision[] = [
    'pending',
    'approved',
    'approved_with_edits',
    'returned',
    'rejected',
  ];
  const decision = (allowed.includes(decisionRaw as ReviewDecision)
    ? decisionRaw
    : 'pending') as ReviewDecision;
  return {
    aiReviewed: Boolean(o.aiReviewed),
    humanReviewed: Boolean(o.humanReviewed),
    assignedReviewer: o.assignedReviewer != null ? String(o.assignedReviewer) : null,
    decision,
    reviewedAt: o.reviewedAt != null ? String(o.reviewedAt) : null,
    reviewer: o.reviewer != null ? String(o.reviewer) : null,
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

/** Prefer human final snapshot when humanReviewed; otherwise AI initial. */
export function effectiveSnapshot(version: TrustReportVersionDoc): ScoreSnapshot {
  if (version.review?.humanReviewed && version.final) {
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
          };
        }
      }

      if (initialPatch) {
        baseReview = {
          ...baseReview,
          aiReviewed: reviewPatch?.aiReviewed ?? true,
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
