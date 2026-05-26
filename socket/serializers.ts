import { randomUUID } from "node:crypto";

type RealtimeEnvelope<TPayload> = {
  id: string;
  type: string;
  workspaceId: string;
  createdAt: string;
  dedupeKey?: string;
  payload: TPayload;
};

export function createRealtimeEnvelope<TPayload>(input: {
  type: string;
  workspaceId: string;
  payload: TPayload;
  dedupeKey?: string;
}): RealtimeEnvelope<TPayload> {
  return {
    id: randomUUID(),
    type: input.type,
    workspaceId: input.workspaceId,
    createdAt: new Date().toISOString(),
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    payload: input.payload,
  };
}

export function notificationUiMeta(type: string) {
  if (type === "MENTION") return { toast: true as const, soundKey: "mention" as const, priority: "high" as const };
  if (type === "ASSIGNMENT") return { toast: true as const, soundKey: "assignment" as const, priority: "normal" as const };
  if (type === "ISSUE_OVERDUE") return { toast: true as const, soundKey: "warning" as const, priority: "high" as const };
  return { toast: true as const, soundKey: "default" as const, priority: "normal" as const };
}
