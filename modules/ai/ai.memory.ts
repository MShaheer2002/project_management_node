import { randomUUID } from "node:crypto";

import type { PendingAiAction } from "./ai.action-state.js";
import { detectScriptFamily } from "./ai.text-normalization.js";

export type ConversationMemory = {
  language?: string | undefined;
  currentProjectId?: string | undefined;
  currentIssueId?: string | undefined;
  currentTeamId?: string | undefined;
  currentDepartmentId?: string | undefined;
  currentCycleId?: string | undefined;
  lastResolvedEntities: Array<{
    entityType: "project" | "issue" | "team" | "department" | "member" | "cycle";
    entityId: string;
    name: string;
  }>;
  pendingSlots?: Record<string, unknown> | undefined;
  pendingConfirmation?: {
    pendingActionId: string;
    intent: string;
    previewText: string;
    expiresAt: string;
  } | undefined;
  recentReferences?: string[] | undefined;
};

export type ConversationResolverContext = {
  projectId?: string;
  issueId?: string;
  teamId?: string;
  departmentId?: string;
  cycleId?: string;
  memberId?: string;
};

const MAX_RECENT_ENTITIES = 8;
const MAX_RECENT_REFERENCES = 12;
const REFERENCE_PRONOUN_PATTERN = /\b(it|that|this|them|those|these)\b/i;

export function createEmptyConversationMemory(): ConversationMemory {
  return {
    lastResolvedEntities: [],
    recentReferences: [],
  };
}

export function parseConversationMemory(value: unknown): ConversationMemory {
  if (!value || typeof value !== "object") {
    return createEmptyConversationMemory();
  }

  const record = value as Record<string, unknown>;
  const lastResolvedEntities = Array.isArray(record.lastResolvedEntities)
    ? record.lastResolvedEntities
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const item = entry as Record<string, unknown>;
        if (
          typeof item.entityType !== "string" ||
          typeof item.entityId !== "string" ||
          typeof item.name !== "string"
        ) {
          return null;
        }

        return {
          entityType: item.entityType as ConversationMemory["lastResolvedEntities"][number]["entityType"],
          entityId: item.entityId,
          name: item.name,
        };
      })
      .filter((entry): entry is ConversationMemory["lastResolvedEntities"][number] => entry !== null)
      .slice(0, MAX_RECENT_ENTITIES)
    : [];

  const recentReferences = Array.isArray(record.recentReferences)
    ? record.recentReferences.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_RECENT_REFERENCES)
    : [];

  const pendingConfirmation = record.pendingConfirmation && typeof record.pendingConfirmation === "object"
    ? (() => {
        const pending = record.pendingConfirmation as Record<string, unknown>;
        if (
          typeof pending.pendingActionId !== "string" ||
          typeof pending.intent !== "string" ||
          typeof pending.previewText !== "string" ||
          typeof pending.expiresAt !== "string"
        ) {
          return undefined;
        }
        return {
          pendingActionId: pending.pendingActionId,
          intent: pending.intent,
          previewText: pending.previewText,
          expiresAt: pending.expiresAt,
        };
      })()
    : undefined;

  return {
    ...createEmptyConversationMemory(),
    ...(typeof record.language === "string" ? { language: record.language } : {}),
    ...(typeof record.currentProjectId === "string" ? { currentProjectId: record.currentProjectId } : {}),
    ...(typeof record.currentIssueId === "string" ? { currentIssueId: record.currentIssueId } : {}),
    ...(typeof record.currentTeamId === "string" ? { currentTeamId: record.currentTeamId } : {}),
    ...(typeof record.currentDepartmentId === "string" ? { currentDepartmentId: record.currentDepartmentId } : {}),
    ...(typeof record.currentCycleId === "string" ? { currentCycleId: record.currentCycleId } : {}),
    ...(record.pendingSlots && typeof record.pendingSlots === "object" ? { pendingSlots: record.pendingSlots as Record<string, unknown> } : {}),
    ...(pendingConfirmation ? { pendingConfirmation } : {}),
    lastResolvedEntities,
    recentReferences,
  };
}

export function createPendingActionId() {
  return randomUUID();
}

