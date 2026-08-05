/**
 * Consolidated organization tools — projects, teams, departments, membership.
 *
 * Projects/teams/departments keep parallel tool shapes rather than collapsing
 * into generic `groups_*` tools: parallel naming helps the model generalize,
 * while a generic entity parameter invites picking the wrong entity type.
 *
 * Membership is the exception and the single biggest consolidation here — 13
 * legacy tools become one. Listing, adding and removing people is the identical
 * operation across all four containers; only the container differs. Permission
 * checks still resolve per container inside the executor.
 */

import { captureBeforeState, describeChange } from "./capture.js";
import { callLegacy } from "./shared.js";
import {
  fail,
  limitParam,
  num,
  ok,
  okWithMutation,
  optionalStr,
  str,
  strArray,
  type ConsolidatedTool,
} from "./types.js";

// ─── Projects ───────────────────────────────────────────────────────────────

export const projectsSearch: ConsolidatedTool = {
  name: "projects_search",
  domain: "projects",
  readOnly: true,
  description: "List or search projects in the workspace. Private projects the user cannot see are excluded.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Filter by project name." },
      teamId: { type: "string", description: "Restrict to projects owned by one team." },
      status: { type: "string", description: "Lifecycle filter.", enum: ["active", "archived", "completed"] },
      limit: limitParam,
    },
  },
  handler: async (args, ctx) =>
    callLegacy(
      "list_projects",
      {
        ...(optionalStr(args.query) ? { q: str(args.query) } : {}),
        ...(optionalStr(args.teamId) ? { teamId: str(args.teamId) } : {}),
        ...(optionalStr(args.status) ? { status: str(args.status).toUpperCase() } : {}),
        limit: Math.min(num(args.limit, 20), 50),
      },
      ctx,
    ),
};

export const projectsGet: ConsolidatedTool = {
  name: "projects_get",
  domain: "projects",
  readOnly: true,
  description: "Get one project's details and progress summary — issue counts, completion, lead and team.",
  parameters: {
    type: "object",
    properties: { projectId: { type: "string", description: "Project ID." } },
    required: ["projectId"],
  },
  handler: async (args, ctx) => {
    const projectId = optionalStr(args.projectId);
    if (!projectId) return fail("projectId is required");
    return callLegacy("get_project_summary", { projectId }, ctx);
  },
};

export const projectsCreate: ConsolidatedTool = {
  name: "projects_create",
  domain: "projects",
  readOnly: false,
  description: "Create a project under a team. Requires member access or higher.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Project name." },
      teamId: { type: "string", description: "Team that will own the project." },
      description: { type: "string", description: "What the project is for." },
    },
    required: ["name", "teamId"],
  },
  handler: async (args, ctx) => {
    const name = optionalStr(args.name);
    const teamId = optionalStr(args.teamId);
    if (!name) return fail("name is required");
    if (!teamId) return fail("teamId is required");

    const result = await callLegacy(
      "create_project",
      { name, teamId, ...(optionalStr(args.description) ? { description: str(args.description) } : {}) },
      ctx,
    );
    if (!result.success) return fail(result.error ?? "Could not create the project");

    const created = (result.payload ?? {}) as { id?: string; name?: string };
    if (!created.id) return ok(result.payload);

    return okWithMutation(result.payload, {
      kind: "CREATE",
      targetType: "PROJECT",
      targetId: created.id,
      targetLabel: created.name ?? name,
      summary: `Created project "${created.name ?? name}"`,
    });
  },
};

