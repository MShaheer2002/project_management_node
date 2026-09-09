/**
 * Workspace Module — Controller
 *
 * Handles HTTP request parsing and response sending.
 * Controllers are DUMB — parse request, call service, send response.
 * No business logic here.
 */

import type { RequestHandler } from "express";
import * as workspaceService from "./workspace.service.js";
import * as membershipService from "./membership.service.js";
import * as invitationService from "./invitation.service.js";
import { sendList, sendSuccess } from "../../shared/utils/api-response.js";
import type { ListWorkspaceMembersQuery } from "./workspace.schemas.js";

// ─── Workspace CRUD ──────────────────────────────────────────────────────────

/** POST /workspaces — Create a new workspace (user becomes OWNER) */
export const create: RequestHandler = async (req, res, next) => {
  try {
    const workspace = await workspaceService.createWorkspace(req.user!.id, req.body);
    sendSuccess(res, 201, workspace);
  } catch (error) {
    next(error);
  }
};

/** GET /workspaces — List all workspaces the user belongs to */
export const list: RequestHandler = async (req, res, next) => {
  try {
    const workspaces = await workspaceService.listWorkspaces(req.user!.id);
    sendSuccess(res, 200, workspaces);
  } catch (error) {
    next(error);
  }
};

/** GET /workspaces/:workspaceId — Get workspace details */
export const getById: RequestHandler = async (req, res, next) => {
  try {
    const workspace = await workspaceService.getWorkspaceById(req.params.workspaceId as string);
    sendSuccess(res, 200, workspace);
  } catch (error) {
    next(error);
  }
};

/** PATCH /workspaces/:workspaceId — Update workspace settings */
export const update: RequestHandler = async (req, res, next) => {
  try {
    const workspace = await workspaceService.updateWorkspace(req.params.workspaceId as string, req.body);
    sendSuccess(res, 200, workspace);
  } catch (error) {
    next(error);
  }
};