export function updateConversationMemoryFromPendingAction(
  memory: ConversationMemory,
  pendingAction: PendingAiAction | null,
) {
  const nextMemory = { ...memory };

  if (!pendingAction) {
    delete nextMemory.pendingSlots;
    delete nextMemory.pendingConfirmation;
    return nextMemory;
  }

  nextMemory.pendingSlots = pendingAction.slots;

  if (pendingAction.status === "awaiting_confirmation" && pendingAction.pendingActionId) {
    nextMemory.pendingConfirmation = {
      pendingActionId: pendingAction.pendingActionId,
      intent: pendingAction.intent ?? pendingAction.action,
      previewText: pendingAction.previewText ?? pendingAction.prompt,
      expiresAt: pendingAction.expiresAt ?? new Date(Date.now() + (15 * 60 * 1000)).toISOString(),
    };
  } else {
    delete nextMemory.pendingConfirmation;
  }

  return nextMemory;
}

export function rememberResolvedEntity(
  memory: ConversationMemory,
  entity: { entityType: ConversationMemory["lastResolvedEntities"][number]["entityType"]; entityId: string; name: string },
) {
  const deduped = [
    entity,
    ...memory.lastResolvedEntities.filter((entry) => !(entry.entityType === entity.entityType && entry.entityId === entity.entityId)),
  ].slice(0, MAX_RECENT_ENTITIES);

  const nextMemory: ConversationMemory = {
    ...memory,
    lastResolvedEntities: deduped,
  };

  if (entity.entityType === "project") nextMemory.currentProjectId = entity.entityId;
  if (entity.entityType === "issue") nextMemory.currentIssueId = entity.entityId;
  if (entity.entityType === "team") nextMemory.currentTeamId = entity.entityId;
  if (entity.entityType === "department") nextMemory.currentDepartmentId = entity.entityId;
  if (entity.entityType === "cycle") nextMemory.currentCycleId = entity.entityId;

  return nextMemory;
}

export function addRecentReference(memory: ConversationMemory, reference: string) {
  const normalized = reference.trim().toLowerCase();
  if (!normalized) return memory;

  return {
    ...memory,
    recentReferences: [
      normalized,
      ...(memory.recentReferences ?? []).filter((entry) => entry !== normalized),
    ].slice(0, MAX_RECENT_REFERENCES),
  };
}

function inferConversationLanguage(message: string, previousLanguage?: string | undefined) {
  const scriptFamily = detectScriptFamily(message);
  if (scriptFamily === "arabic") return "ar";
  if (scriptFamily === "devanagari") return "hi";
  if (scriptFamily === "han") return "zh";
  if (scriptFamily === "hiragana" || scriptFamily === "katakana") return "ja";
  if (scriptFamily === "hangul") return "ko";
  if (scriptFamily === "cyrillic") return "ru";
  if (scriptFamily === "latin") return "en";
  return previousLanguage;
}

export function updateConversationMemoryFromUserMessage(memory: ConversationMemory, message: string) {
  let nextMemory = { ...memory };
  const inferredLanguage = inferConversationLanguage(message, nextMemory.language);
  if (inferredLanguage) {
    nextMemory.language = inferredLanguage;
  }

  const referenceMatch = message.match(REFERENCE_PRONOUN_PATTERN)?.[1];
  if (referenceMatch) {
    nextMemory = addRecentReference(nextMemory, referenceMatch);
  }

  return nextMemory;
}

export function buildResolverContextFromMemory(memory: ConversationMemory | null | undefined): ConversationResolverContext | undefined {
  if (!memory) return undefined;

  const context: ConversationResolverContext = {
    ...(memory.currentProjectId ? { projectId: memory.currentProjectId } : {}),
    ...(memory.currentIssueId ? { issueId: memory.currentIssueId } : {}),
    ...(memory.currentTeamId ? { teamId: memory.currentTeamId } : {}),
    ...(memory.currentDepartmentId ? { departmentId: memory.currentDepartmentId } : {}),
    ...(memory.currentCycleId ? { cycleId: memory.currentCycleId } : {}),
  };

  const lastMember = memory.lastResolvedEntities.find((entry) => entry.entityType === "member");
  if (lastMember?.entityId) {
    context.memberId = lastMember.entityId;
  }

  return Object.keys(context).length > 0 ? context : undefined;
}
