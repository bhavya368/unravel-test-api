/**
 * One-time Langfuse project setup for UUTS evaluation.
 *
 * Creates score configs, the disagreements annotation queue, the golden dataset,
 * and upserts the `uuts-prescreen` prompt (from Firestore or the hardcoded fallback).
 *
 * Usage (from unravel-api):
 *   npx ts-node -r dotenv/config --transpile-only scripts/langfuse/setupUutsEval.ts
 *
 * Requires LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL.
 * Optional: GOOGLE_APPLICATION_CREDENTIALS / Firebase admin for Firestore prompt pull.
 */
import dotenv from 'dotenv';
dotenv.config();

import { LangfuseClient } from '@langfuse/client';
import {
  UUTS_ANNOTATION_QUEUE_NAME,
  UUTS_CODE_EVALUATOR_SNIPPET,
  UUTS_GOLDEN_DATASET_NAME,
  UUTS_LANGFUSE_PROMPT_NAME,
  UUTS_SCORE_NAMES,
} from '../../src/uutsLangfuseEval';

const BAND_CATEGORIES = [
  { label: 'Gold Standard', value: 5 },
  { label: 'High Trust', value: 4 },
  { label: 'Moderate Trust', value: 3 },
  { label: 'Low Trust', value: 2 },
  { label: 'Returned', value: 1 },
  { label: 'Unknown', value: 0 },
];

async function ensureScoreConfigs(lf: LangfuseClient): Promise<Record<string, string>> {
  const existing = await lf.api.scoreConfigs.get({ limit: 100 });
  const byName = new Map(existing.data.map((c) => [c.name, c.id]));
  const ids: Record<string, string> = {};

  const ensure = async (
    name: string,
    dataType: 'NUMERIC' | 'CATEGORICAL' | 'BOOLEAN',
    extra?: { minValue?: number; maxValue?: number; categories?: typeof BAND_CATEGORIES; description?: string }
  ) => {
    const found = byName.get(name);
    if (found) {
      ids[name] = found;
      console.log(`  score config exists: ${name} (${found})`);
      return;
    }
    const created = await lf.api.scoreConfigs.create({
      name,
      dataType,
      minValue: extra?.minValue,
      maxValue: extra?.maxValue,
      categories: extra?.categories,
      description: extra?.description,
    });
    ids[name] = created.id;
    byName.set(name, created.id);
    console.log(`  score config created: ${name} (${created.id})`);
  };

  await ensure(UUTS_SCORE_NAMES.composite, 'NUMERIC', {
    minValue: 0,
    maxValue: 100,
    description: 'UUTS weighted composite after confidence modifiers',
  });
  await ensure(UUTS_SCORE_NAMES.compositeBase, 'NUMERIC', { minValue: 0, maxValue: 100 });
  await ensure(UUTS_SCORE_NAMES.factCheck, 'NUMERIC', { minValue: 0, maxValue: 100 });
  await ensure(UUTS_SCORE_NAMES.commsIntegrity, 'NUMERIC', { minValue: 0, maxValue: 100 });
  await ensure(UUTS_SCORE_NAMES.sharedReality, 'NUMERIC', { minValue: 0, maxValue: 100 });
  await ensure(UUTS_SCORE_NAMES.confidenceFactor, 'NUMERIC', { minValue: 0.7, maxValue: 1 });
  await ensure(UUTS_SCORE_NAMES.band, 'CATEGORICAL', { categories: BAND_CATEGORIES });
  await ensure(UUTS_SCORE_NAMES.meetsThreshold, 'BOOLEAN');
  await ensure(UUTS_SCORE_NAMES.schemaValid, 'BOOLEAN');
  await ensure(UUTS_SCORE_NAMES.jsonParsed, 'BOOLEAN');
  await ensure(UUTS_SCORE_NAMES.layersPresent, 'BOOLEAN');
  await ensure(UUTS_SCORE_NAMES.compositeConsistent, 'BOOLEAN');
  await ensure(UUTS_SCORE_NAMES.humanAgree, 'BOOLEAN', {
    description: 'Human reviewer agrees with AI composite band',
  });
  await ensure(UUTS_SCORE_NAMES.modelDelta, 'NUMERIC', {
    minValue: 0,
    maxValue: 100,
    description: 'Absolute composite delta between two model runs',
  });

  return ids;
}

async function ensureAnnotationQueue(
  lf: LangfuseClient,
  scoreConfigIds: string[]
): Promise<string> {
  const listed = await lf.api.annotationQueues.listQueues({ limit: 100 });
  const existing = listed.data.find((q) => q.name === UUTS_ANNOTATION_QUEUE_NAME);
  if (existing) {
    console.log(`  annotation queue exists: ${existing.name} (${existing.id})`);
    return existing.id;
  }
  const created = await lf.api.annotationQueues.createQueue({
    name: UUTS_ANNOTATION_QUEUE_NAME,
    description:
      'UUTS runs where AI vs human (or model A vs B) composite delta ≥ threshold — review and score.',
    scoreConfigIds,
  });
  console.log(`  annotation queue created: ${created.name} (${created.id})`);
  return created.id;
}

