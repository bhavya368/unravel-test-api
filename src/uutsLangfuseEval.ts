/**
 * UUTS ↔ Langfuse evaluation helpers.
 *
 * Score names, schema-health checks, prompt loading, annotation-queue enqueue,
 * and dataset/experiment constants used by production tracing and offline scripts.
 */
import type { ScoreSnapshot } from './trustReport';
import { bandLabelForScore } from './trustReport';
import { getLangfuseClient, metaStr } from './langfuseInstrumentation';

/** Stable Langfuse prompt name for the UUTS pre-screen rubric. */
export const UUTS_LANGFUSE_PROMPT_NAME = 'uuts-prescreen';

/** Golden dataset used for Gemini vs Claude / prompt experiments. */
export const UUTS_GOLDEN_DATASET_NAME = 'uuts-golden-campaigns';

/** Annotation queue for human review of disputed UUTS runs. */
export const UUTS_ANNOTATION_QUEUE_NAME = 'uuts-disagreements';

/** Absolute composite delta (AI vs human, or model A vs B) that triggers the queue. */
export const UUTS_DISAGREEMENT_THRESHOLD = 10;

export const UUTS_SCORE_NAMES = {
  composite: 'uuts-composite',
  compositeBase: 'uuts-composite-base',
  factCheck: 'uuts-fact-check',
  commsIntegrity: 'uuts-comms-integrity',
  sharedReality: 'uuts-shared-reality',
  confidenceFactor: 'uuts-confidence-factor',
  band: 'uuts-band',
  meetsThreshold: 'uuts-meets-threshold',
  schemaValid: 'uuts-schema-valid',
  jsonParsed: 'uuts-json-parsed',
  layersPresent: 'uuts-layers-present',
  compositeConsistent: 'uuts-composite-consistent',
  humanAgree: 'uuts-human-agree',
  modelDelta: 'uuts-model-delta',
} as const;

export type UutsPromptSource = {
  template: string;
  source: 'langfuse' | 'firestore' | 'fallback';
  promptName?: string;
  promptVersion?: number;
  promptLabel?: string;
};

/** Minimum publishable UUTS band floor (matches platform “Returned” cut). */
export function meetsUutsThreshold(composite: number | null | undefined): boolean {
  return typeof composite === 'number' && Number.isFinite(composite) && composite >= 60;
}

export type UutsSchemaHealth = {
  jsonParsed: boolean;
  layersPresent: boolean;
  compositeConsistent: boolean;
  schemaValid: boolean;
  comments: string[];
};

/**
 * Deterministic checks on a mapped ScoreSnapshot (or failure state).
 * Used both as in-process scores and as the reference for Langfuse UI code evaluators.
 */
export function evaluateUutsSchemaHealth(
  snapshot: ScoreSnapshot | null,
  opts?: { jsonParsed?: boolean; parseError?: string }
): UutsSchemaHealth {
  const comments: string[] = [];
  const jsonParsed = opts?.jsonParsed !== false && !opts?.parseError;
  if (!jsonParsed) {
    comments.push(opts?.parseError || 'JSON parse failed');
  }

  if (!snapshot) {
    return {
      jsonParsed,
      layersPresent: false,
      compositeConsistent: false,
      schemaValid: false,
      comments: comments.length ? comments : ['No mapped snapshot'],
    };
  }

  const fc = snapshot.factCheck?.score;
  const ci = snapshot.commsIntegrity?.score;
  const sr = snapshot.sharedReality?.score;
  const layersPresent =
    typeof fc === 'number' &&
    Number.isFinite(fc) &&
    typeof ci === 'number' &&
    Number.isFinite(ci) &&
    typeof sr === 'number' &&
    Number.isFinite(sr);

  if (!layersPresent) comments.push('One or more layer scores missing');

  const inRange = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
  if (layersPresent) {
    if (!inRange(fc) || !inRange(ci) || !inRange(sr)) {
      comments.push('Layer score out of 0–100');
    }
  }

  let compositeConsistent = false;
  if (layersPresent && typeof snapshot.compositeBase === 'number') {
    const expected = Math.round(fc! * 0.45 + ci! * 0.3 + sr! * 0.25);
    compositeConsistent = Math.abs(expected - snapshot.compositeBase) <= 1;
    if (!compositeConsistent) {
      comments.push(`compositeBase ${snapshot.compositeBase} ≠ weighted layers ${expected}`);
    }
  } else if (layersPresent) {
    comments.push('compositeBase missing');
  }

  const schemaValid =
    jsonParsed &&
    layersPresent &&
    inRange(fc) &&
    inRange(ci) &&
    inRange(sr) &&
    inRange(snapshot.composite) &&
    compositeConsistent;

  return { jsonParsed, layersPresent, compositeConsistent, schemaValid, comments };
}

