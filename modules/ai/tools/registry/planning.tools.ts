/**
 * Consolidated planning tools — cycles, templates, roadmap.
 *
 * Lifecycle transitions (complete/reopen/carry-over, activate/deactivate) become
 * an `action` parameter rather than separate tools. Their differing permission
 * requirements are unchanged: reopening a cycle still requires admin/owner while
 * creating one does not, because that check lives in the service, not the tool name.
 */

import { callLegacy } from "./shared.js";
import { fail, limitParam, num, ok, okWithMutation, optionalStr, str, strArray, type ConsolidatedTool } from "./types.js";

// ─── Cycles ─────────────────────────────────────────────────────────────────

export const cyclesSearch: ConsolidatedTool = {
  name: "cycles_search",
  domain: "cycles",
  readOnly: true,
  description:
    "List cycles (sprints), or find a team's currently running one.",
  parameters: {
    type: "object",
    properties: {
      teamId: { type: "string", description: "Restrict to one team's cycles." },
      status: { type: "string", description: "Lifecycle filter.", enum: ["upcoming", "current", "completed"] },
      currentOnly: { type: "boolean", description: "Return only the team's active cycle." },
      limit: limitParam,
    },
  },
  handler: async (args, ctx) => {
    const teamId = optionalStr(args.teamId);

    if (args.currentOnly === true) {
      if (!teamId) return fail("teamId is required to find the current cycle");
      return callLegacy("get_current_cycle_for_team", { teamId }, ctx);
    }

    return callLegacy(
      "list_cycles",
      {
        ...(teamId ? { teamId } : {}),
        ...(optionalStr(args.status) ? { status: str(args.status) } : {}),
        limit: Math.min(num(args.limit, 20), 50),
      },
      ctx,
    );
  },
};

export const cyclesGet: ConsolidatedTool = {
  name: "cycles_get",
  domain: "cycles",
  readOnly: true,
  description: "Get one cycle with its progress — issue counts, completion rate, and what remains.",
  parameters: {
    type: "object",
    properties: {
      cycleId: { type: "string", description: "Cycle ID." },
      includeProgress: { type: "boolean", description: "Include completion statistics (default true)." },
    },
    required: ["cycleId"],
  },
  handler: async (args, ctx) => {
    const cycleId = optionalStr(args.cycleId);
    if (!cycleId) return fail("cycleId is required");

    return args.includeProgress === false
      ? callLegacy("get_cycle", { cycleId }, ctx)
      : callLegacy("get_cycle_progress", { cycleId }, ctx);
  },
};

export const cyclesCreate: ConsolidatedTool = {
  name: "cycles_create",
  domain: "cycles",
  readOnly: false,
  description: "Create a cycle (sprint) for a team with a start and end date.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Cycle name." },
      teamId: { type: "string", description: "Team the cycle belongs to." },
      startsAt: { type: "string", description: "Start date as YYYY-MM-DD." },
      endsAt: { type: "string", description: "End date as YYYY-MM-DD." },
      goal: { type: "string", description: "What the cycle aims to achieve." },
    },
    required: ["name", "teamId", "startsAt", "endsAt"],
  },
  handler: async (args, ctx) => {
    const name = optionalStr(args.name);
    const teamId = optionalStr(args.teamId);
    const startsAt = optionalStr(args.startsAt);
    const endsAt = optionalStr(args.endsAt);
    if (!name || !teamId || !startsAt || !endsAt) {
      return fail("name, teamId, startsAt and endsAt are all required");
    }

    const result = await callLegacy(
      "create_cycle",
      { name, teamId, startsAt, endsAt, ...(optionalStr(args.goal) ? { goal: str(args.goal) } : {}) },
      ctx,
    );
    if (!result.success) return fail(result.error ?? "Could not create the cycle");

    const created = (result.payload ?? {}) as { id?: string; name?: string };
    if (!created.id) return ok(result.payload);

    return okWithMutation(result.payload, {
      kind: "CREATE",
      targetType: "CYCLE",
      targetId: created.id,
      targetLabel: created.name ?? name,
      summary: `Created cycle "${created.name ?? name}"`,
    });
  },
};

