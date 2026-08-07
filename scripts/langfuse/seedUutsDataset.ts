/**
 * Seed the Langfuse `uuts-golden-campaigns` dataset from Firestore campaigns
 * that already have a UUTS composite (published or pre-screen).
 *
 * Usage:
 *   npx ts-node -r dotenv/config --transpile-only scripts/langfuse/seedUutsDataset.ts
 *   CAMPAIGN_IDS=id1,id2 LIMIT=20 npx ts-node ... scripts/langfuse/seedUutsDataset.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { initializeApp, applicationDefault, getApps, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { LangfuseClient } from '@langfuse/client';
import { bandLabelForScore } from '../../src/trustReport';
import { buildCampaignContent } from '../../src/uutsPrescreen';
import {
  meetsUutsThreshold,
  UUTS_GOLDEN_DATASET_NAME,
} from '../../src/uutsLangfuseEval';

async function main() {
  const publicKey = (process.env.LANGFUSE_PUBLIC_KEY || '').trim();
  const secretKey = (process.env.LANGFUSE_SECRET_KEY || '').trim();
  if (!publicKey || !secretKey) throw new Error('Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');

  if (!getApps().length) {
    initializeApp({
      credential: applicationDefault(),
      projectId: process.env.GOOGLE_CLOUD_PROJECT || 'unravelreserchagent',
    });
  }
  const db = getFirestore(getApp(), process.env.FIRESTORE_DATABASE_ID || 'unravel');

  const lf = new LangfuseClient({
    publicKey,
    secretKey,
    baseUrl: (process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com').trim(),
  });

  // Ensure dataset exists
  try {
    await lf.api.datasets.get(UUTS_GOLDEN_DATASET_NAME);
  } catch {
    await lf.api.datasets.create({
      name: UUTS_GOLDEN_DATASET_NAME,
      description: 'Golden UUTS campaigns for experiments / calibration',
    });
  }

  const limit = Math.max(1, Math.min(Number(process.env.LIMIT || 25) || 25, 100));
  const idFilter = (process.env.CAMPAIGN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let docs: Array<{ id: string; data: () => Record<string, unknown> }> = [];
  if (idFilter.length) {
    const snaps = await Promise.all(idFilter.map((id) => db.collection('campaigns').doc(id).get()));
    docs = snaps
      .filter((s) => s.exists)
      .map((s) => ({ id: s.id, data: () => (s.data() || {}) as Record<string, unknown> }));
  } else {
    const snap = await db.collection('campaigns').limit(limit * 3).get();
    docs = snap.docs.map((s) => ({
      id: s.id,
      data: () => (s.data() || {}) as Record<string, unknown>,
    }));
  }

  let seeded = 0;
  let skipped = 0;

  for (const doc of docs) {
    if (seeded >= limit) break;
    const data = doc.data() || {};
    const campaignId = doc.id;

    // Prefer published trust report composite, else pre-screen composite.
    let composite: number | null =
      typeof data.uuts_prescreen_composite === 'number' ? data.uuts_prescreen_composite : null;
    let factCheck: number | undefined;
    let commsIntegrity: number | undefined;
    let sharedReality: number | undefined;
    let source = 'uuts_prescreen_composite';

    try {
      const meta = await db.collection('trust_reports').doc(campaignId).get();
      const publishedId = meta.exists ? meta.data()?.publishedVersionId : null;
      if (typeof publishedId === 'string') {
        const ver = await db
          .collection('trust_reports')
          .doc(campaignId)
          .collection('versions')
          .doc(publishedId)
          .get();
        const snap = ver.data();
        const effective = snap?.final || snap?.initial;
        if (typeof effective?.composite === 'number') {
          composite = effective.composite;
          factCheck = effective.factCheck?.score;
          commsIntegrity = effective.commsIntegrity?.score;
          sharedReality = effective.sharedReality?.score;
          source = snap?.final ? 'trust_report.final' : 'trust_report.initial';
        }
      }
    } catch {
      // keep pre-screen composite
    }

    if (composite == null || !Number.isFinite(composite)) {
      skipped += 1;
      continue;
    }

    const campaignContent = buildCampaignContent({ id: campaignId, ...data });
    if (!campaignContent.trim()) {
      skipped += 1;
      continue;
    }

    await lf.dataset.createItem({
      datasetName: UUTS_GOLDEN_DATASET_NAME,
      id: campaignId,
      input: {
        campaignId,
        title: typeof data.title === 'string' ? data.title : undefined,
        category: typeof data.category === 'string' ? data.category : undefined,
        campaignContent,
      },
      expectedOutput: {
        composite,
        factCheck,
        commsIntegrity,
        sharedReality,
        band: bandLabelForScore(composite),
        meetsThreshold: meetsUutsThreshold(composite),
        source,
      },
      metadata: {
        campaignId,
        source,
      },
    });
    seeded += 1;
    console.log(`  seeded ${campaignId} composite=${composite} (${source})`);
  }

  console.log(`\nSeeded ${seeded} items (skipped ${skipped}) into ${UUTS_GOLDEN_DATASET_NAME}`);
  await lf.flush();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
