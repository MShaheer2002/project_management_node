import { assertIssueVisible, filterUsersWhoCanSeeIssue, type Viewer } from "../../shared/utils/visibility.js";
import type { WorkspaceRole } from "../../app/generated/prisma/client.js";

import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { logActivity } from "../../shared/utils/activity.js";
import { AppError } from "../../shared/utils/api-error.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { prisma } from "../../shared/utils/prisma.js";
import { emitCommentCreated, emitCommentDeleted, emitCommentUpdated } from "../../socket/events.js";
import { getSocketServer } from "../../socket/index.js";
import { isStoredAttachment, resolveAttachmentRefs, storedAttachmentBytes } from "../issue/issue-attachment.service.js";
import { incrementStorageUsage, decrementStorageUsage } from "../billing/billing.service.js";
import { createNotification } from "../notification/notification.service.js";
import type { CreateCommentInput, ListCommentsQuery, UpdateCommentInput } from "./comment.schemas.js";
import { indexEntity } from "../ai/ai.indexer.js";

function mapComment(comment: any) {
  const attachments = (comment.attachments ?? []).map((attachment: any) => ({
    id: attachment.id,
    key: attachment.key,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    size: attachment.size,
    kind: attachment.kind,
    assetUrl: attachment.assetUrl,
    createdAt: attachment.createdAt,
  }));

  return {
    id: comment.id,
    issueId: comment.issueId,
    parentId: comment.parentId,
    body: comment.body,
    attachments,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    author: {
      id: comment.author.id,
      name: comment.author.name,
      email: comment.author.email,
      avatar: comment.author.avatar,
    },
  };
}

async function assertIssueExistsInWorkspace(workspaceId: string, issueId: string) {
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { id: true },
  });

  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }
}

function normalizeMentionToken(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

async function extractMentionedUserIds(workspaceId: string, body: string) {
  const ids = new Set<string>();

  // Preferred explicit formats
  const markdownMention = /@\[([^\]]+)\]\((user_[a-zA-Z0-9]+)\)/g;
  const directMention = /\B@(user_[a-zA-Z0-9]+)\b/g;
  for (const match of body.matchAll(markdownMention)) ids.add(match[2]!);
  for (const match of body.matchAll(directMention)) ids.add(match[1]!);

  // Fallback plain-text format: "@First Last"
  const plainCandidates = new Set<string>();
  const plainMention = /@([A-Za-z][A-Za-z0-9._-]*(?:\s+[A-Za-z][A-Za-z0-9._-]*){0,3})/g;
  for (const match of body.matchAll(plainMention)) {
    const token = normalizeMentionToken(match[1] ?? "");
    if (token) plainCandidates.add(token);
  }

  if (plainCandidates.size > 0) {
    const members = await prisma.workspaceMembership.findMany({
      where: { workspaceId },
      select: {
        userId: true,
        user: { select: { name: true } },
      },
    });

    const memberNameIndex = new Map<string, string[]>();
    for (const member of members) {
      const key = normalizeMentionToken(member.user.name ?? "");
      if (!key) continue;
      const list = memberNameIndex.get(key) ?? [];
      list.push(member.userId);
      memberNameIndex.set(key, list);
    }

    for (const candidate of plainCandidates) {
      const matches = memberNameIndex.get(candidate);
      // Only auto-resolve unambiguous names
      if (matches && matches.length === 1) ids.add(matches[0]!);
    }
  }

  return [...ids];
}

// ─── Mention limits (F-38) ───────────────────────────────────────────────────
// Any role that can comment (GUEST included) could mention everyone in the
// workspace, as often as they liked.

export const MAX_MENTIONS_PER_COMMENT = 20;
export const MENTION_NOTIFICATIONS_PER_HOUR = 100;

