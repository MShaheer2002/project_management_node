/**
 * Consolidated workspace, analytics, content and meta tools.
 *
 * `analytics_report` is the most consequential consolidation in the registry.
 * Five scope-specific analytics tools meant choosing a scope was a tool
 * selection — an unrecoverable fork. Picking team analytics and then failing to
 * resolve a team left the model looping "Which team?" with no route back to
 * workspace scope, because that was a different tool entirely. As one tool with
 * a `scope` parameter, answering "the whole workspace" simply fills the
 * parameter. Per-scope permissions are unchanged; they live in the analytics
 * service, which still narrows by role and membership.
 */

import { callLegacy } from "./shared.js";
import { fail, limitParam, num, ok, optionalStr, str, type ConsolidatedTool } from "./types.js";

// ─── Analytics ──────────────────────────────────────────────────────────────

const ANALYTICS_TOOL_BY_SCOPE: Record<string, string> = {
  workspace: "get_workspace_analytics",
  project: "get_project_analytics",
  team: "get_team_analytics",
  member: "get_member_analytics",
  cycle: "get_cycle_analytics",
};

const ANALYTICS_SCOPE_ID_KEY: Record<string, string> = {
  project: "projectId",
  team: "teamId",
  member: "memberId",
  cycle: "cycleId",
};

export const analyticsReport: ConsolidatedTool = {
  name: "analytics_report",
  domain: "analytics",
  readOnly: true,
  description:
    "Get performance metrics for the whole workspace, a project, a team, a person, or a cycle — completion " +
    "rates, velocity, workload, overdue work and trends. Workspace-wide figures require admin or owner access; " +
    "a regular member can only see their own metrics and scopes they belong to.",
  parameters: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        description: "What to report on. Ask the user if it is genuinely unclear.",
        enum: ["workspace", "project", "team", "member", "cycle"],
      },
      scopeId: {
        type: "string",
        description: "ID of the project, team, member or cycle. Omit when scope is workspace.",
      },
      period: { type: "string", description: "Reporting window.", enum: ["7d", "30d", "90d", "custom"] },
      from: { type: "string", description: "Start date YYYY-MM-DD (period=custom)." },
      to: { type: "string", description: "End date YYYY-MM-DD (period=custom)." },
    },
    required: ["scope"],
  },
  handler: async (args, ctx) => {
    const scope = str(args.scope);
    const toolName = ANALYTICS_TOOL_BY_SCOPE[scope];
    if (!toolName) return fail(`Unknown analytics scope: ${scope}`);

    const scopeId = optionalStr(args.scopeId);
    const idKey = ANALYTICS_SCOPE_ID_KEY[scope];

    if (idKey && !scopeId) {
      return fail(`scopeId is required for ${scope} analytics — resolve the ${scope} first, or ask the user which one.`);
    }

    const result = await callLegacy(
      toolName,
      {
        ...(idKey && scopeId ? { [idKey]: scopeId } : {}),
        ...(optionalStr(args.period) ? { period: str(args.period) } : {}),
        ...(optionalStr(args.from) ? { from: str(args.from) } : {}),
        ...(optionalStr(args.to) ? { to: str(args.to) } : {}),
      },
      ctx,
    );

    if (!result.success) return fail(result.error ?? "Could not load analytics");
    return ok(result.payload, { ...(result.meta ?? {}), scope, ...(scopeId ? { scopeId } : {}) });
  },
};

export const analyticsExport: ConsolidatedTool = {
  name: "analytics_export",
  domain: "analytics",
  readOnly: true,
  description: "Export an analytics report as a downloadable file.",
  parameters: {
    type: "object",
    properties: {
      scope: { type: "string", description: "What to export.", enum: ["workspace", "project", "team", "member", "cycle"] },
      scopeId: { type: "string", description: "ID of the scoped entity. Omit for workspace." },
      format: { type: "string", description: "File format.", enum: ["csv", "json", "pdf"] },
      period: { type: "string", description: "Reporting window.", enum: ["7d", "30d", "90d"] },
    },
    required: ["scope"],
  },
  handler: async (args, ctx) =>
    callLegacy(
      "export_analytics_report",
      {
        scope: str(args.scope),
        ...(optionalStr(args.scopeId) ? { scopeId: str(args.scopeId) } : {}),
        format: str(args.format, "csv"),
        ...(optionalStr(args.period) ? { period: str(args.period) } : {}),
      },
      ctx,
    ),
};

// ─── Workspace ──────────────────────────────────────────────────────────────

