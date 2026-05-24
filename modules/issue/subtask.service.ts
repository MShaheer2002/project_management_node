import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";

async function assertIssueExists(workspaceId: string, issueId: string) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { id: true },
  });

  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }
}

export async function createSubtask(
  workspaceId: string,
  issueId: string,
  input: { title: string; order?: number },
) {
  await assertIssueExists(workspaceId, issueId);

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
  issueId: string,
  subtaskId: string,
  input: { title?: string; completed?: boolean; order?: number },
) {
  await assertIssueExists(workspaceId, issueId);

  const existing = await prisma.issueSubtask.findFirst({
    where: { id: subtaskId, issueId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError(404, ERROR_CODES.SUBTASK_NOT_FOUND, "Subtask not found");
  }

  return prisma.issueSubtask.update({
    where: { id: subtaskId },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.completed !== undefined ? { completed: input.completed } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
    },
  });
}

export async function deleteSubtask(workspaceId: string, issueId: string, subtaskId: string) {
  await assertIssueExists(workspaceId, issueId);

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
  issueId: string,
  items: Array<{ id: string; order: number }>,
) {
  await assertIssueExists(workspaceId, issueId);

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