export const projectsUpdate: ConsolidatedTool = {
  name: "projects_update",
  domain: "projects",
  readOnly: false,
  description:
    "Change a project's name, description, status or lead. Use status to archive or complete it.",
  parameters: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Project ID." },
      name: { type: "string", description: "New name." },
      description: { type: "string", description: "New description." },
      status: { type: "string", description: "New lifecycle status.", enum: ["active", "archived", "completed"] },
      leadId: { type: "string", description: "User ID of the new project lead." },
    },
    required: ["projectId"],
  },
  handler: async (args, ctx) => {
    const projectId = optionalStr(args.projectId);
    if (!projectId) return fail("projectId is required");

    const updates: Record<string, unknown> = {
      ...(optionalStr(args.name) ? { name: str(args.name) } : {}),
      ...(optionalStr(args.description) ? { description: str(args.description) } : {}),
      ...(optionalStr(args.status) ? { status: str(args.status).toUpperCase() } : {}),
      ...(optionalStr(args.leadId) ? { leadId: str(args.leadId) } : {}),
    };

    if (Object.keys(updates).length === 0) return fail("Specify at least one field to change.");

    const captured = await captureBeforeState("PROJECT", projectId, ctx.workspaceId, Object.keys(updates));
    const result = await callLegacy("update_project", { projectId, ...updates }, ctx);
    if (!result.success) return fail(result.error ?? "Could not update the project");
    if (!captured) return ok(result.payload);

    return okWithMutation(result.payload, {
      kind: "UPDATE",
      targetType: "PROJECT",
      targetId: projectId,
      targetLabel: captured.label,
      summary: describeChange(captured.beforeState, updates),
      beforeState: captured.beforeState,
      afterState: updates,
    });
  },
};

// ─── Teams ──────────────────────────────────────────────────────────────────

export const teamsSearch: ConsolidatedTool = {
  name: "teams_search",
  domain: "teams",
  readOnly: true,
  description: "List or search teams in the workspace.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Filter by team name." },
      limit: limitParam,
    },
  },
  handler: async (args, ctx) =>
    callLegacy(
      "list_teams",
      {
        ...(optionalStr(args.query) ? { q: str(args.query) } : {}),
        limit: Math.min(num(args.limit, 20), 50),
      },
      ctx,
    ),
};

export const teamsGet: ConsolidatedTool = {
  name: "teams_get",
  domain: "teams",
  readOnly: true,
  description: "Get one team's details — lead, department, member count.",
  parameters: {
    type: "object",
    properties: { teamId: { type: "string", description: "Team ID." } },
    required: ["teamId"],
  },
  handler: async (args, ctx) => {
    const teamId = optionalStr(args.teamId);
    if (!teamId) return fail("teamId is required");
    return callLegacy("get_team", { teamId }, ctx);
  },
};

export const teamsCreate: ConsolidatedTool = {
  name: "teams_create",
  domain: "teams",
  readOnly: false,
  description: "Create a team. A lead is required.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Team name." },
      leadId: { type: "string", description: "User ID of the team lead." },
      departmentId: { type: "string", description: "Department this team belongs to." },
      description: { type: "string", description: "What the team does." },
      visibility: { type: "string", description: "Who can see the team.", enum: ["public", "private"] },
    },
    required: ["name", "leadId"],
  },
  handler: async (args, ctx) => {
    const name = optionalStr(args.name);
    const leadId = optionalStr(args.leadId);
    if (!name) return fail("name is required");
    if (!leadId) return fail("leadId is required");

    const result = await callLegacy(
      "create_team",
      {
        name,
        leadId,
        ...(optionalStr(args.departmentId) ? { departmentId: str(args.departmentId) } : {}),
        ...(optionalStr(args.description) ? { description: str(args.description) } : {}),
        ...(optionalStr(args.visibility) ? { visibility: str(args.visibility) } : {}),
      },
      ctx,
    );
    if (!result.success) return fail(result.error ?? "Could not create the team");

    const created = (result.payload ?? {}) as { id?: string; name?: string };
    if (!created.id) return ok(result.payload);

    return okWithMutation(result.payload, {
      kind: "CREATE",
      targetType: "TEAM",
      targetId: created.id,
      targetLabel: created.name ?? name,
      summary: `Created team "${created.name ?? name}"`,
    });
  },
};

