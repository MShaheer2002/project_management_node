import type { RequestHandler } from "express";

import * as notificationService from "./notification.service.js";
import type {
  ListNotificationsQuery,
  MarkNotificationReadInput,
  MarkNotificationsReadInput,
} from "./notification.schemas.js";

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await notificationService.listNotifications(
      req.workspace!.id,
      req.user!.id,
      (req.validated?.query ?? req.query) as ListNotificationsQuery,
    );

    res.status(200).json({
      success: true,
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    next(error);
  }
};

export const unreadCount: RequestHandler = async (req, res, next) => {
  try {
    const result = await notificationService.getUnreadCount(req.workspace!.id, req.user!.id);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const markRead: RequestHandler = async (req, res, next) => {
  try {
    const updated = await notificationService.markRead(
      req.workspace!.id,
      req.user!.id,
      req.params.id as string,
      (req.validated?.body ?? req.body) as MarkNotificationReadInput,
    );

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

export const markAllRead: RequestHandler = async (req, res, next) => {
  try {
    const result = await notificationService.markAllRead(req.workspace!.id, req.user!.id);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const markBatchRead: RequestHandler = async (req, res, next) => {
  try {
    const result = await notificationService.markBatchRead(
      req.workspace!.id,
      req.user!.id,
      (req.validated?.body ?? req.body) as MarkNotificationsReadInput,
    );

    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
