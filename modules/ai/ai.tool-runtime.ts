import { env } from "../../config/env.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import type { ToolDefinition } from "./tools/tool-definitions.js";

export interface AiToolRuntimeMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface AiToolRuntimeResult {
  content: string | null;
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Prompt tokens served from the provider's cache, billed at a large discount. */
    cachedInputTokens: number;
    /** Provider-reported cost in USD, when available. */
    costUsd: number | null;
  };
}

/** Thrown when the caller aborts (user pressed stop) rather than the request timing out. */
export class AiCallAbortedError extends Error {
  constructor() {
    super("AI request aborted by caller");
    this.name = "AiCallAbortedError";
  }
}

export async function callAIWithTools(
  messages: AiToolRuntimeMessage[],
  model: string,
  tools: ToolDefinition[],
  options: { signal?: AbortSignal | undefined } = {},
): Promise<AiToolRuntimeResult> {
  if (!env.OPENROUTER_API_KEY) {
    throw new AppError(500, ERROR_CODES.AI_NOT_CONFIGURED, "AI is not configured");
  }

  if (options.signal?.aborted) {
    throw new AiCallAbortedError();
  }

  // Two abort sources share one signal: our own timeout, and the caller's stop
  // request. `abortedByCaller` distinguishes them so a user-initiated stop is not
  // reported to the user as a provider timeout.
  const controller = new AbortController();
  let abortedByCaller = false;
  const onCallerAbort = () => {
    abortedByCaller = true;
    controller.abort();
  };
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  const cleanup = () => {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", onCallerAbort);
  };

  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.FRONTEND_URL,
        "X-Title": "Trussen",
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        max_tokens: 1800,
        temperature: 0.3,
        // Returns cached-token counts and real cost alongside raw usage. Raw
        // prompt_tokens counts cached tokens at full weight, so without this the
        // reported figure badly overstates what a turn actually costs on a
        // provider that caches the stable prefix.
        usage: { include: true },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (abortedByCaller) throw new AiCallAbortedError();
      throw new AppError(504, ERROR_CODES.AI_PROVIDER_ERROR, "AI request timed out");
    }
    throw new AppError(502, ERROR_CODES.AI_PROVIDER_ERROR, "Failed to reach AI provider");
  } finally {
    cleanup();
  }

  if (response.status === 429) {
    return {
      content: null,
      toolCalls: null,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null },
    };
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new AppError(502, ERROR_CODES.AI_PROVIDER_ERROR, err.error?.message || `AI error (${response.status})`);
  }

  const data = await response.json() as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };

  const choice = data.choices?.[0]?.message;
  let content = choice?.content ?? null;

  if (content) {
    content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || null;
  }

  return {
    content,
    toolCalls: choice?.tool_calls ?? null,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      costUsd: typeof data.usage?.cost === "number" ? data.usage.cost : null,
    },
  };
}
