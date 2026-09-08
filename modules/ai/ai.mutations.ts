/**
 * AI Mutation Records — Phase 20K
 *
 * Every workspace change made by AI is recorded here with the prior values of
 * exactly the fields it touched, so the chat panel can offer accept/reject on
 * each change.
 *
 * Why undo instead of confirm-first: AI can never delete, so nearly every change
 * it makes is reversible. Gating each action behind a confirmation dialog trades
 * a rare bad outcome for constant friction, and confirmation fatigue is a
 * well-documented failure mode. High-impact actions (role changes, member
 * removal) still confirm up front — see `requireConfirmedHighImpact` in the tool
 * executor. Everything else executes and stays reversible.
 *
 * Reverts restore only the recorded fields. A blind write-back of the whole
 * entity would clobber concurrent edits made by other people between the AI's
 * change and the user's rejection.
 */

import type { Prisma } from "../../app/generated/prisma/client.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import { prisma } from "../../shared/utils/prisma.js";
import { logAiInfo, logAiWarn } from "./ai.observability.js";

export type AiMutationKind = "CREATE" | "UPDATE";

export interface RecordMutationInput {
  workspaceId: string;
  userId: string;
  conversationId?: string | undefined;
  messageId?: string | undefined;
  toolName: string;
  kind: AiMutationKind;
  targetType: string;
  targetId: string;
  targetLabel: string;
  summary: string;
  /** Changed fields only, with their values *before* this mutation. Omit for CREATE. */
  beforeState?: Record<string, unknown> | undefined;
  afterState?: Record<string, unknown> | undefined;
}

/**
 * Records a completed AI mutation. Never throws into the caller's path — a
 * bookkeeping failure must not fail an already-applied workspace change, since
 * that would report failure for work that actually succeeded.
 */
export async function recordAiMutation(input: RecordMutationInput): Promise<string | null> {
  try {
    const record = await prisma.aiMutationRecord.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
        toolName: input.toolName,
        kind: input.kind,
        targetType: input.targetType,
        targetId: input.targetId,
        targetLabel: input.targetLabel,
        summary: input.summary,
        beforeState: (input.beforeState ?? null) as Prisma.InputJsonValue,
        afterState: (input.afterState ?? null) as Prisma.InputJsonValue,
        // A create cannot be auto-reverted: undoing it would mean deleting, and
        // the no-delete rule holds for reverts too.
        revertable: input.kind === "UPDATE",
      },
      select: { id: true },
    });

    return record.id;
  } catch (error) {
    logAiWarn("mutation_record_failed", {
      workspaceId: input.workspaceId,
      userId: input.userId,
      conversationId: input.conversationId,
      feature: "chat",
      toolName: input.toolName,
      success: false,
      errorMessage: error instanceof Error ? error.message : "Failed to record mutation",
    });
    return null;
  }
}

/** Attaches freshly-recorded mutations to the assistant message they belong to. */
export async function attachMutationsToMessage(mutationIds: string[], messageId: string): Promise<void> {
  if (mutationIds.length === 0) return;

  await prisma.aiMutationRecord
    .updateMany({ where: { id: { in: mutationIds } }, data: { messageId } })
    .catch(() => {
      // Anchoring is presentational — the record is still listable without it.
    });
}

export async function listMutationsForConversation(conversationId: string, workspaceId: string) {
  const records = await prisma.aiMutationRecord.findMany({
    where: { conversationId, workspaceId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      messageId: true,
      toolName: true,
      kind: true,
      status: true,
      targetType: true,
      targetId: true,
      targetLabel: true,
      summary: true,
      revertable: true,
      revertError: true,
      createdAt: true,
    },
  });

  return records;
}

/** Marks a change as reviewed-and-kept. Purely bookkeeping — nothing is re-applied. */
export async function acceptMutation(input: {
  mutationId: string;
  workspaceId: string;
  userId: string;
}) {
  const record = await loadPendingMutation(input.mutationId, input.workspaceId);

  const updated = await prisma.aiMutationRecord.update({
    where: { id: record.id },
    data: { status: "ACCEPTED", resolvedAt: new Date(), resolvedById: input.userId },
    select: { id: true, status: true },
  });

  logAiInfo("mutation_accepted", {
    workspaceId: input.workspaceId,
    userId: input.userId,
    feature: "chat",
    toolName: record.toolName,
    success: true,
    metadata: { mutationId: record.id, targetType: record.targetType, targetId: record.targetId },
  });

  return updated;
}

/**
 * Reverts an AI change by restoring the recorded prior values through the same
 * domain services a human edit would use — so workflow rules, notifications,
 * realtime broadcast and activity logging all fire normally for the revert.
 */