export const workspaceGet: ConsolidatedTool = {
  name: "workspace_get",
  domain: "workspace",
  readOnly: true,
  description:
    "Get the current workspace's settings and the calling user's own access level — their role and what they " +
    "are allowed to do. Use this when someone asks about their permissions.",
  parameters: {
    type: "object",
    properties: {
      includeAccessSummary: { type: "boolean", description: "Include what this user can and cannot do." },
    },
  },
  handler: async (args, ctx) =>
    args.includeAccessSummary === true
      ? callLegacy("get_workspace_access_summary", {}, ctx)
      : callLegacy("get_workspace", {}, ctx),
};

export const workspaceUpdate: ConsolidatedTool = {
  name: "workspace_update",
  domain: "workspace",
  readOnly: false,
  description: "Change workspace settings such as its name. Requires admin or owner access.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "New workspace name." },
      description: { type: "string", description: "New workspace description." },
    },
  },
  handler: async (args, ctx) => {
    const updates: Record<string, unknown> = {
      ...(optionalStr(args.name) ? { name: str(args.name) } : {}),
      ...(optionalStr(args.description) ? { description: str(args.description) } : {}),
    };
    if (Object.keys(updates).length === 0) return fail("Specify at least one setting to change.");
    return callLegacy("update_workspace", updates, ctx);
  },
};

export const workspaceListMine: ConsolidatedTool = {
  name: "workspace_list_mine",
  domain: "workspace",
  readOnly: true,
  description: "List every workspace the current user belongs to, for questions like 'which workspaces am I in'.",
  parameters: { type: "object", properties: {} },
  handler: async (_args, ctx) => callLegacy("list_user_workspaces", {}, ctx),
};

export const workspaceInvitations: ConsolidatedTool = {
  name: "workspace_invitations",
  domain: "workspace",
  readOnly: false,
  description:
    "Invite someone to the workspace by email, list outstanding invitations, or accept one addressed to the " +
    "current user. Inviting requires admin or owner access.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "What to do.", enum: ["create", "list", "list_mine", "accept"] },
      email: { type: "string", description: "Who to invite (action=create)." },
      role: {
        type: "string",
        description: "Role to grant. Never OWNER — a workspace has exactly one owner.",
        enum: ["ADMIN", "MEMBER", "GUEST"],
      },
      designation: { type: "string", description: "Their job title, e.g. 'Frontend Engineer' (action=create)." },
      teamId: { type: "string", description: "Team they should join (action=create)." },
      invitationId: { type: "string", description: "Invitation to accept (action=accept)." },
    },
    required: ["action"],
  },
  handler: async (args, ctx) => {
    switch (str(args.action)) {
      case "create": {
        const email = optionalStr(args.email);
        const role = optionalStr(args.role);
        const designation = optionalStr(args.designation);
        const teamId = optionalStr(args.teamId);
        if (!email) return fail("email is required to send an invitation");
        if (!role) return fail("role is required — ADMIN, MEMBER or GUEST");
        if (!designation) return fail("designation is required, e.g. 'Frontend Engineer'");
        if (!teamId) return fail("teamId is required — which team should they join?");
        return callLegacy("invite_member", { email, role, designation, teamId }, ctx);
      }
      case "list":
        return callLegacy("list_workspace_invitations", {}, ctx);
      case "list_mine":
        return callLegacy("list_pending_workspace_invites", {}, ctx);
      case "accept": {
        const invitationId = optionalStr(args.invitationId);
        if (!invitationId) return fail("invitationId is required");
        return callLegacy("accept_workspace_invite", { invitationId }, ctx);
      }
      default:
        return fail(`Unknown invitation action: ${str(args.action)}`);
    }
  },
};

// ─── Content ────────────────────────────────────────────────────────────────

export const documentsSearch: ConsolidatedTool = {
  name: "documents_search",
  domain: "documents",
  readOnly: true,
  description: "List documents or folders in the workspace, a team, or a project.",
  parameters: {
    type: "object",
    properties: {
      scope: { type: "string", description: "Where to look.", enum: ["workspace", "team", "project"] },
      scopeId: { type: "string", description: "Team or project ID. Omit for workspace." },
      kind: { type: "string", description: "What to list.", enum: ["document", "folder"] },
      limit: limitParam,
    },
    required: ["scope"],
  },
  handler: async (args, ctx) => {
    const scope = str(args.scope).toUpperCase();
    const scopeId = optionalStr(args.scopeId);
    const scopeArgs = {
      scopeType: scope,
      ...(scope === "TEAM" && scopeId ? { teamId: scopeId } : {}),
      ...(scope === "PROJECT" && scopeId ? { projectId: scopeId } : {}),
    };

    return str(args.kind) === "folder"
      ? callLegacy("list_document_folders", scopeArgs, ctx)
      : callLegacy("list_documents", { ...scopeArgs, limit: Math.min(num(args.limit, 20), 50) }, ctx);
  },
};

