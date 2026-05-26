import type { Socket } from "socket.io";

import { prisma } from "../shared/utils/prisma.js";

function workspaceRoom(workspaceId: string) {
  return `workspace:${workspaceId}`;
}

function userRoom(userId: string) {
  return `user:${userId}`;
}

function issueRoom(issueId: string) {
  return `issue:${issueId}`;
}

export async function joinBaseRooms(socket: Socket) {
  const workspaceId = String((socket.data as any).workspaceId);
  const userId = String((socket.data as any).userId);
  await socket.join(workspaceRoom(workspaceId));
  await socket.join(userRoom(userId));
}

export function registerRoomHandlers(socket: Socket) {
  socket.on("issue:join", async (payload: { issueId?: string }, ack?: (resp: { ok: boolean; error?: string }) => void) => {
    try {
      const issueId = payload?.issueId;
      const workspaceId = String((socket.data as any).workspaceId);
      if (!issueId) {
        ack?.({ ok: false, error: "ISSUE_ID_REQUIRED" });
        return;
      }

      const issue = await prisma.issue.findFirst({
        where: { id: issueId, workspaceId },
        select: { id: true },
      });

      if (!issue) {
        ack?.({ ok: false, error: "ISSUE_NOT_FOUND" });
        return;
      }

      await socket.join(issueRoom(issueId));
      ack?.({ ok: true });
    } catch {
      ack?.({ ok: false, error: "JOIN_FAILED" });
    }
  });

  socket.on("issue:leave", async (payload: { issueId?: string }, ack?: (resp: { ok: boolean }) => void) => {
    const issueId = payload?.issueId;
    if (issueId) await socket.leave(issueRoom(issueId));
    ack?.({ ok: true });
  });
}

export const rooms = {
  workspaceRoom,
  userRoom,
  issueRoom,
};
