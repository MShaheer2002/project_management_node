import type { Server as HttpServer } from "node:http";

import { Server } from "socket.io";

import { env } from "../config/env.js";
import { registerNotificationEvents } from "./notification.events.js";
import { socketAuth } from "./auth.js";
import { joinBaseRooms, registerRoomHandlers } from "./rooms.js";

let ioInstance: Server | null = null;

function isAllowedOrigin(origin: string | undefined) {
  if (!origin) return true;
  return (
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:") ||
    /^http:\/\/192\.168\.\d+\.\d+:\d+$/.test(origin) ||
    origin.endsWith(".ngrok-free.dev") ||
    origin === env.FRONTEND_URL
  );
}

export function initializeSocket(httpServer: HttpServer) {
  if (ioInstance) return ioInstance;

  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
      credentials: true,
      methods: ["GET", "POST"],
      allowedHeaders: ["Authorization", "X-Workspace-Id", "Content-Type"],
    },
    transports: ["websocket", "polling"],
  });

  io.use(socketAuth);

  io.on("connection", async (socket) => {
    await joinBaseRooms(socket);
    registerRoomHandlers(socket);

    const userId = String((socket.data as any).userId ?? "");
    const workspaceId = String((socket.data as any).workspaceId ?? "");
    console.log(
      `[socket] connected id:${socket.id} user:${userId.slice(0, 15)} ws:${workspaceId.slice(0, 8)}`,
    );

    socket.on("disconnect", (reason) => {
      console.log(
        `[socket] disconnected id:${socket.id} user:${userId.slice(0, 15)} reason:${reason}`,
      );
    });
  });

  registerNotificationEvents(io);
  ioInstance = io;

  return io;
}

export function getSocketServer() {
  return ioInstance;
}
