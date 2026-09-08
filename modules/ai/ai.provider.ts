/**
 * AI Provider Layer — OpenRouter Abstraction
 *
 * All AI calls go through this single file. No other file imports OpenRouter directly.
 * Supports model switching (free ↔ paid) per workspace via the aiModel field.
 *
 * Architecture:
 *   callAI(taskType, messages, options) → OpenRouter → Any model
 *
 * Models are routed by task type:
 *   - Simple extraction (labels, priority) → cheapest model
 *   - Generation (issues, chat) → workspace's selected model
 *   - Reports/summaries → cheapest model
 *
 * Switching from free to paid = changing one string in the workspace settings.
 * No code changes required.
 */

import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { env } from "../../config/env.js";
import { AiCallAbortedError } from "./ai.tool-runtime.js";

// ─── Available Models ───────────────────────────────────────────────────────

export interface AiModel {
  id: string;           // OpenRouter model ID
  name: string;         // Display name for UI
  provider: string;     // Provider name
  free: boolean;        // Whether it's free tier
  tier: "fast" | "balanced" | "premium";
}

export const AI_MODELS: Record<string, AiModel> = {
  // Free models (no credits needed)
  "qwen/qwen3-coder:free": {
    id: "qwen/qwen3-coder:free",
    name: "Qwen3 Coder (Free)",
    provider: "Qwen",
    free: true,
    tier: "balanced",
  },
  "meta-llama/llama-3.3-70b-instruct:free": {
    id: "meta-llama/llama-3.3-70b-instruct:free",
    name: "Llama 3.3 70B (Free)",
    provider: "Meta",
    free: true,
    tier: "balanced",
  },
  "nvidia/nemotron-3-ultra-550b-a55b:free": {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    name: "Nemotron 3 Ultra 550B (Free)",
    provider: "NVIDIA",
    free: true,
    tier: "premium",
  },
  "google/gemma-4-31b-it:free": {
    id: "google/gemma-4-31b-it:free",
    name: "Gemma 4 31B (Free)",
    provider: "Google",
    free: true,
    tier: "fast",
  },
  "qwen/qwen3-next-80b-a3b-instruct:free": {
    id: "qwen/qwen3-next-80b-a3b-instruct:free",
    name: "Qwen3 Next 80B (Free)",
    provider: "Qwen",
    free: true,
    tier: "balanced",
  },
  "openai/gpt-oss-120b:free": {
    id: "openai/gpt-oss-120b:free",
    name: "GPT OSS 120B (Free)",
    provider: "OpenAI",
    free: true,
    tier: "balanced",
  },
  // Paid models (require OpenRouter credits)
  "anthropic/claude-sonnet-4": {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4 (Premium)",
    provider: "Anthropic",
    free: false,
    tier: "premium",
  },
  "deepseek/deepseek-v4-flash": {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    provider: "DeepSeek",
    free: false,
    tier: "balanced",
  },
};

// ─── Model Configuration (from env, with hardcoded defaults) ────────────────

// Issue Creator models (Phase 20A)
export const ISSUE_MODEL_DEFAULT = env.AI_ISSUE_MODEL_DEFAULT ?? "deepseek/deepseek-v4-flash";
export const ISSUE_MODEL_FALLBACKS = [
  ISSUE_MODEL_DEFAULT,
  env.AI_ISSUE_MODEL_FALLBACK_1 ?? "meta-llama/llama-3.3-70b-instruct:free",
  env.AI_ISSUE_MODEL_FALLBACK_2 ?? "qwen/qwen3-coder:free",
  env.AI_ISSUE_MODEL_FALLBACK_3 ?? "google/gemma-4-31b-it:free",
].filter(Boolean);

// Trussen AI Chat models (Phase 20B)
export const CHAT_MODEL_DEFAULT = env.AI_CHAT_MODEL_DEFAULT ?? "deepseek/deepseek-v4-flash";
export const CHAT_MODEL_FALLBACKS = [
  CHAT_MODEL_DEFAULT,
  env.AI_CHAT_MODEL_FALLBACK_1 ?? "meta-llama/llama-3.3-70b-instruct:free",
  env.AI_CHAT_MODEL_FALLBACK_2 ?? "qwen/qwen3-coder:free",
  env.AI_CHAT_MODEL_FALLBACK_3 ?? "google/gemma-4-31b-it:free",
].filter(Boolean);

export const EMBEDDING_MODEL_DEFAULT = env.AI_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";

