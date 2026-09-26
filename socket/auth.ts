import type { Socket } from "socket.io";
import { verifyToken } from "@clerk/express";

import { env } from "../config/env.js";
import { prisma } from "../shared/utils/prisma.js";

export type SocketAuthContext = {
  userId: string;
  workspaceId: string;
  role: string;
};

/**
 * How often a live socket re-checks that its session is still valid.
 *
 * Authorization used to be evaluated once, at connect. A socket is long-lived
 * and receives pushed broadcasts without ever sending anything, so a member who
 * was removed from the workspace — or whose token expired, or who was demoted —
 * kept receiving issue payloads until they happened to disconnect (F-17).
 *
 * ponytail: one timer per socket, which is fine at this scale. If socket counts
 *   grow, replace with a single sweep over io.sockets on one shared interval.
 */
const REVALIDATE_INTERVAL_MS = 60_000;

type NextFn = (err?: Error) => void;

export async function socketAuth(socket: Socket, next: NextFn) {
  try {
    const auth = socket.handshake.auth as { token?: string; workspaceId?: string };
    if (!auth?.token || !auth?.workspaceId) {
      console.warn("[socket] auth rejected: missing token/workspaceId");
      return next(new Error("UNAUTHORIZED"));
    }

    const verified = await verifyToken(auth.token, {
      secretKey: env.CLERK_SECRET_KEY,
    });

    const userId = String((verified as any)?.sub ?? "");
    if (!userId) {
      console.warn("[socket] auth rejected: invalid token subject");
      return next(new Error("UNAUTHORIZED"));
    }

    const membership = await prisma.workspaceMembership.findUnique({
      where: {
        userId_workspaceId: {
          userId,
          workspaceId: auth.workspaceId,
        },
      },
      select: { role: true, workspace: { select: { deactivatedAt: true } } },
    });

    if (!membership) {
      console.warn(`[socket] auth rejected: user ${userId.slice(0, 15)} not in workspace ${auth.workspaceId.slice(0, 8)}`);
      return next(new Error("FORBIDDEN"));
    }

    // Soft-deleted workspace: nobody gets live updates, OWNER included.
    if (membership.workspace.deactivatedAt) {
      return next(new Error("WORKSPACE_DEACTIVATED"));
    }

    (socket.data as any).userId = userId;
    (socket.data as any).workspaceId = auth.workspaceId;
    (socket.data as any).role = membership.role;
    // Seconds since epoch, per JWT. Used by the revalidation loop below.
    (socket.data as any).tokenExp = typeof (verified as any)?.exp === "number" ? (verified as any).exp : null;

    console.log(
      `[socket] authenticated user:${userId.slice(0, 15)} ws:${auth.workspaceId.slice(0, 8)} role:${membership.role}`,
    );
    return next();
  } catch {
    console.warn("[socket] auth rejected: token verification failed");
    return next(new Error("UNAUTHORIZED"));
  }
}

/**
 * Keep re-checking a connected socket's authorization until it fails.
 *
 * On any change — token expired, membership gone, role changed — the socket is
 * disconnected rather than patched in place. The client reconnects and runs the
 * full handshake, so room membership is rebuilt from current data instead of
 * being partially repaired here (private-project rooms are joined at connect;
 * see rooms.ts).
 */
export function startSessionRevalidation(socket: Socket, intervalMs = REVALIDATE_INTERVAL_MS) {
  const userId = String((socket.data as any).userId ?? "");
  const workspaceId = String((socket.data as any).workspaceId ?? "");
  const role = String((socket.data as any).role ?? "");

  const drop = (reason: string) => {
    console.warn(`[socket] revoking id:${socket.id} user:${userId.slice(0, 15)} reason:${reason}`);
    socket.emit("session:revoked", { reason });
    socket.disconnect(true);
  };

  const timer = setInterval(() => {
    void (async () => {
      const exp = (socket.data as any).tokenExp as number | null;
      if (exp !== null && Date.now() >= exp * 1000) {
        return drop("TOKEN_EXPIRED");
      }

      try {
        const membership = await prisma.workspaceMembership.findUnique({
          where: { userId_workspaceId: { userId, workspaceId } },
          select: { role: true, workspace: { select: { deactivatedAt: true } } },
        });

        if (!membership) return drop("MEMBERSHIP_REVOKED");
        if (membership.role !== role) return drop("ROLE_CHANGED");
        if (membership.workspace.deactivatedAt) return drop("WORKSPACE_DEACTIVATED");
      } catch (error) {
        // A transient DB error must not disconnect a legitimate user; the next
        // tick re-checks. Failing open here is bounded by the interval.
        console.warn(`[socket] revalidation check failed for id:${socket.id}`, error);
      }
    })();
  }, intervalMs);

  // Node keeps the process alive for pending timers otherwise.
  timer.unref?.();
  socket.on("disconnect", () => clearInterval(timer));
}
