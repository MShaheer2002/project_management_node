import { Router } from "express";

import { authenticateDual as authenticate } from "../../shared/middleware/authenticate-dual.js";
import { requireRole } from "../../shared/middleware/require-role.js";
import { requireScope } from "../../shared/middleware/require-scope.js";
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
  getStatusCountsSchema,
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

router.post("/", authenticate, validate(createIssueSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.create);
router.post("/assignment-eligibility", authenticate, validate(checkAssignmentEligibilitySchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.checkAssignmentEligibility);
router.get("/", authenticate, validate(listIssuesSchema), requireWorkspace, requireScope("issues:read"), controller.list);
// Must be registered before "/:id" — otherwise Express would match "status-counts" as an :id.
router.get("/status-counts", authenticate, validate(getStatusCountsSchema), requireWorkspace, requireScope("issues:read"), controller.getStatusCounts);
router.get("/:id", authenticate, validate(issueIdParamsSchema), requireWorkspace, requireScope("issues:read"), controller.getById);
router.patch("/:id", authenticate, validate(updateIssueSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.update);
router.delete("/:id", authenticate, validate(issueIdParamsSchema), requireWorkspace, requireScope("issues:write"), requireRole("ADMIN", "OWNER"), controller.remove);
router.patch("/:id/status", authenticate, validate(updateIssueStatusSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.updateStatus);

router.get("/:id/approvals", authenticate, validate(issueIdParamsSchema), requireWorkspace, requireScope("issues:read"), controller.getApprovalStatus);
router.post("/:id/approvals", authenticate, validate(issueIdParamsSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.approveStatus);
router.delete("/:id/approvals", authenticate, validate(issueIdParamsSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.revokeApproval);

router.post("/:id/subtasks", authenticate, validate(createSubtaskSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.createSubtask);
router.patch("/:id/subtasks/:sid", authenticate, validate(updateSubtaskSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.updateSubtask);
router.delete("/:id/subtasks/:sid", authenticate, validate(deleteSubtaskParamsSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.deleteSubtask);
router.patch("/:id/subtasks/reorder", authenticate, validate(reorderSubtasksSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.reorderSubtasks);

router.post("/:id/attachments", authenticate, validate(createIssueAttachmentsSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.addAttachments);
router.delete("/:id/attachments/:attachmentId", authenticate, validate(deleteIssueAttachmentParamsSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.removeAttachment);

router.post("/:id/dependencies", authenticate, validate(addDependencySchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.addDependency);
router.delete("/:id/dependencies/:relatedId", authenticate, validate(removeDependencyParamsSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.removeDependency);

router.get("/:id/watchers", authenticate, validate(listWatchersSchema), requireWorkspace, requireScope("issues:read"), controller.listWatchers);
router.post("/:id/watchers", authenticate, validate(addWatchersSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.addWatchers);
router.delete("/:id/watchers/:userId", authenticate, validate(removeWatcherParamsSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.removeWatcher);

router.patch("/:id/integration-ref", authenticate, validate(updateIntegrationRefSchema), requireWorkspace, requireScope("issues:write"), requireRole("MEMBER", "ADMIN", "OWNER"), controller.updateIntegrationRef);

export default router;
