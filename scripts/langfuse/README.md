# UUTS × Langfuse evaluation setup

Practical stack wired in `unravel-api` for the Unravel Universal Trust Score.

## What ships in code

| Layer | Behavior |
| --- | --- |
| **Scores on traces** | Every `prescreen-uuts` generation emits numeric/categorical/boolean scores (`uuts-composite`, layers, band, schema health). |
| **Prompt versioning** | Loads `uuts-prescreen` from Langfuse (`production` label) when available; falls back to Firestore `ai_prompts.uuts_prescreen`, then hardcoded fallback. Metadata records `promptSource` / `promptVersion`. |
| **Schema health** | In-process boolean scores + TypeScript snippet for a Langfuse UI **code evaluator**. |
| **Annotation queue** | On publish, if AI `initial` vs human `final` composite delta ≥ 10, enqueues the stored Langfuse trace (`UUTS_LANGFUSE_ANNOTATION_QUEUE_ID`). |
| **Golden dataset + experiments** | Scripts under `scripts/langfuse/`. |

## One-time setup

```bash
# From unravel-api with Langfuse keys in .env
npx ts-node -r dotenv/config --transpile-only scripts/langfuse/setupUutsEval.ts
npx ts-node -r dotenv/config --transpile-only scripts/langfuse/setupUutsEvaluator.ts
```

Copy the printed `UUTS_LANGFUSE_ANNOTATION_QUEUE_ID=…` into `.env` / Cloud Run.

Then:

```bash
npx ts-node -r dotenv/config --transpile-only scripts/langfuse/seedUutsDataset.ts
```

## Experiments (Gemini vs Claude)

With the API running locally (or pointed at staging):

```bash
UNRAVEL_API_BASE=http://localhost:8080 MODEL=gemini-2.5-flash-lite \
  npx ts-node -r dotenv/config --transpile-only scripts/langfuse/runUutsExperiment.ts

UNRAVEL_API_BASE=http://localhost:8080 MODEL=claude-opus-4-6 \
  npx ts-node -r dotenv/config --transpile-only scripts/langfuse/runUutsExperiment.ts
```

Compare the two dataset runs in Langfuse → Datasets → `uuts-golden-campaigns`.

## Env vars

| Variable | Purpose |
| --- | --- |
| `LANGFUSE_*` | Existing tracing keys |
| `UUTS_PROMPT_SOURCE` | `auto` (default) \| `langfuse` \| `firestore` |
| `UUTS_LANGFUSE_PROMPT_LABEL` | Prompt label (default `production`) |
| `UUTS_LANGFUSE_ANNOTATION_QUEUE_ID` | From setup script |
| `UUTS_EXPERIMENT_TOLERANCE` | Composite ± tolerance for experiment pass (default `5`) |

## Code evaluator (Langfuse UI)

Paste the snippet printed by `setupUutsEval.ts` (also exported as `UUTS_CODE_EVALUATOR_SNIPPET`). Target observations named `prescreen-uuts` / tag `uuts-prescreen`.

## Judge calibration

Use `.agents/skills/langfuse/references/judge-calibration.md` against `uuts-golden-campaigns` once human labels are in `expectedOutput`.
