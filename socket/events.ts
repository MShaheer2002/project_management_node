import type { Server } from "socket.io";

import { createRealtimeEnvelope } from "./serializers.js";

export function emitIssueCreated(io: Server, workspaceId: string, payload: Record<string, unknown>) {
  const envelope = createRealtimeEnvelope({
    type: "issue:created",
    workspaceId,
    payload,
  });
  io.to(`workspace:${workspaceId}`).emit("issue:created", envelope);
}

export function emitIssueUpdated(io: Server, workspaceId: string, payload: Record<string, unknown>) {
  const envelope = createRealtimeEnvelope({
    type: "issue:updated",
    workspaceId,
    payload,
  });
  io.to(`workspace:${workspaceId}`).emit("issue:updated", envelope);
}

export function emitIssueDeleted(io: Server, workspaceId: string, payload: Record<string, unknown>) {
  const envelope = createRealtimeEnvelope({
    type: "issue:deleted",
    workspaceId,
    payload,
  });
  io.to(`workspace:${workspaceId}`).emit("issue:deleted", envelope);
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
