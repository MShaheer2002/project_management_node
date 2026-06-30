import { createHash } from "node:crypto";
import { prisma } from "../../shared/utils/prisma.js";

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

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }
  return value;
}

function toDimensionsHash(value: Record<string, unknown> | undefined) {
  const normalized = sortJsonValue(value ?? {});
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function toUtcDateBucket(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export async function incrementAiMetricCounter(input: {
  workspaceId: string;
  feature: string;
  metric: string;
  dimensions?: Record<string, unknown> | undefined;
  count?: number | undefined;
}) {
  const delegate = (prisma as any).aiMetricCounterDaily;
  if (!delegate?.upsert) return;
  const dimensions = sortJsonValue(input.dimensions ?? {}) as Record<string, unknown>;
  const dimensionsHash = toDimensionsHash(dimensions);
  await delegate.upsert({
    where: {
      workspaceId_feature_metric_bucketDate_dimensionsHash: {
        workspaceId: input.workspaceId,
        feature: input.feature,
        metric: input.metric,
        bucketDate: toUtcDateBucket(),
        dimensionsHash,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      feature: input.feature,
      metric: input.metric,
      bucketDate: toUtcDateBucket(),
      dimensionsHash,
      dimensions,
      count: input.count ?? 1,
    },
    update: {
      count: {
        increment: input.count ?? 1,
      },
      ...(Object.keys(dimensions).length > 0 ? { dimensions } : {}),
    },
  }).catch(() => {});
}

export async function recordAiResolverSnapshot(input: {
  workspaceId: string;
  userId?: string | undefined;
  conversationId?: string | undefined;
  triggeringIntent?: string | undefined;
  requestedEntityType: string;
  expectedEntityTypes: string[];
  rawTextFragment: string;
  accessMode: string;
  actionRisk: string;
  chosenCandidate?: { id: string; name: string } | null | undefined;
  confidence?: number | null | undefined;
  resolutionStatus: string;
  confirmationRequired: boolean;
  contextOnly: boolean;
  memoryAssisted: boolean;
  topCandidates?: Array<{ id: string; name: string; confidence: number; reason: string }> | undefined;
  reason?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}) {
  const delegate = (prisma as any).aiResolverSnapshot;
  if (!delegate?.create) return;
  await delegate.create({
    data: {
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      conversationId: input.conversationId ?? null,
      triggeringIntent: input.triggeringIntent ?? null,
      requestedEntityType: input.requestedEntityType,
      expectedEntityTypes: input.expectedEntityTypes,
      rawTextFragment: input.rawTextFragment,
      accessMode: input.accessMode,
      actionRisk: input.actionRisk,
      chosenCandidateId: input.chosenCandidate?.id ?? null,
      chosenCandidateName: input.chosenCandidate?.name ?? null,
      confidence: input.confidence ?? null,
      resolutionStatus: input.resolutionStatus,
      confirmationRequired: input.confirmationRequired,
      contextOnly: input.contextOnly,
      memoryAssisted: input.memoryAssisted,
      topCandidates: input.topCandidates ?? [],
      reason: input.reason ?? null,
      metadata: input.metadata ?? null,
    },
  }).catch(() => {});
}
