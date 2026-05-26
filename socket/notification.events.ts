import type { Server } from "socket.io";

import {
  setNotificationDeliveryHandler,
  setNotificationReadAllDeliveryHandler,
  setNotificationReadDeliveryHandler,
} from "../modules/notification/notification.service.js";
import { createRealtimeEnvelope, notificationUiMeta } from "./serializers.js";

export function registerNotificationEvents(io: Server) {
  setNotificationDeliveryHandler(async (recipientUserId, payload) => {
    const notification = payload.notification as any;

    const envelope = createRealtimeEnvelope({
      type: "notification:created",
      workspaceId: String(notification.metadata?.workspaceId ?? ""),
      dedupeKey: `${notification.id}:${recipientUserId}`,
      payload: {
        notification,
        unread: payload.unread,
        ui: notificationUiMeta(notification.type),
      },
    });

    io.to(`user:${recipientUserId}`).emit("notification:created", envelope);
  });

  setNotificationReadDeliveryHandler(async (recipientUserId, payload) => {
    const envelope = createRealtimeEnvelope({
      type: "notification:read",
      workspaceId: payload.workspaceId,
      payload,
    });

    io.to(`user:${recipientUserId}`).emit("notification:read", envelope);
  });

  setNotificationReadAllDeliveryHandler(async (recipientUserId, payload) => {
    const envelope = createRealtimeEnvelope({
      type: "notification:read-all",
      workspaceId: payload.workspaceId,
      payload,
    });

    io.to(`user:${recipientUserId}`).emit("notification:read-all", envelope);
  });
}