export const cyclesUpdate: ConsolidatedTool = {
  name: "cycles_update",
  domain: "cycles",
  readOnly: false,
  description:
    "Change a cycle, or complete / reopen (admin only) / carry over its unfinished work.",
  parameters: {
    type: "object",
    properties: {
      cycleId: { type: "string", description: "Cycle ID." },
      action: {
        type: "string",
        description: "Lifecycle action, or 'update' to change fields.",
        enum: ["update", "complete", "reopen", "carry_over"],
      },
      name: { type: "string", description: "New name (action=update)." },
      goal: { type: "string", description: "New goal (action=update)." },
      startsAt: { type: "string", description: "New start date YYYY-MM-DD (action=update)." },
      endsAt: { type: "string", description: "New end date YYYY-MM-DD (action=update)." },
      targetCycleId: { type: "string", description: "Cycle to carry unfinished work into (action=carry_over)." },
    },
    required: ["cycleId", "action"],
  },
  handler: async (args, ctx) => {
    const cycleId = optionalStr(args.cycleId);
    if (!cycleId) return fail("cycleId is required");

    switch (str(args.action)) {
      case "complete":
        return callLegacy("complete_cycle", { cycleId }, ctx);
      case "reopen":
        return callLegacy("reopen_cycle", { cycleId }, ctx);
      case "carry_over":
        return callLegacy(
          "carry_over_cycle",
          { cycleId, ...(optionalStr(args.targetCycleId) ? { targetCycleId: str(args.targetCycleId) } : {}) },
          ctx,
        );
      case "update": {
        const updates: Record<string, unknown> = {
          ...(optionalStr(args.name) ? { name: str(args.name) } : {}),
          ...(optionalStr(args.goal) ? { goal: str(args.goal) } : {}),
          ...(optionalStr(args.startsAt) ? { startsAt: str(args.startsAt) } : {}),
          ...(optionalStr(args.endsAt) ? { endsAt: str(args.endsAt) } : {}),
        };
        if (Object.keys(updates).length === 0) return fail("Specify at least one field to change.");
        return callLegacy("update_cycle", { cycleId, ...updates }, ctx);
      }
      default:
        return fail(`Unknown cycle action: ${str(args.action)}`);
    }
  },
};

// ─── Templates ──────────────────────────────────────────────────────────────

export const templatesSearch: ConsolidatedTool = {
  name: "templates_search",
  domain: "templates",
  readOnly: true,
  description: "List issue templates, optionally only the ones currently active.",
  parameters: {
    type: "object",
    properties: {
      activeOnly: { type: "boolean", description: "Only templates currently in use." },
      limit: limitParam,
    },
  },
  handler: async (args, ctx) =>
    args.activeOnly === true
      ? callLegacy("list_active_templates", {}, ctx)
      : callLegacy("list_templates", { limit: Math.min(num(args.limit, 20), 50) }, ctx),
};

export const templatesGet: ConsolidatedTool = {
  name: "templates_get",
  domain: "templates",
  readOnly: true,
  description: "Get one template's fields and defaults.",
  parameters: {
    type: "object",
    properties: { templateId: { type: "string", description: "Template ID." } },
    required: ["templateId"],
  },
  handler: async (args, ctx) => {
    const templateId = optionalStr(args.templateId);
    if (!templateId) return fail("templateId is required");
    return callLegacy("get_template", { templateId }, ctx);
  },
};