// Legacy alias — used by callAI when no specific model config is passed
export const DEFAULT_AI_MODEL = ISSUE_MODEL_DEFAULT;
export const FREE_MODEL_FALLBACKS = ISSUE_MODEL_FALLBACKS;

function uniqueModels(models: Array<string | undefined | null>) {
  return Array.from(new Set(models.filter((model): model is string => Boolean(model))));
}

export function fallbackChainForPrimary(primaryModel: string) {
  if (CHAT_MODEL_FALLBACKS.includes(primaryModel) || primaryModel === CHAT_MODEL_DEFAULT) {
    return uniqueModels([primaryModel, ...CHAT_MODEL_FALLBACKS.filter((model) => model.includes(":free"))]);
  }
  if (ISSUE_MODEL_FALLBACKS.includes(primaryModel) || primaryModel === ISSUE_MODEL_DEFAULT) {
    return uniqueModels([primaryModel, ...ISSUE_MODEL_FALLBACKS.filter((model) => model.includes(":free"))]);
  }

  return uniqueModels([
    primaryModel,
    ...CHAT_MODEL_FALLBACKS.filter((model) => model.includes(":free")),
    ...ISSUE_MODEL_FALLBACKS.filter((model) => model.includes(":free")),
  ]);
}

// ─── Task-Specific Max Tokens ───────────────────────────────────────────────

const TASK_MAX_TOKENS: Record<string, number> = {
  generate_issue: 1500,
  suggest_labels: 200,
  suggest_priority: 100,
  detect_type: 100,
  chat_response: 2048,
  brainstorm: 2048,
  weekly_report: 3000,
  standup_summary: 1500,
};

// ─── Core AI Call ───────────────────────────────────────────────────────────

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiCallOptions {
  /** Override the model (instead of workspace default) */
  model?: string;
  /** Task type for max_tokens routing */
  taskType?: string;
  /** Max output tokens (overrides task-based default) */
  maxTokens?: number;
  /** Temperature (0-1, lower = more deterministic) */
  temperature?: number;
  /**
   * Caller-provided abort signal (e.g. tied to the HTTP request's "close"
   * event) — aborting it cancels the in-flight provider call instead of
   * letting it run to completion (and get billed) after the caller left.
   */
  signal?: AbortSignal | undefined;
}

export interface AiCallResult {
  content: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface AiEmbeddingResult {
  embedding: number[];
  model: string;
  usage: {
    inputTokens: number;
    totalTokens: number;
  };
}

/**
 * Make a single AI call to OpenRouter for a specific model.
 * Returns the response or throws on error.
 */
async function callModel(
  model: string,
  messages: AiMessage[],
  maxTokens: number,
  temperature: number,
  callerSignal?: AbortSignal,
): Promise<{ response: Response } | { rateLimited: true; retryAfter: number }> {
  if (callerSignal?.aborted) {
    throw new AiCallAbortedError();
  }

  // Two abort sources share one signal: our own timeout, and the caller's
  // cancel request. `abortedByCaller` distinguishes them so a user-initiated
  // cancel is not reported back as a provider timeout.
  const controller = new AbortController();
  let abortedByCaller = false;
  const onCallerAbort = () => {
    abortedByCaller = true;
    controller.abort();
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  const cleanup = () => {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };

  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.FRONTEND_URL,
        "X-Title": "Trussen",
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (abortedByCaller) throw new AiCallAbortedError();
      throw new AppError(504, ERROR_CODES.AI_PROVIDER_ERROR, "AI request timed out. Please try again.");
    }
    throw new AppError(502, ERROR_CODES.AI_PROVIDER_ERROR, "Failed to reach AI provider");
  } finally {
    cleanup();
  }

  if (response.status === 429) {
    const errorBody = await safeParseJson<{ error?: { metadata?: { retry_after_seconds?: number } } }>(response);
    const retryAfter = errorBody.error?.metadata?.retry_after_seconds ?? 10;
    console.warn(`[AI Provider] ${model} rate-limited. Retry after ${retryAfter}s. Trying fallback...`);
    return { rateLimited: true, retryAfter };
  }

  return { response };
}

/**
 * Make an AI call via OpenRouter with automatic fallback.
 *
 * If the primary model is rate-limited (429), automatically tries the next
 * free model in the fallback chain. This ensures the user always gets a response
 * even when individual models are temporarily overloaded.
 *
 * This is the ONLY function that talks to OpenRouter. Everything else calls this.
 */