export const teamsUpdate: ConsolidatedTool = {
  name: "teams_update",
  domain: "teams",
  readOnly: false,
  description: "Change a team's name, description, lead, department or visibility.",
  parameters: {
    type: "object",
    properties: {
      teamId: { type: "string", description: "Team ID." },
      name: { type: "string", description: "New name." },
      description: { type: "string", description: "New description." },
      leadId: { type: "string", description: "User ID of the new lead." },
      departmentId: { type: "string", description: "Move the team to this department." },
      visibility: { type: "string", description: "New visibility.", enum: ["public", "private"] },
    },
    required: ["teamId"],
  },
  handler: async (args, ctx) => {
    const teamId = optionalStr(args.teamId);
    if (!teamId) return fail("teamId is required");

    const updates: Record<string, unknown> = {
      ...(optionalStr(args.name) ? { name: str(args.name) } : {}),
      ...(optionalStr(args.description) ? { description: str(args.description) } : {}),
      ...(optionalStr(args.leadId) ? { leadId: str(args.leadId) } : {}),
      ...(optionalStr(args.departmentId) ? { departmentId: str(args.departmentId) } : {}),
      ...(optionalStr(args.visibility) ? { visibility: str(args.visibility).toUpperCase() } : {}),
    };

    if (Object.keys(updates).length === 0) return fail("Specify at least one field to change.");

    const captured = await captureBeforeState("TEAM", teamId, ctx.workspaceId, Object.keys(updates));
    const result = await callLegacy("update_team", { teamId, ...updates }, ctx);
    if (!result.success) return fail(result.error ?? "Could not update the team");
    if (!captured) return ok(result.payload);

    return okWithMutation(result.payload, {
      kind: "UPDATE",
      targetType: "TEAM",
      targetId: teamId,
      targetLabel: captured.label,
      summary: describeChange(captured.beforeState, updates),
      beforeState: captured.beforeState,
      afterState: updates,
    });
  },
};

// ─── Departments ────────────────────────────────────────────────────────────

export const departmentsSearch: ConsolidatedTool = {
  name: "departments_search",
  domain: "departments",
  readOnly: true,
  description: "List or search departments in the workspace.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Filter by department name." },
      limit: limitParam,
    },
  },
  handler: async (args, ctx) =>
    callLegacy(
      "list_departments",
      {
        ...(optionalStr(args.query) ? { q: str(args.query) } : {}),
        limit: Math.min(num(args.limit, 20), 50),
      },
      ctx,
    ),
};

export const departmentsGet: ConsolidatedTool = {
  name: "departments_get",
  domain: "departments",
  readOnly: true,
  description: "Get one department's details — head, teams, member count.",
  parameters: {
    type: "object",
    properties: { departmentId: { type: "string", description: "Department ID." } },
    required: ["departmentId"],
  },
  handler: async (args, ctx) => {
    const departmentId = optionalStr(args.departmentId);
    if (!departmentId) return fail("departmentId is required");
    return callLegacy("get_department", { departmentId }, ctx);
  },
};

export const departmentsCreate: ConsolidatedTool = {
  name: "departments_create",
  domain: "departments",
  readOnly: false,
  description: "Create a department. Requires admin or owner access.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Department name." },
      headId: { type: "string", description: "User ID of the department head." },
      description: { type: "string", description: "What the department does." },
    },
    required: ["name"],
  },
  handler: async (args, ctx) => {
    const name = optionalStr(args.name);
    if (!name) return fail("name is required");

    const result = await callLegacy(
      "create_department",
      {
        name,
        ...(optionalStr(args.headId) ? { headId: str(args.headId) } : {}),
        ...(optionalStr(args.description) ? { description: str(args.description) } : {}),
      },
      ctx,
    );
    if (!result.success) return fail(result.error ?? "Could not create the department");

    const created = (result.payload ?? {}) as { id?: string; name?: string };
    if (!created.id) return ok(result.payload);

    return okWithMutation(result.payload, {
      kind: "CREATE",
      targetType: "DEPARTMENT",
      targetId: created.id,
      targetLabel: created.name ?? name,
      summary: `Created department "${created.name ?? name}"`,
    });
  },
};

export const departmentsUpdate: ConsolidatedTool = {
  name: "departments_update",
  domain: "departments",
  readOnly: false,
  description: "Change a department's name, description or head.",
  parameters: {
    type: "object",
    properties: {
      departmentId: { type: "string", description: "Department ID." },
      name: { type: "string", description: "New name." },
      description: { type: "string", description: "New description." },
      headId: { type: "string", description: "User ID of the new head." },
    },
    required: ["departmentId"],
  },
  handler: async (args, ctx) => {
    const departmentId = optionalStr(args.departmentId);
    if (!departmentId) return fail("departmentId is required");

    const updates: Record<string, unknown> = {
      ...(optionalStr(args.name) ? { name: str(args.name) } : {}),
      ...(optionalStr(args.description) ? { description: str(args.description) } : {}),
      ...(optionalStr(args.headId) ? { headId: str(args.headId) } : {}),
    };
    if (Object.keys(updates).length === 0) return fail("Specify at least one field to change.");

    return callLegacy("update_department", { departmentId, ...updates }, ctx);
  },
};

