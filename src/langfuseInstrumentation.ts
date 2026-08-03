/**
 * Langfuse + OpenTelemetry setup for Vertex AI / Gemini tracing.
 * Load env before reading keys (CommonJS import order can beat dotenv in index.ts).
 */
import dotenv from 'dotenv';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  propagateAttributes,
  startActiveObservation,
} from '@langfuse/tracing';

dotenv.config();

export type GeminiUsageDetails = {
  input?: number;
  output?: number;
  total?: number;
};

type TraceGeminiCallOptions<T> = {
  /** Stable, low-cardinality name (verb-first), e.g. moderate-campaign */
  name: string;
  model: string;
  /** Meaningful generation input (avoid secrets; truncate huge blobs) */
  input: unknown;
  tags: string[];
  /** String-only metadata (Langfuse drops non-strings); values ≤200 chars */
  metadata?: Record<string, string>;
  run: () => Promise<{
    result: T;
    output: unknown;
    usageDetails?: GeminiUsageDetails;
  }>;
};

let enabled = false;
let langfuseSpanProcessor: LangfuseSpanProcessor | null = null;
let sdk: NodeSDK | null = null;

function hasLangfuseCredentials(): boolean {
  const publicKey = (process.env.LANGFUSE_PUBLIC_KEY || '').trim();
  const secretKey = (process.env.LANGFUSE_SECRET_KEY || '').trim();
  return Boolean(publicKey && secretKey);
}

/**
 * Start OTEL → Langfuse export. Safe no-op when keys are missing.
 * Call once at process startup (after env is available).
 */
export function initLangfuse(): boolean {
  if (sdk) return enabled;
  if (!hasLangfuseCredentials()) {
    console.warn(
      '[Langfuse] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set — LLM tracing disabled'
    );
    enabled = false;
    return false;
  }

  const environment =
    (process.env.LANGFUSE_TRACING_ENVIRONMENT || process.env.NODE_ENV || 'development').trim() ||
    'development';

  langfuseSpanProcessor = new LangfuseSpanProcessor({
    // Cloud Run / short request paths: export ASAP so spans aren't dropped on scale-down
    exportMode: 'immediate',
    environment,
  });
  sdk = new NodeSDK({
    spanProcessors: [langfuseSpanProcessor],
  });
  sdk.start();
  enabled = true;
  const base = (process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com').trim();
  console.log(`[Langfuse] tracing enabled → ${base} (${environment})`);
  return true;
}

export function isLangfuseEnabled(): boolean {
  return enabled;
}

/** Flush buffered spans (shutdown / end of one-shot scripts). */
export async function forceFlushLangfuse(): Promise<void> {
  if (langfuseSpanProcessor) {
    await langfuseSpanProcessor.forceFlush();
  }
}

export function extractVertexUsage(result: {
  response?: {
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
}): GeminiUsageDetails | undefined {
  const u = result.response?.usageMetadata;
  if (!u) return undefined;
  return {
    input: u.promptTokenCount,
    output: u.candidatesTokenCount,
    total: u.totalTokenCount,
  };
}

/** Cap string metadata values for Langfuse propagateAttributes limits. */
export function metaStr(value: unknown, max = 200): string {
  const s = value == null ? '' : String(value);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * One generation trace per Gemini call (model, tokens, I/O).
 * No-ops (still runs `run`) when Langfuse is not configured.
 */
export async function traceGeminiCall<T>(options: TraceGeminiCallOptions<T>): Promise<T> {
  if (!enabled) {
    const { result } = await options.run();
    return result;
  }

  return startActiveObservation(
    options.name,
    async (generation) => {
      generation.update({
        model: options.model,
        input: options.input,
        metadata: options.metadata,
      });

      return propagateAttributes(
        {
          tags: options.tags,
          metadata: {
            feature: options.tags[0] || options.name,
            ...(options.metadata || {}),
          },
          version: metaStr(process.env.K_REVISION || process.env.npm_package_version || '1'),
          traceName: options.name,
        },
        async () => {
          try {
            const { result, output, usageDetails } = await options.run();
            generation.update({
              output,
              ...(usageDetails ? { usageDetails } : {}),
            });
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            generation.update({
              level: 'ERROR',
              statusMessage: message,
              output: { error: message },
            });
            throw error;
          }
        }
      );
    },
    { asType: 'generation' }
  );
}
