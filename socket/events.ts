import type { Server } from "socket.io";

import { createRealtimeEnvelope } from "./serializers.js";
import { prisma } from "../shared/utils/prisma.js";
import { projectRoom } from "./rooms.js";

/**
 * Where an issue event may be broadcast.
 *
 * Issue payloads carry the full mapped issue (description, attachment keys,
 * watcher emails). The workspace room holds every member including GUESTs, so
 * events for a PRIVATE project go to that project's room instead — only members
 * of that project are in it (F-06 e).
 */
async function issueEventRoom(workspaceId: string, projectId: string | null | undefined): Promise<string> {
  if (!projectId) return `workspace:${workspaceId}`;
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    select: { visibility: true },
  });
  return project?.visibility === "PRIVATE" ? projectRoom(projectId) : `workspace:${workspaceId}`;
}

export async function emitIssueCreated(
  io: Server,
  workspaceId: string,
  payload: Record<string, unknown>,
  projectId?: string | null,
) {
  const envelope = createRealtimeEnvelope({
    type: "issue:created",
    workspaceId,
    payload,
  });
  io.to(await issueEventRoom(workspaceId, projectId)).emit("issue:created", envelope);
}

export async function emitIssueUpdated(
  io: Server,
  workspaceId: string,
  payload: Record<string, unknown>,
  projectId?: string | null,
) {
  const envelope = createRealtimeEnvelope({
    type: "issue:updated",
    workspaceId,
    payload,
  });
  io.to(await issueEventRoom(workspaceId, projectId)).emit("issue:updated", envelope);
}

export async function emitIssueDeleted(
  io: Server,
  workspaceId: string,
  payload: Record<string, unknown>,
  projectId?: string | null,
) {
  const envelope = createRealtimeEnvelope({
    type: "issue:deleted",
    workspaceId,
    payload,
  });
  io.to(await issueEventRoom(workspaceId, projectId)).emit("issue:deleted", envelope);
}

export function emitCommentCreated(io: Server, workspaceId: string, issueId: string, payload: Record<string, unknown>) {
  const envelope = createRealtimeEnvelope({
    type: "comment:created",
    workspaceId,
    payload,
  });
  io.to(`issue:${issueId}`).emit("comment:created", envelope);
}

export function emitCommentUpdated(io: Server, workspaceId: string, issueId: string, payload: Record<string, unknown>) {
  const envelope = createRealtimeEnvelope({
    type: "comment:updated",
    workspaceId,
    payload,
  });
  io.to(`issue:${issueId}`).emit("comment:updated", envelope);
}

export function emitCommentDeleted(io: Server, workspaceId: string, issueId: string, payload: Record<string, unknown>) {
  const envelope = createRealtimeEnvelope({
    type: "comment:deleted",
    workspaceId,
    payload,
  });
  io.to(`issue:${issueId}`).emit("comment:deleted", envelope);
}