/** How many more mention notifications this person may trigger in the current hour. */
async function remainingMentionBudget(workspaceId: string, actorUserId: string) {
  const sent = await prisma.notification.count({
    where: { workspaceId, actorUserId, type: "MENTION", createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
  });
  return Math.max(0, MENTION_NOTIFICATIONS_PER_HOUR - sent);
}

/**
 * People the @-mention picker may suggest on this issue: only those who can
 * open it, so the UI never offers a mention that would be dropped (F-38).
 *
 * Mirrors visibleIssueWhere as a single query (admins and owners always; for a
 * private project also its lead and members). filterUsersWhoCanSeeIssue stays
 * the authority at send time; the e2e test checks the two agree.
 */
export async function listMentionableMembers(
  workspaceId: string,
  viewer: Viewer,
  issueId: string,
  query: { q?: string; limit: number },
) {
  await assertIssueVisible(workspaceId, issueId, viewer);
  const issue = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { projectId: true, project: { select: { visibility: true, leadId: true } } },
  });
  if (!issue) {
    throw new AppError(404, ERROR_CODES.ISSUE_NOT_FOUND, "Issue not found");
  }

  const canSeePrivateProject = [
    { role: { in: ["OWNER", "ADMIN"] as WorkspaceRole[] } },
    ...(issue.project.leadId ? [{ userId: issue.project.leadId }] : []),
    { user: { projectMemberships: { some: { projectId: issue.projectId } } } },
  ];

  const memberships = await prisma.workspaceMembership.findMany({
    where: {
      workspaceId,
      userId: { not: viewer.userId },
      user: {
        deletedAt: null,
        ...(query.q ? { OR: [{ name: { contains: query.q, mode: "insensitive" } }, { email: { contains: query.q, mode: "insensitive" } }] } : {}),
      },
      ...(issue.project.visibility === "PRIVATE" ? { OR: canSeePrivateProject } : {}),
    },
    orderBy: { user: { name: "asc" } },
    take: query.limit,
    select: { role: true, user: { select: { id: true, name: true, email: true } } },
  });

  return memberships.map(({ role, user }) => ({ id: user.id, name: user.name, email: user.email, role }));
}