export const templatesManage: ConsolidatedTool = {
  name: "templates_manage",
  domain: "templates",
  readOnly: false,
  description:
    "Create, update, duplicate, activate or deactivate an issue template. Admin only.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "What to do.",
        enum: ["create", "update", "duplicate", "activate", "deactivate"],
      },
      templateId: { type: "string", description: "Template ID (all actions except create)." },
      name: { type: "string", description: "Template name (create/update)." },
      issueType: { type: "string", description: "Issue type this template applies to.", enum: ["task", "bug", "issue"] },
      description: { type: "string", description: "Template description." },
    },
    required: ["action"],
  },
  handler: async (args, ctx) => {
    const action = str(args.action);
    const templateId = optionalStr(args.templateId);

    if (action === "create") {
      const name = optionalStr(args.name);
      if (!name) return fail("name is required to create a template");
      return callLegacy(
        "create_template",
        {
          name,
          ...(optionalStr(args.issueType) ? { issueType: str(args.issueType) } : {}),
          ...(optionalStr(args.description) ? { description: str(args.description) } : {}),
        },
        ctx,
      );
    }

    if (!templateId) return fail("templateId is required");

    switch (action) {
      case "update":
        return callLegacy(
          "update_template",
          {
            templateId,
            ...(optionalStr(args.name) ? { name: str(args.name) } : {}),
            ...(optionalStr(args.description) ? { description: str(args.description) } : {}),
          },
          ctx,
        );
      case "duplicate":
        return callLegacy("duplicate_template", { templateId }, ctx);
      case "activate":
        return callLegacy("activate_template", { templateId }, ctx);
      case "deactivate":
        return callLegacy("deactivate_template", { templateId }, ctx);
      default:
        return fail(`Unknown template action: ${action}`);
    }
  },
};

// ─── Roadmap ────────────────────────────────────────────────────────────────

export const roadmapGet: ConsolidatedTool = {
  name: "roadmap_get",
  domain: "roadmap",
  readOnly: true,
  description: "View the roadmap across projects, or one project's milestones and dependencies in detail.",
  parameters: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Get detail for one project. Omit for the whole roadmap." },
      teamId: { type: "string", description: "Restrict the roadmap to one team." },
      view: { type: "string", description: "Time window.", enum: ["QUARTER", "MONTH", "YEAR"] },
    },
  },
  handler: async (args, ctx) => {
    const projectId = optionalStr(args.projectId);
    if (projectId) return callLegacy("get_project_roadmap", { projectId }, ctx);

    return callLegacy(
      "list_roadmap",
      {
        ...(optionalStr(args.teamId) ? { teamId: str(args.teamId) } : {}),
        ...(optionalStr(args.view) ? { view: str(args.view).toUpperCase() } : {}),
      },
      ctx,
    );
  },
};

export const roadmapSchedule: ConsolidatedTool = {
  name: "roadmap_schedule",
  domain: "roadmap",
  readOnly: false,
  description: "Set or change a project's roadmap start and target dates.",
  parameters: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Project ID." },
      startDate: { type: "string", description: "Start date as YYYY-MM-DD." },
      targetDate: { type: "string", description: "Target completion date as YYYY-MM-DD." },
    },
    required: ["projectId"],
  },
  handler: async (args, ctx) => {
    const projectId = optionalStr(args.projectId);
    if (!projectId) return fail("projectId is required");

    const updates: Record<string, unknown> = {
      ...(optionalStr(args.startDate) ? { startDate: str(args.startDate) } : {}),
      ...(optionalStr(args.targetDate) ? { targetDate: str(args.targetDate) } : {}),
    };
    if (Object.keys(updates).length === 0) return fail("Provide startDate, targetDate, or both.");

    return callLegacy("update_project_schedule", { projectId, ...updates }, ctx);
  },
};