export async function callAI(
  messages: AiMessage[],
  options: AiCallOptions = {},
): Promise<AiCallResult> {
  if (!env.OPENROUTER_API_KEY) {
    throw new AppError(500, ERROR_CODES.AI_NOT_CONFIGURED, "AI is not configured — OPENROUTER_API_KEY is missing");
  }

  if (options.signal?.aborted) {
    throw new AiCallAbortedError();
  }

  const primaryModel = options.model ?? DEFAULT_AI_MODEL;
  const maxTokens = options.maxTokens ?? TASK_MAX_TOKENS[options.taskType ?? ""] ?? 1024;
  const temperature = Math.max(0, Math.min(1, options.temperature ?? 0.3));

  // Build model list: primary first, then fallbacks (excluding primary to avoid retry)
  const modelsToTry = fallbackChainForPrimary(primaryModel);

  let lastError: AppError | null = null;

  for (const model of modelsToTry) {
    const result = await callModel(model, messages, maxTokens, temperature, options.signal);

    if ("rateLimited" in result) {
      lastError = new AppError(429, ERROR_CODES.AI_RATE_LIMITED, `Model ${model} is temporarily rate-limited`);
      continue; // Try next model
    }

    const { response } = result;

    if (!response.ok) {
      const errorBody = await safeParseJson<{ error?: { message?: string; code?: number; metadata?: Record<string, unknown> } }>(response);
      console.error(`[AI Provider] ${model} error (HTTP ${response.status}):`, JSON.stringify(errorBody));
      lastError = new AppError(
        502,
        ERROR_CODES.AI_PROVIDER_ERROR,
        errorBody.error?.message || `AI provider returned error (HTTP ${response.status})`,
      );
      continue; // Try next model
    }

    // Success — parse response
    const data = await safeParseJson<{
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      error?: { message?: string };
    }>(response);

    if (data.error) {
      lastError = new AppError(502, ERROR_CODES.AI_PROVIDER_ERROR, data.error.message || "AI provider error");
      continue;
    }

    let content = data.choices?.[0]?.message?.content;
    if (!content) {
      lastError = new AppError(502, ERROR_CODES.AI_PROVIDER_ERROR, "AI returned an empty response");
      continue;
    }

    // Strip <think>...</think> blocks (DeepSeek R1, Qwen reasoning models)
    content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    if (!content) {
      lastError = new AppError(502, ERROR_CODES.AI_PROVIDER_ERROR, "AI returned only reasoning with no output");
      continue;
    }

    console.log(`[AI Provider] Success with ${model} (${data.usage?.total_tokens ?? 0} tokens)`);

    return {
      content,
      model,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    };
  }

  // All models failed
  throw lastError ?? new AppError(502, ERROR_CODES.AI_PROVIDER_ERROR, "All AI models are currently unavailable. Please try again in a moment.");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function safeParseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return {} as T;
  }
}

/**
 * List models available for workspace settings UI.
 */
export function listAvailableModels(): AiModel[] {
  return Object.values(AI_MODELS);
}

/**
 * Validate that a model ID is known and available.
 */
export function isValidModel(modelId: string): boolean {
  return modelId in AI_MODELS;
}

export async function createEmbedding(
  input: string,
  model = EMBEDDING_MODEL_DEFAULT,
): Promise<AiEmbeddingResult> {
  if (!env.OPENROUTER_API_KEY) {
    throw new AppError(500, ERROR_CODES.AI_NOT_CONFIGURED, "AI is not configured — OPENROUTER_API_KEY is missing");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);

  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.FRONTEND_URL,
        "X-Title": "Trussen",
      },
      body: JSON.stringify({
        model,
        input,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new AppError(504, ERROR_CODES.AI_PROVIDER_ERROR, "Embedding request timed out. Please try again.");
    }
    throw new AppError(502, ERROR_CODES.AI_PROVIDER_ERROR, "Failed to reach AI provider");
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorBody = await safeParseJson<{ error?: { message?: string } }>(response);
    throw new AppError(
      502,
      ERROR_CODES.AI_PROVIDER_ERROR,
      errorBody.error?.message || `Embedding provider returned error (HTTP ${response.status})`,
    );
  }

  const data = await safeParseJson<{
    data?: Array<{ embedding?: number[] }>;
    usage?: { prompt_tokens?: number; total_tokens?: number };
  }>(response);

  const embedding = data.data?.[0]?.embedding;
  if (!embedding || embedding.length === 0) {
    throw new AppError(502, ERROR_CODES.AI_PROVIDER_ERROR, "Embedding provider returned an empty vector");
  }

  return {
    embedding,
    model,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? data.usage?.prompt_tokens ?? 0,
    },
  };
}