async function ensureDataset(lf: LangfuseClient): Promise<void> {
  try {
    await lf.api.datasets.get(UUTS_GOLDEN_DATASET_NAME);
    console.log(`  dataset exists: ${UUTS_GOLDEN_DATASET_NAME}`);
  } catch {
    await lf.api.datasets.create({
      name: UUTS_GOLDEN_DATASET_NAME,
      description:
        'Golden UUTS campaigns with human/expected composites for Gemini vs Claude experiments and judge calibration.',
      metadata: {
        compositeWeighting: 'factCheck 0.45 · comms 0.30 · sharedReality 0.25',
      },
    });
    console.log(`  dataset created: ${UUTS_GOLDEN_DATASET_NAME}`);
  }
}

async function ensurePrompt(lf: LangfuseClient): Promise<void> {
  let template =
    'You are the UUTS Pre-screening skill for Unravel.\n\n' +
    'Score the campaign across Fact-Check, Communications Integrity, and Shared Reality.\n' +
    'Return ONLY valid JSON.\n\n' +
    'Campaign to evaluate:\n---\n{{campaign_content}}\n---\n';

  try {
    const { initializeApp, applicationDefault, getApps, getApp } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    if (!getApps().length) {
      initializeApp({
        credential: applicationDefault(),
        projectId: process.env.GOOGLE_CLOUD_PROJECT || 'unravelreserchagent',
      });
    }
    const db = getFirestore(getApp(), process.env.FIRESTORE_DATABASE_ID || 'unravel');
    const snap = await db
      .collection('ai_prompts')
      .doc(process.env.AI_PROMPTS_DOC_ID || 'ucZnWEWd4t1f32H9f9Tj')
      .get();
    const fromFs = snap.exists ? snap.data()?.uuts_prescreen : null;
    if (typeof fromFs === 'string' && fromFs.trim()) {
      template = fromFs.includes('{{campaign_content}}')
        ? fromFs
        : `${fromFs.trim()}\n\nCampaign to evaluate:\n---\n{{campaign_content}}\n---\n`;
      console.log('  prompt body loaded from Firestore ai_prompts');
    }
  } catch (err) {
    console.warn('  Firestore prompt pull skipped:', (err as Error).message || err);
    console.warn(
      '  Using bootstrap template — paste the full UUTS rubric in Langfuse UI and re-label production.'
    );
  }

  try {
    const existing = await lf.prompt.get(UUTS_LANGFUSE_PROMPT_NAME, {
      type: 'text',
      label: 'production',
    });
    console.log(
      `  prompt exists: ${UUTS_LANGFUSE_PROMPT_NAME} v${existing.version} (production) — not overwriting`
    );
  } catch {
    const created = await lf.prompt.create({
      name: UUTS_LANGFUSE_PROMPT_NAME,
      type: 'text',
      prompt: template,
      labels: ['production'],
    });
    console.log(`  prompt created: ${UUTS_LANGFUSE_PROMPT_NAME} v${created.version} → production`);
  }
}

async function main() {
  const publicKey = (process.env.LANGFUSE_PUBLIC_KEY || '').trim();
  const secretKey = (process.env.LANGFUSE_SECRET_KEY || '').trim();
  if (!publicKey || !secretKey) {
    throw new Error('Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');
  }
  const baseUrl = (process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com').trim();
  const lf = new LangfuseClient({ publicKey, secretKey, baseUrl });

  console.log('1) Score configs');
  const configIds = await ensureScoreConfigs(lf);

  console.log('2) Annotation queue');
  const queueId = await ensureAnnotationQueue(lf, [
    configIds[UUTS_SCORE_NAMES.humanAgree],
    configIds[UUTS_SCORE_NAMES.composite],
    configIds[UUTS_SCORE_NAMES.band],
  ].filter(Boolean));

  console.log('3) Golden dataset');
  await ensureDataset(lf);

  console.log('4) Prompt');
  await ensurePrompt(lf);

  console.log('\n=== Done ===');
  console.log(`Add to .env / Cloud Run:`);
  console.log(`  UUTS_LANGFUSE_ANNOTATION_QUEUE_ID=${queueId}`);
  console.log(`  UUTS_PROMPT_SOURCE=auto`);
  console.log(`  UUTS_LANGFUSE_PROMPT_LABEL=production`);
  console.log(`\nNext:`);
  console.log(`  npx ts-node -r dotenv/config --transpile-only scripts/langfuse/seedUutsDataset.ts`);
  console.log(`  npx ts-node -r dotenv/config --transpile-only scripts/langfuse/runUutsExperiment.ts --model gemini`);
  console.log(`\nPaste this TypeScript into Langfuse → Evaluators → Code evaluator`);
  console.log(`(target observations named prescreen-uuts, tag uuts-prescreen):\n`);
  console.log(UUTS_CODE_EVALUATOR_SNIPPET);

  await lf.flush();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
