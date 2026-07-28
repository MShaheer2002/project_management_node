import { Router } from "express";

import { authenticateDual as authenticate } from "../../shared/middleware/authenticate-dual.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireWorkspace } from "../../shared/middleware/require-workspace.js";
import { validate } from "../../shared/middleware/validate.js";
import * as controller from "./issue.controller.js";
import {
  addDependencySchema,
  addWatchersSchema,
  checkAssignmentEligibilitySchema,
  createIssueAttachmentsSchema,
  createIssueSchema,
  createSubtaskSchema,
  deleteIssueAttachmentParamsSchema,
  deleteSubtaskParamsSchema,
  issueIdParamsSchema,
  listIssuesSchema,
  listWatchersSchema,
  removeDependencyParamsSchema,
  removeWatcherParamsSchema,
  reorderSubtasksSchema,
  updateIntegrationRefSchema,
  updateIssueSchema,
  updateIssueStatusSchema,
  updateSubtaskSchema,
} from "./issue.schemas.js";

const router = Router();

router.post("/", authenticate, validate(createIssueSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.create);
router.post("/assignment-eligibility", authenticate, validate(checkAssignmentEligibilitySchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.checkAssignmentEligibility);
router.get("/", authenticate, validate(listIssuesSchema), requireWorkspace, controller.list);
// Must be registered before "/:id" — otherwise Express would match "status-counts" as an :id.
router.get("/status-counts", authenticate, requireWorkspace, controller.getStatusCounts);
router.get("/:id", authenticate, validate(issueIdParamsSchema), requireWorkspace, controller.getById);
router.patch("/:id", authenticate, validate(updateIssueSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.update);
router.delete("/:id", authenticate, validate(issueIdParamsSchema), requireWorkspace, requireRole("ADMIN", "OWNER"), controller.remove);
router.patch("/:id/status", authenticate, validate(updateIssueStatusSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.updateStatus);

router.get("/:id/approvals", authenticate, validate(issueIdParamsSchema), requireWorkspace, controller.getApprovalStatus);
router.post("/:id/approvals", authenticate, validate(issueIdParamsSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.approveStatus);
router.delete("/:id/approvals", authenticate, validate(issueIdParamsSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.revokeApproval);

router.post("/:id/subtasks", authenticate, validate(createSubtaskSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.createSubtask);
router.patch("/:id/subtasks/:sid", authenticate, validate(updateSubtaskSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.updateSubtask);
router.delete("/:id/subtasks/:sid", authenticate, validate(deleteSubtaskParamsSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.deleteSubtask);
router.patch("/:id/subtasks/reorder", authenticate, validate(reorderSubtasksSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.reorderSubtasks);

router.post("/:id/attachments", authenticate, validate(createIssueAttachmentsSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.addAttachments);
router.delete("/:id/attachments/:attachmentId", authenticate, validate(deleteIssueAttachmentParamsSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.removeAttachment);

router.post("/:id/dependencies", authenticate, validate(addDependencySchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.addDependency);
router.delete("/:id/dependencies/:relatedId", authenticate, validate(removeDependencyParamsSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.removeDependency);

router.get("/:id/watchers", authenticate, validate(listWatchersSchema), requireWorkspace, controller.listWatchers);
router.post("/:id/watchers", authenticate, validate(addWatchersSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.addWatchers);
router.delete("/:id/watchers/:userId", authenticate, validate(removeWatcherParamsSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.removeWatcher);

router.patch("/:id/integration-ref", authenticate, validate(updateIntegrationRefSchema), requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"), controller.updateIntegrationRef);

export default router;
