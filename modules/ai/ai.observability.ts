type LogLevel = "info" | "warn" | "error";

interface AiLogPayload {
  workspaceId?: string | undefined;
  userId?: string | undefined;
  conversationId?: string | undefined;
  feature?: string | undefined;
  model?: string | undefined;
  fallbackUsed?: boolean | undefined;
  toolName?: string | undefined;
  toolCount?: number | undefined;
  latencyMs?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  success?: boolean | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

function clean<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function emit(level: LogLevel, event: string, payload: AiLogPayload) {
  const record = clean({
    component: "ai",
    event,
    timestamp: new Date().toISOString(),
    ...payload,
  });

  const line = `[AI] ${JSON.stringify(record)}`;

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.info(line);
}

export function logAiInfo(event: string, payload: AiLogPayload) {
  emit("info", event, payload);
}

export function logAiWarn(event: string, payload: AiLogPayload) {
  emit("warn", event, payload);
}

export function logAiError(event: string, payload: AiLogPayload) {
  emit("error", event, payload);
}