export async function createComment(workspaceId: string, viewer: Viewer, issueId: string, userId: string, input: CreateCommentInput) {
  // Existence in the workspace was the only gate, so a MEMBER could comment on
  // (and thereby learn about) any private issue (F-07).
  await assertIssueVisible(workspaceId, issueId, viewer);
  await assertIssueExistsInWorkspace(workspaceId, issueId);

  // Refused before anything is stored, so the author can fix the comment.
  // Counted as written (not after the visibility filter below), so the limit
  // doesn't reveal who can see the issue.
  const mentionedUserIds = (await extractMentionedUserIds(workspaceId, input.body)).filter((id) => id !== userId);
  if (mentionedUserIds.length > MAX_MENTIONS_PER_COMMENT) {
    throw new AppError(
      422,
      ERROR_CODES.MENTION_LIMIT_EXCEEDED,
      `You can mention up to ${MAX_MENTIONS_PER_COMMENT} people in one comment.`,
    );
  }

  if (input.parentId) {
    const parent = await prisma.comment.findFirst({
      where: {
        id: input.parentId,
        issueId,
        issue: { workspaceId },
      },
      select: { id: true },
    });

    if (!parent) {
      const parentExists = await prisma.comment.findFirst({
        where: { id: input.parentId, issue: { workspaceId } },
        select: { id: true },
      });

      if (!parentExists) {
        throw new AppError(404, ERROR_CODES.COMMENT_PARENT_NOT_FOUND, "Parent comment not found");
      }

      throw new AppError(409, ERROR_CODES.COMMENT_PARENT_CROSS_ISSUE, "Parent comment belongs to another issue");
    }
  }

  const created = await prisma.comment.create({
    data: {
      issueId,
      authorId: userId,
      body: input.body,
      parentId: input.parentId ?? null,
    },
    include: {
      author: { select: { id: true, name: true, email: true, avatar: true } },
    },
  });

  if (input.attachments && input.attachments.length > 0) {
    const attachments = await resolveAttachmentRefs(prisma, workspaceId, input.attachments as any[]);
    await (prisma as any).commentAttachment.createMany({
      data: attachments.map((attachment: any) => ({
        commentId: created.id,
        workspaceId,
        key: attachment.key,
        fileName: attachment.fileName,
        contentType: attachment.contentType.trim().toLowerCase(),
        size: attachment.size,
        kind: attachment.kind,
        assetUrl: attachment.assetUrl ?? null,
        createdById: userId,
      })),
      skipDuplicates: true,
    });

    await incrementStorageUsage(workspaceId, storedAttachmentBytes(workspaceId, attachments));
  }

  const hydrated = await prisma.comment.findUnique({
    where: { id: created.id },
    include: {
      author: { select: { id: true, name: true, email: true, avatar: true } },
      attachments: { orderBy: [{ createdAt: "desc" }] } as any,
    } as any,
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "COMMENT_CREATED",
    targetType: "COMMENT",
    targetId: created.id,
    message: `Comment added on ${issueId}`,
    metadata: {
      issueId,
      entityId: issueId,
      commentId: created.id,
      parentCommentId: input.parentId ?? null,
      commentExcerpt: input.body.slice(0, 140),
    },
  });

  const issueForNotification = await prisma.issue.findFirst({
    where: { id: issueId, workspaceId },
    select: { id: true, title: true, cycleId: true },
  });
  const issuePublicId = issueForNotification?.id ?? issueId;

  if (input.parentId) {
    const parent = await prisma.comment.findFirst({
      where: { id: input.parentId, issue: { workspaceId } },
      select: { authorId: true },
    });
    // The parent's author may have lost access to this (private) issue since.
    const [replyRecipient] = parent?.authorId && parent.authorId !== userId
      ? await filterUsersWhoCanSeeIssue(workspaceId, issueId, [parent.authorId])
      : [];
    if (parent?.authorId && replyRecipient) {
      await createNotification({
        workspaceId,
        recipientUserId: parent.authorId,
        actorUserId: userId,
        type: "COMMENT_REPLY",
        category: "comment",
        title: "New reply to your comment",
        message: `Someone replied on issue ${issuePublicId}`,
        target: { type: "comment", id: created.id, publicId: issuePublicId, url: `/issues/${issuePublicId}?commentId=${created.id}` },
        metadata: {
          issueId,
          commentId: created.id,
          parentCommentId: input.parentId,
          commentExcerpt: input.body.slice(0, 140),
          workspaceId,
          entityId: issueId,
          entityTitle: issueForNotification?.title ?? null,
          url: `/issues/${issuePublicId}?commentId=${created.id}`,
        },
        eventId: `comment-reply:${created.id}:${parent.authorId}`,
      });
    }
  }

  // Only people who can open the issue are told about it: the notification
  // carries its title and an excerpt of the comment.
  const visibleRecipients = await filterUsersWhoCanSeeIssue(workspaceId, issueId, mentionedUserIds);
  const budget = visibleRecipients.length > 0 ? await remainingMentionBudget(workspaceId, userId) : 0;
  const recipients = visibleRecipients.slice(0, budget);
  if (recipients.length < visibleRecipients.length) {
    console.warn(`[Comment] mention notifications throttled for user ${userId.slice(0, 15)}: ${visibleRecipients.length - recipients.length} skipped`);
  }
  await Promise.all(recipients.map((mentionedUserId) => createNotification({
    workspaceId,
    recipientUserId: mentionedUserId,
    actorUserId: userId,
    type: "MENTION",
    category: "mention",
    title: "You were mentioned in a comment",
    message: `You were mentioned on issue ${issuePublicId}`,
    target: { type: "comment", id: created.id, publicId: issuePublicId, url: `/issues/${issuePublicId}?commentId=${created.id}` },
    metadata: {
      issueId,
      commentId: created.id,
      commentExcerpt: input.body.slice(0, 140),
      mentionedBy: { id: userId },
      workspaceId,
      entityId: issueId,
      entityTitle: issueForNotification?.title ?? null,
      url: `/issues/${issuePublicId}?commentId=${created.id}`,
    },
    eventId: `comment-mention:${created.id}:${mentionedUserId}`,
  })));

  if (issueForNotification?.cycleId) {
    await logActivity({
      workspaceId,
      actorId: userId,
      type: "CYCLE_ISSUE_COMMENT_CREATED",
      targetType: "COMMENT",
      targetId: created.id,
      message: "Comment created on issue in cycle",
      metadata: {
        issueId,
        commentId: created.id,
        cycleId: issueForNotification.cycleId,
        entityId: issueId,
      },
    });
  }

  const mapped = mapComment(hydrated);
  const io = getSocketServer();
  if (io) {
    emitCommentCreated(io, workspaceId, issueId, {
      issueId,
      commentId: created.id,
      full: mapped,
    });
  }


  // Comments carry much of a project's real diagnosis, so they are indexed for
  // semantic search. Scope comes from the parent issue's workspace.
  await indexEntity({
    workspaceId,
    entityType: "COMMENT",
    entityId: created.id,
    reason: "created",
    triggeredByUserId: userId,
  });

  return mapped;
}

