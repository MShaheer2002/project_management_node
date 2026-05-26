import type { Socket } from "socket.io";
import { verifyToken } from "@clerk/express";

import { env } from "../config/env.js";
import { prisma } from "../shared/utils/prisma.js";

export type SocketAuthContext = {
  userId: string;
  workspaceId: string;
  role: string;
};

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
      select: { role: true },
    });

    if (!membership) {
      console.warn(`[socket] auth rejected: user ${userId.slice(0, 15)} not in workspace ${auth.workspaceId.slice(0, 8)}`);
      return next(new Error("FORBIDDEN"));
    }

    (socket.data as any).userId = userId;
    (socket.data as any).workspaceId = auth.workspaceId;
    (socket.data as any).role = membership.role;

    console.log(
      `[socket] authenticated user:${userId.slice(0, 15)} ws:${auth.workspaceId.slice(0, 8)} role:${membership.role}`,
    );
    return next();
  } catch {
    console.warn("[socket] auth rejected: token verification failed");
    return next(new Error("UNAUTHORIZED"));
  }
}
