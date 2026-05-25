import { Router } from "express";

import { authenticate } from "../../shared/middleware/authenticate.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./comment.controller.js";
import {
  createCommentAttachmentsSchema,
  createCommentSchema,
  deleteCommentAttachmentParamsSchema,
  deleteCommentSchema,
  listCommentsSchema,
  updateCommentSchema,
} from "./comment.schemas.js";

const router = Router();

router.post("/issues/:id/comments", authenticate, validate(createCommentSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.create);
router.get("/issues/:id/comments", authenticate, validate(listCommentsSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.listByIssue);
router.patch("/comments/:id", authenticate, validate(updateCommentSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.update);
router.delete("/comments/:id", authenticate, validate(deleteCommentSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.remove);
router.post("/comments/:id/attachments", authenticate, validate(createCommentAttachmentsSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.addAttachments);
router.delete("/comments/:id/attachments/:attachmentId", authenticate, validate(deleteCommentAttachmentParamsSchema), requireWorkspace, requireRole("GUEST", "MEMBER", "ADMIN", "OWNER"), controller.removeAttachment);

export default router;