export async function revertMutation(input: {
  mutationId: string;
  workspaceId: string;
  userId: string;
  userRole: string;
}) {
  const record = await loadPendingMutation(input.mutationId, input.workspaceId);

  if (!record.revertable) {
    // Rejecting a create: record the user's intent, but do not delete. Point
    // them at the entity so they can remove it themselves if they want to.
    const rejected = await prisma.aiMutationRecord.update({
      where: { id: record.id },
      data: { status: "REJECTED", resolvedAt: new Date(), resolvedById: input.userId },
      select: { id: true, status: true, targetType: true, targetId: true, targetLabel: true },
    });

    return {
      ...rejected,
      reverted: false,
      message: `Marked as rejected. ${record.targetLabel} was created and can't be removed by me — delete it directly in the app if you don't want it.`,
    };
  }

  const beforeState = (record.beforeState ?? {}) as Record<string, unknown>;
  if (Object.keys(beforeState).length === 0) {
    throw new AppError(
      422,
      ERROR_CODES.VALIDATION_ERROR,
      "This change has no recorded previous state, so it can't be undone automatically.",
    );
  }

  try {
    await applyRevert({
      workspaceId: input.workspaceId,
      userId: input.userId,
      userRole: input.userRole,
      targetType: record.targetType,
      targetId: record.targetId,
      beforeState,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Revert failed";
    await prisma.aiMutationRecord
      .update({ where: { id: record.id }, data: { revertError: message } })
      .catch(() => {});

    logAiWarn("mutation_revert_failed", {
      workspaceId: input.workspaceId,
      userId: input.userId,
      feature: "chat",
      toolName: record.toolName,
      success: false,
      errorMessage: message,
      metadata: { mutationId: record.id },
    });

    throw error instanceof AppError
      ? error
      : new AppError(422, ERROR_CODES.VALIDATION_ERROR, `Couldn't undo this change: ${message}`);
  }

  const updated = await prisma.aiMutationRecord.update({
    where: { id: record.id },
    data: { status: "REVERTED", resolvedAt: new Date(), resolvedById: input.userId, revertError: null },
    select: { id: true, status: true, targetType: true, targetId: true, targetLabel: true },
  });

  logAiInfo("mutation_reverted", {
    workspaceId: input.workspaceId,
    userId: input.userId,
    feature: "chat",
    toolName: record.toolName,
    success: true,
    metadata: { mutationId: record.id, targetType: record.targetType, targetId: record.targetId },
  });

  return { ...updated, reverted: true, message: `Undone — ${record.targetLabel} is back to its previous state.` };
}

// ─── Internals ──────────────────────────────────────────────────────────────

async function loadPendingMutation(mutationId: string, workspaceId: string) {
  const record = await prisma.aiMutationRecord.findFirst({
    where: { id: mutationId, workspaceId },
    select: {
      id: true,
      status: true,
      kind: true,
      toolName: true,
      targetType: true,
      targetId: true,
      targetLabel: true,
      beforeState: true,
      revertable: true,
    },
  });

  if (!record) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "That change record no longer exists.");
  }

  if (record.status !== "PENDING") {
    throw new AppError(
      409,
      ERROR_CODES.VALIDATION_ERROR,
      `This change was already ${record.status.toLowerCase()}.`,
    );
  }

  return record;
}

/**
 * Routes a revert to the owning domain service. Deliberately a narrow allowlist
 * rather than a generic Prisma write: reverting through the service keeps
 * workflow validation, notifications and activity logging intact, and an
 * unrecognized target type must fail loudly rather than silently write raw rows.
 */
async function applyRevert(input: {
  workspaceId: string;
  userId: string;
  userRole: string;
  targetType: string;
  targetId: string;
  beforeState: Record<string, unknown>;
}): Promise<void> {
  const { workspaceId, userId, userRole, targetId, beforeState } = input;

  switch (input.targetType) {
    case "ISSUE": {
      const { updateIssue, updateIssueStatus } = await import("../issue/issue.service.js");
      const role = userRole as Parameters<typeof updateIssue>[4];

      // Status is restored through its own service path so transition rules and
      // completedAt bookkeeping are applied exactly as a manual change would be.
      if (typeof beforeState.status === "string") {
        await updateIssueStatus(workspaceId, role!, userId, targetId, beforeState.status);
      }

      const fieldRevert = pickDefined(beforeState, [
        "title",
        "description",
        "priority",
        "type",
        "assigneeId",
        "dueDate",
      ]);

      if (Object.keys(fieldRevert).length > 0) {
        await updateIssue(workspaceId, targetId, userId, fieldRevert as never, role);
      }
      return;
    }

    case "PROJECT": {
      const { updateProject } = await import("../project/project.service.js");
      const fieldRevert = pickDefined(beforeState, [
        "name",
        "description",
        "status",
        "leadId",
        "visibility",
      ]);
      if (Object.keys(fieldRevert).length > 0) {
        await updateProject(workspaceId, targetId, userId, fieldRevert as never);
      }
      return;
    }

    case "TEAM": {
      const { updateTeam } = await import("../team/team.service.js");
      const fieldRevert = pickDefined(beforeState, ["name", "description", "leadId", "visibility", "departmentId"]);
      if (Object.keys(fieldRevert).length > 0) {
        await updateTeam(workspaceId, userRole as never, targetId, fieldRevert as never);
      }
      return;
    }

    default:
      throw new AppError(
        422,
        ERROR_CODES.VALIDATION_ERROR,
        `Undo isn't supported for ${input.targetType.toLowerCase()} changes yet.`,
      );
  }
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}
