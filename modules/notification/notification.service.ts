import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import { clampListLimit, slicePage } from "../../shared/utils/pagination.js";
import { prisma } from "../../shared/utils/prisma.js";
import type {
  ListNotificationsQuery,
  MarkNotificationReadInput,
  MarkNotificationsReadInput,
} from "./notification.schemas.js";

type NotificationCategory = "mention" | "assignment" | "update" | "membership" | "comment";
type NotificationTargetType = "issue" | "comment" | "project" | "team" | "workspace";

type CreateNotificationInput = {
  workspaceId: string;
  recipientUserId: string;
  actorUserId?: string | null;
  type: string;
  category: NotificationCategory;
  title: string;
  message: string;
  target: {
    type: NotificationTargetType;
    id: string;
    publicId?: string | null;
    url: string;
  };
  metadata?: Record<string, unknown>;
  eventId?: string;
  dedupeKey?: string;
};

type DeliveryPayload = {
  notification: ReturnType<typeof mapNotification>;
  unread: number;
};

type DeliveryHandler = (recipientUserId: string, payload: DeliveryPayload) => Promise<void> | void;
type ReadDeliveryHandler = (
  recipientUserId: string,
  payload: { workspaceId: string; id: string; readAt: Date | null },
) => Promise<void> | void;
type ReadAllDeliveryHandler = (
  recipientUserId: string,
  payload: { workspaceId: string; updated: number; readAt: Date },
) => Promise<void> | void;

let deliveryHandler: DeliveryHandler | null = null;
let readDeliveryHandler: ReadDeliveryHandler | null = null;
let readAllDeliveryHandler: ReadAllDeliveryHandler | null = null;

export function setNotificationDeliveryHandler(handler: DeliveryHandler) {
  deliveryHandler = handler;
}

export function setNotificationReadDeliveryHandler(handler: ReadDeliveryHandler) {
  readDeliveryHandler = handler;
}

export function setNotificationReadAllDeliveryHandler(handler: ReadAllDeliveryHandler) {
  readAllDeliveryHandler = handler;
}

