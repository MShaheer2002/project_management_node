import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./notification.controller.js";
import {
  listNotificationsSchema,
  markNotificationReadSchema,
  markNotificationsReadSchema,
} from "./notification.schemas.js";

const router = Router();

router.get("/notifications", authenticate, validate(listNotificationsSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.list);
router.get("/notifications/unread-count", authenticate, requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.unreadCount);
router.patch("/notifications/:id/read", authenticate, validate(markNotificationReadSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.markRead);
router.patch("/notifications/read-all", authenticate, requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.markAllRead);
router.patch("/notifications/read", authenticate, validate(markNotificationsReadSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.markBatchRead);

export default router;