/** Attach UUTS numeric/categorical/boolean scores to the active generation. */
export function scoreActiveUutsRun(
  snapshot: ScoreSnapshot,
  health: UutsSchemaHealth,
  extras?: { promptVersion?: number; promptName?: string }
): void {
  const lf = getLangfuseClient();
  if (!lf) return;

  const comment = health.comments.length ? health.comments.join('; ') : undefined;
  const band = bandLabelForScore(snapshot.composite) || 'Unknown';

  const numeric = (
    name: string,
    value: number | null | undefined,
    dataType: 'NUMERIC' | 'BOOLEAN' = 'NUMERIC'
  ) => {
    if (value == null || !Number.isFinite(Number(value))) return;
    lf.score.activeObservation({
      name,
      value: Number(value),
      dataType,
      comment,
      metadata: {
        promptName: extras?.promptName ? metaStr(extras.promptName) : '',
        promptVersion: extras?.promptVersion != null ? String(extras.promptVersion) : '',
      },
    });
  };

  numeric(UUTS_SCORE_NAMES.composite, snapshot.composite);
  numeric(UUTS_SCORE_NAMES.compositeBase, snapshot.compositeBase ?? null);
  numeric(UUTS_SCORE_NAMES.factCheck, snapshot.factCheck?.score ?? null);
  numeric(UUTS_SCORE_NAMES.commsIntegrity, snapshot.commsIntegrity?.score ?? null);
  numeric(UUTS_SCORE_NAMES.sharedReality, snapshot.sharedReality?.score ?? null);
  numeric(UUTS_SCORE_NAMES.confidenceFactor, snapshot.confidenceFactor ?? null);

  lf.score.activeObservation({
    name: UUTS_SCORE_NAMES.band,
    value: band,
    dataType: 'CATEGORICAL',
  });

  lf.score.activeObservation({
    name: UUTS_SCORE_NAMES.meetsThreshold,
    value: meetsUutsThreshold(snapshot.composite) ? 1 : 0,
    dataType: 'BOOLEAN',
  });

  lf.score.activeObservation({
    name: UUTS_SCORE_NAMES.jsonParsed,
    value: health.jsonParsed ? 1 : 0,
    dataType: 'BOOLEAN',
    comment,
  });
  lf.score.activeObservation({
    name: UUTS_SCORE_NAMES.layersPresent,
    value: health.layersPresent ? 1 : 0,
    dataType: 'BOOLEAN',
    comment,
  });
  lf.score.activeObservation({
    name: UUTS_SCORE_NAMES.compositeConsistent,
    value: health.compositeConsistent ? 1 : 0,
    dataType: 'BOOLEAN',
    comment,
  });
  lf.score.activeObservation({
    name: UUTS_SCORE_NAMES.schemaValid,
    value: health.schemaValid ? 1 : 0,
    dataType: 'BOOLEAN',
    comment,
  });
}

/** Score a failed parse / empty generation on the active observation. */
export function scoreActiveUutsFailure(parseError: string): void {
  const lf = getLangfuseClient();
  if (!lf) return;
  const health = evaluateUutsSchemaHealth(null, { jsonParsed: false, parseError });
  for (const [name, ok] of [
    [UUTS_SCORE_NAMES.jsonParsed, health.jsonParsed],
    [UUTS_SCORE_NAMES.layersPresent, health.layersPresent],
    [UUTS_SCORE_NAMES.compositeConsistent, health.compositeConsistent],
    [UUTS_SCORE_NAMES.schemaValid, health.schemaValid],
  ] as const) {
    lf.score.activeObservation({
      name,
      value: ok ? 1 : 0,
      dataType: 'BOOLEAN',
      comment: parseError.slice(0, 500),
    });
  }
}

/**
 * Load UUTS prompt template.
 * Order when source=auto (default): Langfuse production → Firestore → hardcoded fallback.
 */