/** DELETE /workspaces/:workspaceId — Delete workspace (OWNER only, cascades everything) */
export const remove: RequestHandler = async (req, res, next) => {
  try {
    await workspaceService.deleteWorkspace(req.params.workspaceId as string);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

/** GET /workspaces/check-slug/:slug — Check if slug is available */
export const checkSlug: RequestHandler = async (req, res, next) => {
  try {
    const result = await workspaceService.checkSlugAvailability(req.params.slug as string);
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /workspaces/resolve/:slug — PUBLIC, no auth required.
 * Lets the frontend ask "does <slug>.trussen.app exist?" before login, to
 * decide between showing a sign-in page or redirecting to the landing page.
 */
export const resolveBySlug: RequestHandler = async (req, res, next) => {
  try {
    const result = await workspaceService.resolveWorkspaceBySlug(req.params.slug as string);
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

// ─── Workspace Statuses ─────────────────────────────────────────────────────

/** GET /workspaces/:workspaceId/statuses — Get workspace custom statuses */
export const getStatuses: RequestHandler = async (req, res, next) => {
  try {
    const statuses = await workspaceService.getWorkspaceStatuses(req.params.workspaceId as string);
    sendSuccess(res, 200, statuses);
  } catch (error) {
    next(error);
  }
};

/** GET /workspaces/:workspaceId/statuses/:statusKey/usage — Count issues using a status */
export const getStatusUsage: RequestHandler = async (req, res, next) => {
  try {
    const query = (req.validated?.query ?? req.query) as { limit?: number };
    const usage = await workspaceService.getWorkspaceStatusUsage(
      req.params.workspaceId as string,
      req.params.statusKey as string,
      query.limit,
    );
    sendSuccess(res, 200, usage);
  } catch (error) {
    next(error);
  }
};

export const mergeStatus: RequestHandler = async (req, res, next) => {
  try {
    const statuses = await workspaceService.mergeWorkspaceStatus(
      req.params.workspaceId as string,
      req.params.statusKey as string,
      req.body.targetStatusKey,
    );
    sendSuccess(res, 200, statuses);
  } catch (error) {
    next(error);
  }
};

/** PUT /workspaces/:workspaceId/statuses — Replace workspace custom statuses */
export const updateStatuses: RequestHandler = async (req, res, next) => {
  try {
    const statuses = await workspaceService.updateWorkspaceStatuses(req.params.workspaceId as string, req.body);
    sendSuccess(res, 200, statuses);
  } catch (error) {
    next(error);
  }
};

/** GET /workspaces/:workspaceId/workflow-automation — Get workflow automation config */
export const getWorkflowAutomation: RequestHandler = async (req, res, next) => {
  try {
    const config = await workspaceService.getWorkflowAutomation(req.params.workspaceId as string);
    sendSuccess(res, 200, config);
  } catch (error) {
    next(error);
  }
};

/** PUT /workspaces/:workspaceId/workflow-automation — Replace workflow automation config */
export const updateWorkflowAutomation: RequestHandler = async (req, res, next) => {
  try {
    const config = await workspaceService.updateWorkflowAutomation(req.params.workspaceId as string, req.body);
    sendSuccess(res, 200, config);
  } catch (error) {
    next(error);
  }
};

// ─── Membership Management ───────────────────────────────────────────────────

/** POST /workspaces/:workspaceId/invitations — Send workspace invitation email */
export const createInvitation: RequestHandler = async (req, res, next) => {
  try {
    // Get workspace name for the email (requireWorkspace already verified access)
    const workspace = await workspaceService.getWorkspaceById(req.params.workspaceId as string);

    const invitation = await invitationService.createInvitation({
      workspaceId: req.params.workspaceId as string,
      email: req.body.email,
      role: req.body.role,
      designation: req.body.designation,
      teamId: req.body.teamId,
      departmentId: req.body.departmentId,
      invitedById: req.user!.id,
      inviterName: req.user!.name,
      workspaceName: workspace.name,
    });

    sendSuccess(res, 201, invitation);
  } catch (error) {
    next(error);
  }
};

/** GET /workspaces/:workspaceId/members — List workspace members */
export const listMembers: RequestHandler = async (req, res, next) => {
  try {
    const result = await membershipService.listMembers(
      req.params.workspaceId as string,
      (req.validated?.query ?? req.query) as ListWorkspaceMembersQuery,
    );
    sendList(res, result.items, result.meta);
  } catch (error) {
    next(error);
  }
};

/** PATCH /workspaces/:workspaceId/members/:userId — Change member role */
export const changeMemberRole: RequestHandler = async (req, res, next) => {
  try {
    const member = await membershipService.changeMemberRole(
      req.params.workspaceId as string,
      req.params.userId as string,
      req.body.role,
    );
    sendSuccess(res, 200, member);
  } catch (error) {
    next(error);
  }
};

/** DELETE /workspaces/:workspaceId/members/:userId — Remove member */
export const removeMember: RequestHandler = async (req, res, next) => {
  try {
    await membershipService.removeMember(req.params.workspaceId as string, req.params.userId as string);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// ─── Invitation Endpoints ────────────────────────────────────────────────────

/** GET /workspaces/:workspaceId/invitations — List workspace invitations */
export const listInvitations: RequestHandler = async (req, res, next) => {
  try {
    const invitations = await invitationService.listInvitations(req.params.workspaceId as string);
    sendSuccess(res, 200, invitations);
  } catch (error) {
    next(error);
  }
};

/** DELETE /workspaces/:workspaceId/invitations/:invitationId — Revoke invitation */
export const revokeInvitation: RequestHandler = async (req, res, next) => {
  try {
    await invitationService.revokeInvitation(
      req.params.invitationId as string,
      req.params.workspaceId as string,
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

/**
 * GET /invitations/resolve?t=<rawToken>
 * PUBLIC — no auth required.
 * Returns invite metadata (workspace name, role, invited email) so the
 * frontend can show "You've been invited to Acme Corp" before sign-in.
 */
export const resolveInvitation: RequestHandler = async (req, res, next) => {
  try {
    const result = await invitationService.resolveInvitation(req.query.t as string);
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};

/**
 * POST /invitations/accept
 * AUTHENTICATED — requires valid Clerk session.
 * Verifies email ownership (user.email === invitation.email) before creating membership.
 * Token sent in body (not URL) to avoid leaking into logs/proxies/analytics.
 */
export const acceptInvitation: RequestHandler = async (req, res, next) => {
  try {
    const result = await invitationService.acceptInvitation(
      req.body.token,
      req.user!.id,
      req.user!.email,
    );
    sendSuccess(res, 200, result);
  } catch (error) {
    next(error);
  }
};