export async function listComments(workspaceId: string, viewer: Viewer, issueId: string, query: ListCommentsQuery) {
  // Existence-in-workspace was the only check, so any GUEST could read the
  // comment thread of a private issue by walking sequential keys (F-06 g).
  await assertIssueVisible(workspaceId, issueId, viewer);
  await assertIssueExistsInWorkspace(workspaceId, issueId);

  const limit = clampListLimit(query.limit, 50);
  const where = {
    issueId,
    issue: { workspaceId },
  };

  const [total, records] = await Promise.all([
    prisma.comment.count({ where }),
    prisma.comment.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: limit + 1,
      include: {
        author: { select: { id: true, name: true, email: true, avatar: true } },
        attachments: { orderBy: [{ createdAt: "desc" }] } as any,
      },
    }),
  ]);

  const page = slicePage(records, limit);
  return {
    items: page.items.map((record) => mapComment(record)),
    meta: {
      total,
      cursor: page.hasMore ? page.items[page.items.length - 1]?.id ?? null : null,
      hasMore: page.hasMore,
    },
  };
}

export async function updateComment(workspaceId: string, commentId: string, userId: string, input: UpdateCommentInput) {
  const current = await prisma.comment.findFirst({
    where: {
      id: commentId,
      issue: { workspaceId },
    },
    select: {
      id: true,
      authorId: true,
    },
  });

  if (!current) {
    throw new AppError(404, ERROR_CODES.COMMENT_NOT_FOUND, "Comment not found");
  }

  if (current.authorId !== userId) {
    throw new AppError(403, ERROR_CODES.COMMENT_EDIT_FORBIDDEN, "Only the comment author can edit this comment");
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.comment.update({
      where: { id: current.id },
      data: { body: input.body },
    });

    if (input.attachments && input.attachments.length > 0) {
      const attachments = await resolveAttachmentRefs(tx as any, workspaceId, input.attachments as any[]);
      const existing = await (tx as any).commentAttachment.findMany({
        where: { commentId: current.id },
        select: { key: true },
      });
      const existingKeys = new Set(existing.map((attachment: any) => attachment.key));
      const toAdd = attachments.filter((attachment: any) => !existingKeys.has(attachment.key));
      if (toAdd.length > 0) {
        await (tx as any).commentAttachment.createMany({
          data: toAdd.map((attachment: any) => ({
            commentId: current.id,
            workspaceId,
            key: attachment.key,
            fileName: attachment.fileName,
            contentType: attachment.contentType.trim().toLowerCase(),
            size: attachment.size,
            kind: attachment.kind,
            assetUrl: attachment.assetUrl ?? null,
            createdById: userId,
          })),
          skipDuplicates: true,
        });

        await incrementStorageUsage(workspaceId, storedAttachmentBytes(workspaceId, toAdd));
      }
    }

    return tx.comment.findUnique({
      where: { id: current.id },
      include: {
        author: { select: { id: true, name: true, email: true, avatar: true } },
        attachments: { orderBy: [{ createdAt: "desc" }] } as any,
      } as any,
    });
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "COMMENT_EDITED",
    targetType: "COMMENT",
    targetId: current.id,
    message: "Comment edited",
    metadata: {
      issueId: (updated as any).issueId,
      entityId: (updated as any).issueId,
      commentId: current.id,
      commentExcerpt: input.body.slice(0, 140),
      cycleId: ((await prisma.issue.findFirst({ where: { id: (updated as any).issueId, workspaceId }, select: { cycleId: true } }))?.cycleId) ?? null,
    },
  });

  const mapped = mapComment(updated);
  const io = getSocketServer();
  if (io) {
    emitCommentUpdated(io, workspaceId, (updated as any).issueId, {
      issueId: (updated as any).issueId,
      commentId: current.id,
      full: mapped,
    });
  }


  // Comments carry much of a project's real diagnosis, so they are indexed for
  // semantic search. Scope comes from the parent issue's workspace.
  await indexEntity({
    workspaceId,
    entityType: "COMMENT",
    entityId: commentId,
    reason: "updated",
    triggeredByUserId: userId,
  });

  return mapped;
}

