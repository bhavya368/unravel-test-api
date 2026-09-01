/**
 * Create UUTS schema-health code evaluator + live observation rule in Langfuse.
 */
import dotenv from 'dotenv';
dotenv.config();

import { LangfuseClient } from '@langfuse/client';
import { UUTS_CODE_EVALUATOR_SNIPPET } from '../../src/uutsLangfuseEval';

async function main() {
  const lf = new LangfuseClient();
  const name = 'uuts-schema-health';

  const listed = await lf.api.unstable.evaluators.list({ limit: 100 });
  const items = listed.data || [];
  let existing = items.find((e: { name: string }) => e.name === name) || null;

  if (!existing) {
    const created = await lf.api.unstable.evaluators.create({
      type: 'code',
      name,
      sourceCode: UUTS_CODE_EVALUATOR_SNIPPET,
      sourceCodeLanguage: 'TYPESCRIPT',
    });
    console.log('evaluator created:', created.id, created.name);
    existing = created;
  } else {
    console.log('evaluator exists:', existing.id);
  }

  const rules = await lf.api.unstable.evaluationRules.list({ limit: 100 });
  const ruleItems = rules.data || [];
  const ruleName = 'uuts-schema-health-live';
  if (ruleItems.find((r: { name: string }) => r.name === ruleName)) {
    console.log('rule exists:', ruleName);
  } else {
    const rule = await lf.api.unstable.evaluationRules.create({
      name: ruleName,
      evaluator: { name, scope: 'project', type: 'code' },
      target: 'observation',
      enabled: true,
      sampling: 1,
      filter: [
        {
          type: 'stringOptions',
          column: 'name',
          operator: 'any of',
          value: ['prescreen-uuts'],
        },
      ],
    });
    console.log('rule created:', rule.id, rule.name, 'status=', rule.status);
  }

  await lf.flush();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
