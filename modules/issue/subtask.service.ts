import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { runSubtaskCompletionAutomation } from "../../shared/workflow/workflow-automation-runtime.js";
import { visibleIssueWhere, type Viewer } from "../../shared/utils/visibility.js";

/**
 * Subtask writes are issue writes: they can flip an issue's status through the
 * subtask-completion automation. Existence in the workspace was the only check,
 * so any MEMBER could add or complete subtasks on an issue in a private project
 * they are not a member of (F-21).
 */
async function assertIssueWritable(workspaceId: string, viewer: Viewer, issueId: string) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId, ...visibleIssueWhere(viewer) },
    select: { id: true },
  });

  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }
}

export async function createSubtask(
  workspaceId: string,
  viewer: Viewer,
  issueId: string,
  input: { title: string; order?: number },
) {
  await assertIssueWritable(workspaceId, viewer, issueId);

  const subtask = await prisma.issueSubtask.create({
    data: {
      issueId,
      title: input.title,
      order: input.order ?? 0,
    },
  });

  return subtask;
}

export async function updateSubtask(
  workspaceId: string,
  viewer: Viewer,
  issueId: string,
  subtaskId: string,
  actorUserId: string,
  input: { title?: string; completed?: boolean; order?: number },
) {
  await assertIssueWritable(workspaceId, viewer, issueId);

  const existing = await prisma.issueSubtask.findFirst({
    where: { id: subtaskId, issueId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError(404, ERROR_CODES.SUBTASK_NOT_FOUND, "Subtask not found");
  }

  const subtask = await prisma.issueSubtask.update({
    where: { id: subtaskId },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.completed !== undefined ? { completed: input.completed } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
    },
  });

  if (input.completed !== undefined) {
    await runSubtaskCompletionAutomation(workspaceId, issueId, actorUserId);
  }

  return subtask;
}

export async function deleteSubtask(workspaceId: string, viewer: Viewer, issueId: string, subtaskId: string) {
  await assertIssueWritable(workspaceId, viewer, issueId);

  const existing = await prisma.issueSubtask.findFirst({
    where: { id: subtaskId, issueId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError(404, ERROR_CODES.SUBTASK_NOT_FOUND, "Subtask not found");
  }

  await prisma.issueSubtask.delete({ where: { id: subtaskId } });
}

export async function reorderSubtasks(
  workspaceId: string,
  viewer: Viewer,
  issueId: string,
  items: Array<{ id: string; order: number }>,
) {
  await assertIssueWritable(workspaceId, viewer, issueId);

  await prisma.$transaction(
    items.map((item) =>
      prisma.issueSubtask.updateMany({
        where: { id: item.id, issueId },
        data: { order: item.order },
      })),
  );

  return prisma.issueSubtask.findMany({
    where: { issueId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
}
