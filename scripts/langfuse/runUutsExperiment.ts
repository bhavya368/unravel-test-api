/**
 * Run a UUTS experiment on the Langfuse golden dataset.
 *
 * Compares model output composite vs expectedOutput.composite (tolerance ±5 by default).
 * Reuses generate path via HTTP against a running API, OR locally if Vertex is configured.
 *
 * Default mode: HTTP against UNRAVEL_API_BASE (admin refresh endpoint).
 *
 * Usage:
 *   UNRAVEL_API_BASE=http://localhost:8080 \
 *   MODEL=gemini-2.5-flash-lite \
 *   npx ts-node -r dotenv/config --transpile-only scripts/langfuse/runUutsExperiment.ts
 *
 *   MODEL=claude-opus-4-6 ...  # second run → compare runs in Langfuse Experiments UI
 */
import dotenv from 'dotenv';
dotenv.config();

import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { LangfuseClient } from '@langfuse/client';
import {
  UUTS_GOLDEN_DATASET_NAME,
  UUTS_SCORE_NAMES,
} from '../../src/uutsLangfuseEval';

const TOLERANCE = Number(process.env.UUTS_EXPERIMENT_TOLERANCE || 5);

async function main() {
  const publicKey = (process.env.LANGFUSE_PUBLIC_KEY || '').trim();
  const secretKey = (process.env.LANGFUSE_SECRET_KEY || '').trim();
  if (!publicKey || !secretKey) throw new Error('Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY');

  const baseUrl = (process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com').trim();
  const apiBase = (process.env.UNRAVEL_API_BASE || 'http://localhost:8080').replace(/\/$/, '');
  const model = (process.env.MODEL || process.env.GEMINI_MODEL_UUTS_PRESCREEN || 'gemini-2.5-flash-lite').trim();
  const adminToken = (process.env.UNRAVEL_ADMIN_BEARER || '').trim();

  const otelSdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor({ exportMode: 'immediate' })],
  });
  otelSdk.start();

  const lf = new LangfuseClient({ publicKey, secretKey, baseUrl });
  const dataset = await lf.dataset.get(UUTS_GOLDEN_DATASET_NAME);

  const runName = `uuts-${model}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

  const result = await dataset.runExperiment({
    name: 'UUTS golden calibration',
    runName,
    description: `UUTS pre-screen vs golden expected composites (model=${model}, tol=±${TOLERANCE})`,
    metadata: { model, tolerance: String(TOLERANCE) },
    maxConcurrency: 1,
    task: async (item) => {
      const input = item.input as {
        campaignId?: string;
        campaignContent?: string;
      };
      const campaignId = input?.campaignId;
      if (!campaignId) {
        throw new Error('Dataset item missing input.campaignId');
      }

      // Trigger a fresh pre-screen on the live API (creates a draft + Langfuse trace).
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (adminToken) headers.Authorization = `Bearer ${adminToken}`;

      const refreshRes = await fetch(
        `${apiBase}/data/campaigns/${encodeURIComponent(campaignId)}/uuts-prescreen/refresh`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ model }),
        }
      );
      if (!refreshRes.ok) {
        const text = await refreshRes.text();
        throw new Error(`prescreen refresh ${refreshRes.status}: ${text.slice(0, 400)}`);
      }

      // Poll campaign for completion
      let composite: number | null = null;
      let layers: Record<string, number | null> = {};
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 3000));
        const campRes = await fetch(`${apiBase}/data/campaigns/${encodeURIComponent(campaignId)}`, {
          headers,
        });
        if (!campRes.ok) continue;
        const camp = (await campRes.json()) as Record<string, unknown>;
        const status = camp.uuts_prescreen_status;
        if (status === 'complete' && typeof camp.uuts_prescreen_composite === 'number') {
          composite = camp.uuts_prescreen_composite as number;
          break;
        }
        if (status === 'manual_required') {
          throw new Error(`prescreen failed: ${camp.uuts_prescreen_error || 'manual_required'}`);
        }
      }
      if (composite == null) throw new Error('Timed out waiting for UUTS pre-screen');

      // Prefer admin trust-report for layer scores
      try {
        const tr = await fetch(
          `${apiBase}/data/campaigns/${encodeURIComponent(campaignId)}/trust-report/admin`,
          { headers }
        );
        if (tr.ok) {
          const body = (await tr.json()) as {
            report?: {
              initial?: {
                factCheck?: { score?: number };
                commsIntegrity?: { score?: number };
                sharedReality?: { score?: number };
              };
            };
          };
          layers = {
            factCheck: body.report?.initial?.factCheck?.score ?? null,
            commsIntegrity: body.report?.initial?.commsIntegrity?.score ?? null,
            sharedReality: body.report?.initial?.sharedReality?.score ?? null,
          };
        }
      } catch {
        // optional
      }

      return { campaignId, composite, ...layers, model };
    },
    evaluators: [
      async ({ output, expectedOutput }) => {
        const actual = Number((output as { composite?: number })?.composite);
        const expected = Number((expectedOutput as { composite?: number })?.composite);
        if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
          return {
            name: 'uuts-composite-within-tol',
            value: 0,
            comment: 'Missing actual or expected composite',
          };
        }
        const delta = Math.abs(actual - expected);
        const pass = delta <= TOLERANCE ? 1 : 0;
        return {
          name: 'uuts-composite-within-tol',
          value: pass,
          comment: `actual=${actual} expected=${expected} Δ=${delta} tol=${TOLERANCE}`,
        };
      },
      async ({ output, expectedOutput }) => {
        const actual = Number((output as { composite?: number })?.composite);
        const expected = Number((expectedOutput as { composite?: number })?.composite);
        if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
          return { name: UUTS_SCORE_NAMES.modelDelta, value: null };
        }
        return {
          name: UUTS_SCORE_NAMES.modelDelta,
          value: Math.abs(actual - expected),
          comment: 'Abs delta vs golden expected composite',
        };
      },
    ],
    runEvaluators: [
      async ({ itemResults }) => {
        const vals = itemResults
          .flatMap((r) => r.evaluations)
          .filter((e) => e.name === 'uuts-composite-within-tol')
          .map((e) => Number(e.value))
          .filter((n) => Number.isFinite(n));
        const accuracy = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        return {
          name: 'uuts-calibration-accuracy',
          value: accuracy,
          comment: vals.length
            ? `${vals.filter((v) => v === 1).length}/${vals.length} within ±${TOLERANCE}`
            : 'no rows',
        };
      },
    ],
  });

  console.log(await result.format());
  await lf.flush();
  await otelSdk.shutdown();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