export const documentsCreate: ConsolidatedTool = {
  name: "documents_create",
  domain: "documents",
  readOnly: false,
  description: "Create a document or a folder. Requires admin or owner access.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", description: "What to create.", enum: ["document", "folder"] },
      scope: { type: "string", description: "Where it lives.", enum: ["workspace", "team", "project"] },
      scopeId: { type: "string", description: "Team or project ID. Omit for workspace." },
      title: { type: "string", description: "Document title or folder name." },
      content: { type: "string", description: "Document body, markdown (kind=document)." },
      folderId: { type: "string", description: "Folder to place it in." },
    },
    required: ["kind", "scope", "title"],
  },
  handler: async (args, ctx) => {
    const scope = str(args.scope).toUpperCase();
    const scopeId = optionalStr(args.scopeId);
    const title = optionalStr(args.title);
    if (!title) return fail("title is required");

    const scopeArgs = {
      scopeType: scope,
      ...(scope === "TEAM" && scopeId ? { teamId: scopeId } : {}),
      ...(scope === "PROJECT" && scopeId ? { projectId: scopeId } : {}),
    };

    return str(args.kind) === "folder"
      ? callLegacy("create_document_folder", { ...scopeArgs, name: title }, ctx)
      : callLegacy(
          "create_document",
          {
            ...scopeArgs,
            title,
            ...(optionalStr(args.content) ? { content: str(args.content) } : {}),
            ...(optionalStr(args.folderId) ? { folderId: str(args.folderId) } : {}),
          },
          ctx,
        );
  },
};

export const documentsUpdate: ConsolidatedTool = {
  name: "documents_update",
  domain: "documents",
  readOnly: false,
  description: "Rename a document or folder, or move it somewhere else.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", description: "What to change.", enum: ["document", "folder"] },
      documentId: { type: "string", description: "Document ID (kind=document)." },
      folderId: { type: "string", description: "Folder ID (kind=folder), or destination folder for a move." },
      title: { type: "string", description: "New title or name." },
      moveToFolderId: { type: "string", description: "Destination folder." },
    },
    required: ["kind"],
  },
  handler: async (args, ctx) => {
    const kind = str(args.kind);
    const moveTo = optionalStr(args.moveToFolderId);

    if (kind === "folder") {
      const folderId = optionalStr(args.folderId);
      if (!folderId) return fail("folderId is required");
      return moveTo
        ? callLegacy("move_document_folder", { folderId, parentId: moveTo }, ctx)
        : callLegacy("rename_document_folder", { folderId, name: str(args.title) }, ctx);
    }

    const documentId = optionalStr(args.documentId);
    if (!documentId) return fail("documentId is required");
    return moveTo
      ? callLegacy("move_document", { documentId, folderId: moveTo }, ctx)
      : callLegacy("update_document", { documentId, ...(optionalStr(args.title) ? { title: str(args.title) } : {}) }, ctx);
  },
};

export const notificationsManage: ConsolidatedTool = {
  name: "notifications_manage",
  domain: "notifications",
  readOnly: false,
  description: "List the user's notifications, or mark one or all of them as read.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "What to do.", enum: ["list", "mark_read", "mark_all_read"] },
      notificationId: { type: "string", description: "Notification to mark read (action=mark_read)." },
      unreadOnly: { type: "boolean", description: "Only unread notifications (action=list)." },
      limit: limitParam,
    },
    required: ["action"],
  },
  handler: async (args, ctx) => {
    switch (str(args.action)) {
      case "list":
        return callLegacy(
          "list_notifications",
          {
            ...(args.unreadOnly === true ? { unreadOnly: true } : {}),
            limit: Math.min(num(args.limit, 20), 50),
          },
          ctx,
        );
      case "mark_read": {
        const notificationId = optionalStr(args.notificationId);
        if (!notificationId) return fail("notificationId is required");
        return callLegacy("mark_notification_read", { notificationId }, ctx);
      }
      case "mark_all_read":
        return callLegacy("mark_all_notifications_read", {}, ctx);
      default:
        return fail(`Unknown notification action: ${str(args.action)}`);
    }
  },
};

export const activitySearch: ConsolidatedTool = {
  name: "activity_search",
  domain: "workspace",
  readOnly: true,
  description: "See what has changed recently across the workspace — who did what, and when.",
  parameters: {
    type: "object",
    properties: { limit: limitParam },
  },
  handler: async (args, ctx) => callLegacy("activity_summary", { limit: Math.min(num(args.limit, 15), 30) }, ctx),
};

