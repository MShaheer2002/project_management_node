import type { Socket } from "socket.io";

import { prisma } from "../shared/utils/prisma.js";
import { visibleIssueWhere, visibleProjectWhere, isWorkspaceAdmin, type Viewer } from "../shared/utils/visibility.js";
import type { WorkspaceRole } from "../app/generated/prisma/client.js";

function workspaceRoom(workspaceId: string) {
  return `workspace:${workspaceId}`;
}

function userRoom(userId: string) {
  return `user:${userId}`;
}

function issueRoom(issueId: string) {
  return `issue:${issueId}`;
}

export function projectRoom(projectId: string) {
  return `project:${projectId}`;
}

function socketViewer(socket: Socket): Viewer {
  return {
    userId: String((socket.data as any).userId),
    role: String((socket.data as any).role ?? "GUEST") as WorkspaceRole,
  };
}

export async function joinBaseRooms(socket: Socket) {
  const workspaceId = String((socket.data as any).workspaceId);
  const userId = String((socket.data as any).userId);
  await socket.join(workspaceRoom(workspaceId));
  await socket.join(userRoom(userId));

  // Issue events for PRIVATE projects are delivered to a per-project room
  // instead of the workspace room, which every member is in (F-06 e). Join the
  // private projects this user may see.
  //
  // ponytail: membership is resolved at connect, so a private project created
  //   (or a membership granted) mid-session is not live until the socket
  //   reconnects; issue:join below re-checks and joins on demand. Push a join
  //   from the membership-write path if that lag matters.
  const viewer = socketViewer(socket);
  const projects = await prisma.project.findMany({
    where: { workspaceId, visibility: "PRIVATE", ...visibleProjectWhere(viewer) },
    select: { id: true },
  });
  await Promise.all(projects.map((project) => socket.join(projectRoom(project.id))));
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

      // Workspace membership was the only check, so any GUEST could stream the
      // live comment thread of a private issue (F-06 f).
      const viewer = socketViewer(socket);
      const issue = await prisma.issue.findFirst({
        where: { id: issueId, workspaceId, ...visibleIssueWhere(viewer) },
        select: { id: true, projectId: true },
      });

      if (!issue) {
        ack?.({ ok: false, error: "ISSUE_NOT_FOUND" });
        return;
      }

      await socket.join(issueRoom(issueId));
      // Covers a private project joined after this socket connected.
      if (!isWorkspaceAdmin(viewer.role)) await socket.join(projectRoom(issue.projectId));
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