export const roadmapMilestones: ConsolidatedTool = {
  name: "roadmap_milestones",
  domain: "roadmap",
  readOnly: false,
  description: "Create, update or reorder milestones on a project's roadmap.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "What to do.", enum: ["create", "update", "reorder"] },
      projectId: { type: "string", description: "Project the milestone belongs to." },
      milestoneId: { type: "string", description: "Milestone ID (update)." },
      name: { type: "string", description: "Milestone name." },
      targetDate: { type: "string", description: "Target date as YYYY-MM-DD." },
      status: { type: "string", description: "Milestone status.", enum: ["planned", "in_progress", "completed"] },
      orderedIds: { type: "string", description: "JSON array of milestone IDs in the desired order (reorder)." },
    },
    required: ["action", "projectId"],
  },
  handler: async (args, ctx) => {
    const projectId = optionalStr(args.projectId);
    if (!projectId) return fail("projectId is required");

    switch (str(args.action)) {
      case "create": {
        const name = optionalStr(args.name);
        if (!name) return fail("name is required to create a milestone");
        return callLegacy(
          "create_milestone",
          {
            projectId,
            name,
            ...(optionalStr(args.targetDate) ? { targetDate: str(args.targetDate) } : {}),
          },
          ctx,
        );
      }
      case "update": {
        const milestoneId = optionalStr(args.milestoneId);
        if (!milestoneId) return fail("milestoneId is required to update a milestone");
        return callLegacy(
          "update_milestone",
          {
            projectId,
            milestoneId,
            ...(optionalStr(args.name) ? { name: str(args.name) } : {}),
            ...(optionalStr(args.targetDate) ? { targetDate: str(args.targetDate) } : {}),
            ...(optionalStr(args.status) ? { status: str(args.status).toUpperCase() } : {}),
          },
          ctx,
        );
      }
      case "reorder": {
        const orderedIds = strArray(args.orderedIds);
        if (orderedIds.length === 0) return fail("orderedIds is required to reorder milestones");
        return callLegacy("reorder_milestones", { projectId, milestoneIdsJson: JSON.stringify(orderedIds) }, ctx);
      }
      default:
        return fail(`Unknown milestone action: ${str(args.action)}`);
    }
  },
};

export const roadmapDependencies: ConsolidatedTool = {
  name: "roadmap_dependencies",
  domain: "roadmap",
  readOnly: false,
  description:
    "Create a project dependency, or resolve / cancel one. Requires being a lead of a project involved.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "What to do.", enum: ["create", "resolve", "cancel"] },
      blockingProjectId: { type: "string", description: "Project that must finish first (action=create)." },
      blockedProjectId: { type: "string", description: "Project that is waiting (action=create)." },
      dependencyId: { type: "string", description: "Dependency ID (resolve/cancel)." },
      note: { type: "string", description: "Why, for the audit trail." },
    },
    required: ["action"],
  },
  handler: async (args, ctx) => {
    const note = optionalStr(args.note);

    switch (str(args.action)) {
      case "create": {
        const blockingProjectId = optionalStr(args.blockingProjectId);
        const blockedProjectId = optionalStr(args.blockedProjectId);
        if (!blockingProjectId || !blockedProjectId) {
          return fail("blockingProjectId and blockedProjectId are both required");
        }
        return callLegacy(
          "create_roadmap_dependency",
          { blockingProjectId, blockedProjectId, ...(note ? { note } : {}) },
          ctx,
        );
      }
      case "resolve": {
        const dependencyId = optionalStr(args.dependencyId);
        if (!dependencyId) return fail("dependencyId is required");
        return callLegacy("resolve_roadmap_dependency", { dependencyId, ...(note ? { note } : {}) }, ctx);
      }
      case "cancel": {
        const dependencyId = optionalStr(args.dependencyId);
        if (!dependencyId) return fail("dependencyId is required");
        return callLegacy("cancel_roadmap_dependency", { dependencyId, ...(note ? { note } : {}) }, ctx);
      }
      default:
        return fail(`Unknown dependency action: ${str(args.action)}`);
    }
  },
};

export const planningTools: ConsolidatedTool[] = [
  cyclesSearch,
  cyclesGet,
  cyclesCreate,
  cyclesUpdate,
  templatesSearch,
  templatesGet,
  templatesManage,
  roadmapGet,
  roadmapSchedule,
  roadmapMilestones,
  roadmapDependencies,
];