export const labelsSearch: ConsolidatedTool = {
  name: "labels_search",
  domain: "workspace",
  readOnly: true,
  description: "List the labels available in this workspace.",
  parameters: { type: "object", properties: {} },
  handler: async (_args, ctx) => callLegacy("list_labels", {}, ctx),
};

// ─── Integrations ───────────────────────────────────────────────────────────

export const integrationsGet: ConsolidatedTool = {
  name: "integrations_get",
  domain: "integrations",
  readOnly: true,
  description: "See which external tools (GitHub, Slack, Figma, Discord) are connected and their sync status.",
  parameters: {
    type: "object",
    properties: {
      provider: { type: "string", description: "Check one provider.", enum: ["github", "slack", "figma", "discord"] },
    },
  },
  handler: async (args, ctx) => {
    const provider = optionalStr(args.provider);
    return provider
      ? callLegacy("get_integration_status", { provider }, ctx)
      : callLegacy("list_integrations", {}, ctx);
  },
};

export const apiKeysManage: ConsolidatedTool = {
  name: "api_keys_manage",
  domain: "integrations",
  readOnly: false,
  description:
    "List or create API keys for programmatic access. Requires admin or owner access. Keys cannot be revoked " +
    "through chat — do that in workspace settings.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "What to do.", enum: ["list", "get", "create"] },
      apiKeyId: { type: "string", description: "Key to fetch (action=get)." },
      name: { type: "string", description: "Label for the new key (action=create)." },
    },
    required: ["action"],
  },
  handler: async (args, ctx) => {
    switch (str(args.action)) {
      case "list":
        return callLegacy("list_api_keys", {}, ctx);
      case "get": {
        const apiKeyId = optionalStr(args.apiKeyId);
        if (!apiKeyId) return fail("apiKeyId is required");
        return callLegacy("get_api_key", { apiKeyId }, ctx);
      }
      case "create": {
        const name = optionalStr(args.name);
        if (!name) return fail("name is required to create an API key");
        return callLegacy("create_api_key", { name }, ctx);
      }
      default:
        return fail(`Unknown API key action: ${str(args.action)}`);
    }
  },
};

// ─── Meta ───────────────────────────────────────────────────────────────────

/**
 * Clarification as a tool rather than emergent behavior.
 *
 * Models reliably *recognize* ambiguity but rarely volunteer a question — they
 * default to answering with a guess. Making the question an action they can
 * select fixes that, renders as selectable options in the panel instead of prose,
 * and makes "did it ask when it should have?" assertable in evals.
 */
export const askUserToClarify: ConsolidatedTool = {
  name: "ask_user_to_clarify",
  domain: "meta",
  readOnly: true,
  description:
    "Ask the user one specific question when you genuinely cannot proceed — for example when a name matches " +
    "several things, or a required detail is missing and cannot be looked up. Search first; only ask when " +
    "looking it up will not resolve it. Ask one question, not several.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "One short, specific question." },
      options: {
        type: "string",
        description: "JSON array of concrete choices, e.g. [\"Backend Team\",\"Backend Platform\"]. Omit if open-ended.",
      },
    },
    required: ["question"],
  },
  handler: async (args) => {
    const question = optionalStr(args.question);
    if (!question) return fail("question is required");

    let options: string[] = [];
    const raw = args.options;
    if (typeof raw === "string" && raw.trim().startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) options = parsed.map((entry) => String(entry)).filter(Boolean);
      } catch {
        // Malformed options degrade to an open-ended question rather than failing.
      }
    } else if (Array.isArray(raw)) {
      options = raw.map((entry) => String(entry)).filter(Boolean);
    }

    // Handled entirely in the panel: the payload is what gets rendered as chips.
    return ok({ question, options }, { awaitingUserInput: true });
  },
};

export const appHelp: ConsolidatedTool = {
  name: "app_help",
  domain: "meta",
  readOnly: true,
  description:
    "Explain how to do something in Trussen, or where to find a feature. Use for 'how do I…' and 'where is…' " +
    "questions about the app itself rather than about workspace data.",
  parameters: {
    type: "object",
    properties: { topic: { type: "string", description: "What the user is trying to do." } },
    required: ["topic"],
  },
  handler: async (args, ctx) => callLegacy("app_help", { prompt: str(args.topic) }, ctx),
};

export const workspaceTools: ConsolidatedTool[] = [
  analyticsReport,
  analyticsExport,
  workspaceGet,
  workspaceUpdate,
  workspaceListMine,
  workspaceInvitations,
  documentsSearch,
  documentsCreate,
  documentsUpdate,
  notificationsManage,
  activitySearch,
  labelsSearch,
  integrationsGet,
  apiKeysManage,
  askUserToClarify,
  appHelp,
];