function parseCsv(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  const values = input.split(",").map((v) => v.trim()).filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function mapNotification(item: any) {
  return {
    id: item.id,
    type: item.type,
    category: item.category,
    title: item.title,
    message: item.message,
    createdAt: item.createdAt,
    readAt: item.readAt,
    actor: item.actor
      ? {
          id: item.actor.id,
          name: item.actor.name,
          email: item.actor.email,
          avatar: item.actor.avatar,
        }
      : undefined,
    target: {
      type: item.targetType.toLowerCase(),
      id: item.targetId,
      publicId: item.targetPublicId ?? undefined,
      url: item.targetUrl,
    },
    metadata: item.metadata ?? undefined,
  };
}

export async function listNotifications(workspaceId: string, userId: string, query: ListNotificationsQuery) {
  const limit = clampListLimit(query.limit, 30);
  const types = parseCsv(query.types);
  const search = query.q?.trim();

  const where: any = {
    workspaceId,
    recipientUserId: userId,
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { targetPublicId: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(query.unreadOnly ? { readAt: null } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(types ? { type: { in: types as any } } : {}),
    ...(query.actorId ? { actorUserId: query.actorId } : {}),
    ...(query.targetType ? { targetType: query.targetType.toUpperCase() } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          },
        }
      : {}),
  };

  const records = await (prisma as any).notification.findMany({
    where,
    include: {
      actor: { select: { id: true, name: true, email: true, avatar: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    take: limit + 1,
  });

  const page = slicePage(records, limit);
  return {
    items: page.items.map(mapNotification),
    meta: {
      nextCursor: page.hasMore ? (page.items[page.items.length - 1] as any)?.id ?? null : null,
      hasMore: page.hasMore,
    },
  };
}

export async function getUnreadCount(workspaceId: string, userId: string) {
  const unread = await (prisma as any).notification.count({
    where: {
      workspaceId,
      recipientUserId: userId,
      readAt: null,
    },
  });
  return { unread };
}

export async function markRead(workspaceId: string, userId: string, id: string, input?: MarkNotificationReadInput) {
  const existing = await (prisma as any).notification.findFirst({
    where: { id, workspaceId, recipientUserId: userId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Notification not found");
  }

  const shouldRead = input?.read ?? true;
  const readAt = shouldRead ? new Date() : null;

  const updated = await (prisma as any).notification.update({
    where: { id },
    data: { readAt },
    select: { id: true, readAt: true },
  });

  if (readDeliveryHandler) {
    await Promise.resolve(readDeliveryHandler(userId, { workspaceId, ...updated }));
  }

  return updated;
}

export async function markAllRead(workspaceId: string, userId: string) {
  const now = new Date();
  const result = await (prisma as any).notification.updateMany({
    where: { workspaceId, recipientUserId: userId, readAt: null },
    data: { readAt: now },
  });

  if (readAllDeliveryHandler) {
    await Promise.resolve(readAllDeliveryHandler(userId, { workspaceId, updated: result.count, readAt: now }));
  }

  return { updated: result.count, readAt: now };
}

export async function markBatchRead(workspaceId: string, userId: string, input: MarkNotificationsReadInput) {
  const result = await (prisma as any).notification.updateMany({
    where: {
      workspaceId,
      recipientUserId: userId,
      id: { in: input.ids },
      readAt: null,
    },
    data: { readAt: new Date() },
  });

  return { updated: result.count };
}

export async function createNotification(input: CreateNotificationInput) {
  if (input.actorUserId && input.actorUserId === input.recipientUserId) {
    return null;
  }

  const membership = await prisma.workspaceMembership.findUnique({
    where: {
      userId_workspaceId: {
        userId: input.recipientUserId,
        workspaceId: input.workspaceId,
      },
    },
    select: { userId: true },
  });

  if (!membership) {
    return null;
  }

  const dedupeKey = input.dedupeKey ?? (input.eventId ? `${input.type}:${input.eventId}:${input.recipientUserId}` : null);

  const createData = {
      workspaceId: input.workspaceId,
      recipientUserId: input.recipientUserId,
      actorUserId: input.actorUserId ?? null,
      type: input.type as any,
      category: input.category,
      title: input.title,
      message: input.message,
      targetType: input.target.type.toUpperCase(),
      targetId: input.target.id,
      targetPublicId: input.target.publicId ?? null,
      targetUrl: input.target.url,
      metadata: (input.metadata ?? {}) as any,
      eventId: input.eventId ?? null,
      dedupeKey,
    };

  const notification = dedupeKey
    ? await (prisma as any).notification.upsert({
        where: {
          workspaceId_recipientUserId_dedupeKey: {
            workspaceId: input.workspaceId,
            recipientUserId: input.recipientUserId,
            dedupeKey,
          },
        },
        create: createData,
        update: {},
        include: {
          actor: { select: { id: true, name: true, email: true, avatar: true } },
        },
      })
    : await (prisma as any).notification.create({
        data: createData,
        include: {
          actor: { select: { id: true, name: true, email: true, avatar: true } },
        },
      });

  const unread = await (prisma as any).notification.count({
    where: {
      workspaceId: input.workspaceId,
      recipientUserId: input.recipientUserId,
      readAt: null,
    },
  });

  if (deliveryHandler) {
    await Promise.resolve(deliveryHandler(input.recipientUserId, {
      notification: mapNotification(notification),
      unread,
    }));
  }

  return mapNotification(notification);
}

export async function createProjectMembershipNotification(params: {
  workspaceId: string;
  recipientUserId: string;
  actorUserId: string;
  projectId: string;
  projectName: string;
  action: "added" | "removed";
}) {
  const member = await prisma.user.findUnique({
    where: { id: params.recipientUserId },
    select: { id: true, name: true, email: true },
  });

  if (!member) return null;

  return createNotification({
    workspaceId: params.workspaceId,
    recipientUserId: params.recipientUserId,
    actorUserId: params.actorUserId,
    type: "PROJECT_MEMBER",
    category: "membership",
    title: params.action === "added" ? "Added to project" : "Removed from project",
    message: params.action === "added"
      ? `You were added to project ${params.projectName}`
      : `You were removed from project ${params.projectName}`,
    target: {
      type: "project",
      id: params.projectId,
      url: `/projects/${params.projectId}`,
    },
    metadata: {
      projectId: params.projectId,
      member,
      action: params.action,
      workspaceId: params.workspaceId,
      entityId: params.projectId,
      entityTitle: params.projectName,
      url: `/projects/${params.projectId}`,
    },
    eventId: `${params.projectId}:${params.action}:${params.recipientUserId}`,
  });
}
