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
  usage: { inputTokens: number; outputTokens: number };
}

export async function callAIWithTools(
  messages: AiToolRuntimeMessage[],
  model: string,
  tools: ToolDefinition[],
): Promise<AiToolRuntimeResult> {
  if (!env.OPENROUTER_API_KEY) {
    throw new AppError(500, ERROR_CODES.AI_NOT_CONFIGURED, "AI is not configured");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);

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
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new AppError(504, ERROR_CODES.AI_PROVIDER_ERROR, "AI request timed out");
    }
    throw new AppError(502, ERROR_CODES.AI_PROVIDER_ERROR, "Failed to reach AI provider");
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 429) {
    return { content: null, toolCalls: null, usage: { inputTokens: 0, outputTokens: 0 } };
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
    usage?: { prompt_tokens?: number; completion_tokens?: number };
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
    },
  };
}