// ─── Membership (13 legacy tools → 1) ───────────────────────────────────────

const MEMBERSHIP_TOOLS: Record<string, { list: string; add: string; remove: string; idKey: string }> = {
  project: {
    list: "list_project_members",
    add: "add_project_members",
    remove: "remove_project_member",
    idKey: "projectId",
  },
  team: { list: "list_team_members", add: "add_team_members", remove: "remove_team_member", idKey: "teamId" },
  department: {
    list: "list_department_members",
    add: "add_department_members",
    remove: "remove_department_member",
    idKey: "departmentId",
  },
  workspace: {
    list: "list_workspace_members",
    add: "invite_member",
    remove: "remove_workspace_member",
    idKey: "",
  },
};

export const membersManage: ConsolidatedTool = {
  name: "members_manage",
  domain: "members",
  readOnly: false,
  description:
    "List, add or remove people in a project, team, department or the workspace, and change workspace " +
    "roles. Removing revokes access; it never deletes an account or their work.",
  parameters: {
    type: "object",
    properties: {
      container: {
        type: "string",
        description: "Which group to manage.",
        enum: ["project", "team", "department", "workspace"],
      },
      action: {
        type: "string",
        description: "What to do. change_role applies to workspace only.",
        enum: ["list", "add", "remove", "change_role"],
      },
      containerId: {
        type: "string",
        description: "ID of the project, team or department. Omit when container is workspace.",
      },
      userIds: { type: "string", description: "JSON array of user IDs to add." },
      userId: { type: "string", description: "Single user ID, for remove or change_role." },
      role: {
        type: "string",
        description: "Workspace role. Never OWNER — a workspace has exactly one owner.",
        enum: ["ADMIN", "MEMBER", "GUEST"],
      },
      limit: limitParam,
    },
    required: ["container", "action"],
  },
  handler: async (args, ctx) => {
    const container = str(args.container);
    const action = str(args.action);
    const config = MEMBERSHIP_TOOLS[container];
    if (!config) return fail(`Unknown container: ${container}`);

    const containerId = optionalStr(args.containerId);
    if (config.idKey && !containerId) return fail(`containerId is required for a ${container}`);
    const scope = config.idKey && containerId ? { [config.idKey]: containerId } : {};

    switch (action) {
      case "list":
        return callLegacy(config.list, { ...scope, limit: Math.min(num(args.limit, 50), 100) }, ctx);

      case "add": {
        const userIds = strArray(args.userIds).length > 0 ? strArray(args.userIds) : strArray(args.userId);
        if (userIds.length === 0) return fail("userIds is required to add members");

        // Workspace "add" is an invitation, which needs an email and a target team
        // rather than an existing user ID — a materially different operation.
        if (container === "workspace") {
          return fail(
            "To bring someone new into the workspace, use workspace_invitations with their email address, role, and the team they should join.",
          );
        }

        return callLegacy(config.add, { ...scope, userIdsJson: JSON.stringify(userIds) }, ctx);
      }

      case "remove": {
        const userId = optionalStr(args.userId);
        if (!userId) return fail("userId is required to remove a member");
        return callLegacy(config.remove, { ...scope, userId }, ctx);
      }

      case "change_role": {
        if (container !== "workspace") return fail("Roles are only set at the workspace level.");
        const userId = optionalStr(args.userId);
        const role = optionalStr(args.role);
        if (!userId) return fail("userId is required to change a role");
        if (!role) return fail("role is required");
        return callLegacy("change_workspace_member_role", { userId, role }, ctx);
      }

      default:
        return fail(`Unknown action: ${action}`);
    }
  },
};

export const orgTools: ConsolidatedTool[] = [
  projectsSearch,
  projectsGet,
  projectsCreate,
  projectsUpdate,
  teamsSearch,
  teamsGet,
  teamsCreate,
  teamsUpdate,
  departmentsSearch,
  departmentsGet,
  departmentsCreate,
  departmentsUpdate,
  membersManage,
];