export async function deleteComment(workspaceId: string, commentId: string, userId: string, role: WorkspaceRole) {
  const current = await prisma.comment.findFirst({
    where: {
      id: commentId,
      issue: { workspaceId },
    },
    select: {
      id: true,
      authorId: true,
    },
  });

  if (!current) {
    throw new AppError(404, ERROR_CODES.COMMENT_NOT_FOUND, "Comment not found");
  }

  const canDelete = current.authorId === userId || role === "ADMIN" || role === "OWNER";
  if (!canDelete) {
    throw new AppError(403, ERROR_CODES.COMMENT_DELETE_FORBIDDEN, "You do not have permission to delete this comment");
  }

  const detail = await prisma.comment.findFirst({
    where: { id: current.id, issue: { workspaceId } },
    select: { issueId: true, issue: { select: { cycleId: true } } },
  });
  await prisma.comment.delete({ where: { id: current.id } });
  await logActivity({
    workspaceId,
    actorId: userId,
    type: "COMMENT_DELETED",
    targetType: "COMMENT",
    targetId: current.id,
    message: "Comment deleted",
    metadata: {
      issueId: detail?.issueId ?? null,
      entityId: detail?.issueId ?? null,
      commentId: current.id,
      cycleId: detail?.issue?.cycleId ?? null,
    },
  });

  const io = getSocketServer();
  if (io && detail?.issueId) {
    emitCommentDeleted(io, workspaceId, detail.issueId, {
      issueId: detail?.issueId ?? null,
      commentId: current.id,
    });
  }
}

export async function addCommentAttachments(workspaceId: string, commentId: string, userId: string, attachments: any[]) {
  if (attachments.length === 0) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "At least one attachment is required");
  }

  const comment = await prisma.comment.findFirst({
    where: { id: commentId, issue: { workspaceId } },
    select: { id: true, authorId: true },
  });
  if (!comment) {
    throw new AppError(404, ERROR_CODES.COMMENT_NOT_FOUND, "Comment not found");
  }

  // Adding an attachment is editing the comment, so it follows updateComment's
  // rule: author only. Without this any GUEST could append misleading files to
  // an admin's comment (F-10).
  if (comment.authorId !== userId) {
    throw new AppError(403, ERROR_CODES.COMMENT_EDIT_FORBIDDEN, "Only the comment author can attach files to this comment");
  }

  attachments = await resolveAttachmentRefs(prisma, workspaceId, attachments);
  await (prisma as any).commentAttachment.createMany({
    data: attachments.map((attachment: any) => ({
      commentId,
      workspaceId,
      key: attachment.key,
      fileName: attachment.fileName,
      contentType: attachment.contentType.trim().toLowerCase(),
      size: attachment.size,
      kind: attachment.kind,
      assetUrl: attachment.assetUrl ?? null,
      createdById: userId,
    })),
    skipDuplicates: true,
  });

  await incrementStorageUsage(workspaceId, storedAttachmentBytes(workspaceId, attachments));

  const updated = await prisma.comment.findUnique({
    where: { id: commentId },
    include: {
      author: { select: { id: true, name: true, email: true, avatar: true } },
      attachments: { orderBy: [{ createdAt: "desc" }] } as any,
    } as any,
  });

  return mapComment(updated);
}

export async function removeCommentAttachment(
  workspaceId: string,
  commentId: string,
  attachmentId: string,
  userId: string,
  role: WorkspaceRole,
) {
  const attachment = await (prisma as any).commentAttachment.findFirst({
    where: { id: attachmentId, commentId, workspaceId },
    select: { id: true, size: true, key: true, comment: { select: { authorId: true } } },
  });

  if (!attachment) {
    throw new AppError(404, ERROR_CODES.COMMENT_ATTACHMENT_NOT_FOUND, "Comment attachment not found");
  }

  // Removing content follows deleteComment's rule: author or workspace admin.
  // Previously any GUEST could delete evidence off someone else's comment (F-10).
  const canRemove = attachment.comment?.authorId === userId || role === "ADMIN" || role === "OWNER";
  if (!canRemove) {
    throw new AppError(403, ERROR_CODES.COMMENT_DELETE_FORBIDDEN, "You do not have permission to remove this attachment");
  }

  await (prisma as any).commentAttachment.delete({ where: { id: attachmentId } });
  if (isStoredAttachment(workspaceId, attachment.key)) await decrementStorageUsage(workspaceId, attachment.size);
}