export async function loadUutsPromptTemplate(opts: {
  firestoreLoader: () => Promise<string>;
  fallback: string;
  label?: string;
}): Promise<UutsPromptSource> {
  const mode = (process.env.UUTS_PROMPT_SOURCE || 'auto').trim().toLowerCase();
  const label = opts.label || process.env.UUTS_LANGFUSE_PROMPT_LABEL || 'production';

  const tryLangfuse = async (): Promise<UutsPromptSource | null> => {
    const lf = getLangfuseClient();
    if (!lf) return null;
    try {
      const prompt = await lf.prompt.get(UUTS_LANGFUSE_PROMPT_NAME, {
        label,
        type: 'text',
      });
      const raw = (prompt as { prompt?: unknown }).prompt;
      const compiled =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? (raw as Array<{ content?: string }>).map((m) => m.content || '').join('\n\n')
            : '';
      if (!compiled.trim()) return null;
      return {
        template: compiled,
        source: 'langfuse',
        promptName: UUTS_LANGFUSE_PROMPT_NAME,
        promptVersion: prompt.version,
        promptLabel: label,
      };
    } catch (err) {
      console.warn('[UUTS] Langfuse prompt fetch failed; falling back:', err);
      return null;
    }
  };

  if (mode === 'langfuse') {
    const fromLf = await tryLangfuse();
    if (fromLf) return fromLf;
    return { template: opts.fallback, source: 'fallback' };
  }

  if (mode === 'firestore') {
    const template = await opts.firestoreLoader();
    return { template, source: template === opts.fallback ? 'fallback' : 'firestore' };
  }

  // auto
  const fromLf = await tryLangfuse();
  if (fromLf) return fromLf;
  const template = await opts.firestoreLoader();
  return { template, source: template === opts.fallback ? 'fallback' : 'firestore' };
}

export type DatasetItemShape = {
  input: {
    campaignId: string;
    title?: string;
    category?: string;
    campaignContent: string;
  };
  expectedOutput: {
    composite: number;
    factCheck?: number;
    commsIntegrity?: number;
    sharedReality?: number;
    band?: string;
    meetsThreshold?: boolean;
    source?: string;
  };
  metadata?: Record<string, string>;
};

/** Absolute delta between two composites for disagreement detection. */
export function compositeDelta(a: number | null | undefined, b: number | null | undefined): number | null {
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b);
}

/**
 * Enqueue a trace into the UUTS disagreements annotation queue when delta exceeds threshold.
 * No-ops if Langfuse is disabled or the queue id is unknown (run setup script first).
 */
export async function enqueueUutsDisagreement(opts: {
  traceId: string;
  observationId?: string;
  delta: number;
  reason: string;
}): Promise<boolean> {
  const lf = getLangfuseClient();
  if (!lf) return false;
  const queueId = (process.env.UUTS_LANGFUSE_ANNOTATION_QUEUE_ID || '').trim();
  if (!queueId) {
    console.warn(
      '[UUTS] UUTS_LANGFUSE_ANNOTATION_QUEUE_ID unset — run scripts/langfuse/setupUutsEval.ts'
    );
    return false;
  }
  if (opts.delta < UUTS_DISAGREEMENT_THRESHOLD) return false;

  try {
    await lf.api.annotationQueues.createQueueItem(queueId, {
      objectId: opts.traceId,
      objectType: 'TRACE',
    });
    console.log(
      `[UUTS] Enqueued disagreement (Δ=${opts.delta}) to annotation queue: ${opts.reason}`
    );
    return true;
  } catch (err) {
    console.warn('[UUTS] Failed to enqueue annotation queue item:', err);
    return false;
  }
}

/**
 * TypeScript snippet for Langfuse UI code evaluators (observation target: name=prescreen-uuts).
 * Paste into Evaluators → Code evaluator. Keep in sync with evaluateUutsSchemaHealth.
 */
export const UUTS_CODE_EVALUATOR_SNIPPET = `
function evaluate({ observation: { output } }) {
  const comments = [];
  const out = output && typeof output === "object" ? output : null;
  const jsonParsed = !!(out && (out.composite != null || out.raw));
  if (!jsonParsed) comments.push("Missing structured output");

  // Live traces store truncated raw + composite; full layer scores are on score objects.
  // Treat presence of composite as layers-emitted signal for online monitoring.
  const layersPresent = !!(out && typeof out.composite === "number");
  const compositeConsistent =
    typeof out?.composite === "number" &&
    out.composite >= 0 &&
    out.composite <= 100;
  const schemaValid = jsonParsed && layersPresent && compositeConsistent;

  const bool = (name, value, comment) => ({
    name,
    value: !!value,
    dataType: "BOOLEAN",
    comment: comment || comments.join("; ") || undefined,
  });

  return {
    scores: [
      bool("uuts-json-parsed", jsonParsed),
      bool("uuts-layers-present", layersPresent),
      bool("uuts-composite-consistent", compositeConsistent),
      bool("uuts-schema-valid", schemaValid),
    ],
  };
}
`.trim();
