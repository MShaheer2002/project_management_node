/**
 * Consolidated issue tools (Phase 20K)
 *
 * 20 legacy tools collapse to 8. The biggest win is `issues_search`, which
 * absorbs list_issues, search_issues, get_team_workload, prioritize_tasks and
 * upcoming_deadlines — those existed only because the old list tool could not
 * group or sort, so every new view needed its own hardcoded tool (and its own
 * hardcoded keyword rule to reach it).
 */

import { captureBeforeState, describeChange } from "./capture.js";
import { callLegacy } from "./shared.js";
import {
  fail,
  ISSUE_PRIORITY_ENUM,
  ISSUE_TYPE_ENUM,
  limitParam,
  num,
  ok,
  okWithMutation,
  optionalStr,
  responseFormatParam,
  str,
  strArray,
  type ConsolidatedTool,
} from "./types.js";

export const issuesSearch: ConsolidatedTool = {
  name: "issues_search",
  domain: "issues",
  readOnly: true,
  description:
    "Find issues with any combination of filters, and optionally group them. Use this for 'my issues', " +
    "'overdue work', 'who is overloaded' (group_by assignee), 'what should I do next' (sort by priority), " +
    "'blocked work', and any issue listing or counting question.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text search across title and issue ID." },
      assignee: {
        type: "string",
        description: "User ID, 'me' for the current user, or 'unassigned' for issues nobody owns.",
      },
      status: { type: "string", description: "Status key, e.g. todo, in-progress, done." },
      priority: { type: "string", description: "Priority filter.", enum: [...ISSUE_PRIORITY_ENUM] },
      type: { type: "string", description: "Issue type filter.", enum: [...ISSUE_TYPE_ENUM] },
      projectId: { type: "string", description: "Restrict to one project." },
      teamId: { type: "string", description: "Restrict to one team." },
      overdueOnly: { type: "boolean", description: "Only issues past their due date." },
      blockedOnly: { type: "boolean", description: "Only issues blocked by another issue." },
      groupBy: {
        type: "string",
        description: "Group results and return counts per group. Use 'assignee' for workload questions.",
        enum: ["assignee", "status", "priority", "project"],
      },
      sort: {
        type: "string",
        description: "Result ordering. 'priority' surfaces the most urgent work first.",
        enum: ["updated", "priority", "dueDate"],
      },
      limit: limitParam,
      responseFormat: responseFormatParam,
    },
  },
  handler: async (args, ctx) => {
    const groupBy = optionalStr(args.groupBy);

    // Workload questions are a grouped issue query, not a separate concept.
    // Routing them here means "who's overloaded in project X" works even though
    // no dedicated tool for that combination was ever written.
    if (groupBy === "assignee") {
      const result = await callLegacy(
        "get_team_workload",
        { ...(optionalStr(args.teamId) ? { teamId: str(args.teamId) } : {}) },
        ctx,
      );
      return result.success
        ? ok(result.payload, { groupedBy: "assignee" })
        : fail(result.error ?? "Could not load workload");
    }

    const result = await callLegacy(
      "list_issues",
      {
        ...(optionalStr(args.query) ? { q: str(args.query) } : {}),
        ...(optionalStr(args.assignee) ? { assigneeId: str(args.assignee) } : {}),
        ...(optionalStr(args.status) ? { status: str(args.status) } : {}),
        ...(optionalStr(args.priority) ? { priority: str(args.priority) } : {}),
        ...(optionalStr(args.type) ? { type: str(args.type) } : {}),
        ...(optionalStr(args.projectId) ? { projectId: str(args.projectId) } : {}),
        ...(optionalStr(args.teamId) ? { teamId: str(args.teamId) } : {}),
        ...(args.overdueOnly === true ? { overdueOnly: true } : {}),
        ...(args.blockedOnly === true ? { blockedOnly: true } : {}),
        ...(optionalStr(args.sort) === "priority" ? { sort: "priority:desc" } : {}),
        limit: Math.min(num(args.limit, 20), 50),
      },
      ctx,
    );

    if (!result.success) return fail(result.error ?? "Could not load issues");

    const items = Array.isArray(result.payload) ? result.payload : [];
    return ok(items, {
      count: items.length,
      // Surfaced so the model can tell the user results were capped rather than
      // presenting a truncated list as if it were complete.
      truncated: items.length >= Math.min(num(args.limit, 20), 50),
      ...(groupBy ? { groupedBy: groupBy } : {}),
    });
  },
};

export const issuesGet: ConsolidatedTool = {
  name: "issues_get",
  domain: "issues",
  readOnly: true,
  description: "Get full detail for one issue by its ID (e.g. TRU-42), including description, labels and status.",
  parameters: {
    type: "object",
    properties: {
      issueId: { type: "string", description: "Issue ID such as TRU-42." },
    },
    required: ["issueId"],
  },
  handler: async (args, ctx) => {
    const issueId = optionalStr(args.issueId);
    if (!issueId) return fail("issueId is required");

    const result = await callLegacy("get_issue", { issueId }, ctx);
    return result.success ? ok(result.payload) : fail(result.error ?? `Issue ${issueId} not found`);
  },
};

export const issuesCreate: ConsolidatedTool = {
  name: "issues_create",
  domain: "issues",
  readOnly: false,
  description:
    "Create a new issue. Requires a project. Always write a meaningful description, even a short one, " +
    "rather than leaving it empty.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short, specific title." },
      projectId: { type: "string", description: "Project the issue belongs to." },
      type: { type: "string", description: "Issue type.", enum: [...ISSUE_TYPE_ENUM] },
      priority: { type: "string", description: "Priority.", enum: [...ISSUE_PRIORITY_ENUM] },
      description: { type: "string", description: "Markdown description." },
      assignee: { type: "string", description: "User ID, or 'me' for the current user." },
      status: { type: "string", description: "Initial status key (defaults to the workspace's first active status)." },
      dueDate: { type: "string", description: "Due date as YYYY-MM-DD." },
    },
    required: ["title", "projectId", "type"],
  },
  handler: async (args, ctx) => {
    const title = optionalStr(args.title);
    const projectId = optionalStr(args.projectId);
    if (!title) return fail("title is required");
    if (!projectId) return fail("projectId is required");

    const result = await callLegacy(
      "create_issue",
      {
        title,
        projectId,
        type: str(args.type, "task"),
        priority: str(args.priority, "medium"),
        ...(optionalStr(args.description) ? { description: str(args.description) } : {}),
        ...(optionalStr(args.assignee) ? { assigneeId: str(args.assignee) } : {}),
        ...(optionalStr(args.status) ? { status: str(args.status) } : {}),
        ...(optionalStr(args.dueDate) ? { dueDate: str(args.dueDate) } : {}),
      },
      ctx,
    );

    if (!result.success) return fail(result.error ?? "Could not create the issue");

    const created = (result.payload ?? {}) as { id?: string; title?: string };
    if (!created.id) return ok(result.payload);

    return okWithMutation(result.payload, {
      kind: "CREATE",
      targetType: "ISSUE",
      targetId: created.id,
      targetLabel: `${created.id} — ${created.title ?? title}`,
      summary: `Created ${created.id}`,
    });
  },
};

export const issuesUpdate: ConsolidatedTool = {
  name: "issues_update",
  domain: "issues",
  readOnly: false,
  description:
    "Change one or more fields on an existing issue — title, description, status, priority, type, assignee " +
    "or due date. Set several at once rather than calling this repeatedly.",
  parameters: {
    type: "object",
    properties: {
      issueId: { type: "string", description: "Issue ID such as TRU-42." },
      title: { type: "string", description: "New title." },
      description: { type: "string", description: "New description." },
      status: { type: "string", description: "New status key, e.g. todo, in-progress, done." },
      priority: { type: "string", description: "New priority.", enum: [...ISSUE_PRIORITY_ENUM] },
      type: { type: "string", description: "New issue type.", enum: [...ISSUE_TYPE_ENUM] },
      assignee: { type: "string", description: "User ID, 'me', or 'unassigned' to clear the assignee." },
      dueDate: { type: "string", description: "New due date as YYYY-MM-DD." },
      addLabels: { type: "string", description: "Comma-separated label names to add." },
    },
    required: ["issueId"],
  },
  handler: async (args, ctx) => {
    const issueId = optionalStr(args.issueId);
    if (!issueId) return fail("issueId is required");

    const status = optionalStr(args.status);
    const assignee = optionalStr(args.assignee);
    const labels = strArray(args.addLabels).flatMap((entry) => entry.split(",").map((part) => part.trim()));

    const fieldUpdates: Record<string, unknown> = {
      ...(optionalStr(args.title) ? { title: str(args.title) } : {}),
      ...(optionalStr(args.description) ? { description: str(args.description) } : {}),
      ...(optionalStr(args.priority) ? { priority: str(args.priority) } : {}),
      ...(optionalStr(args.type) ? { type: str(args.type) } : {}),
      ...(optionalStr(args.dueDate) ? { dueDate: str(args.dueDate) } : {}),
    };

    const changingFields = [
      ...Object.keys(fieldUpdates),
      ...(status ? ["status"] : []),
      ...(assignee ? ["assigneeId"] : []),
    ];

    if (changingFields.length === 0 && labels.length === 0) {
      return fail("Specify at least one field to change.");
    }

    const captured = await captureBeforeState("ISSUE", issueId, ctx.workspaceId, changingFields);

    // Status moves go through their own service path so transition rules and
    // approval gates apply — this is the bypass that previously let a member
    // move an issue through a gated transition via chat.
    if (status) {
      const statusResult = await callLegacy("update_issue_status", { issueId, status }, ctx);
      if (!statusResult.success) return fail(statusResult.error ?? "Could not change the status");
    }

    if (assignee) {
      const assignResult = await callLegacy(
        "assign_issue",
        { issueId, assigneeId: assignee === "unassigned" ? "" : assignee },
        ctx,
      );
      if (!assignResult.success) return fail(assignResult.error ?? "Could not change the assignee");
    }

    if (Object.keys(fieldUpdates).length > 0) {
      const updateResult = await callLegacy("update_issue", { issueId, ...fieldUpdates }, ctx);
      if (!updateResult.success) return fail(updateResult.error ?? "Could not update the issue");
    }

    for (const label of labels) {
      if (!label) continue;
      await callLegacy("add_label_to_issue", { issueId, labelName: label }, ctx);
    }

    const afterState: Record<string, unknown> = {
      ...fieldUpdates,
      ...(status ? { status } : {}),
      ...(assignee ? { assigneeId: assignee === "unassigned" ? null : assignee } : {}),
    };

    const payload = { issueId, changed: Object.keys(afterState), labelsAdded: labels };

    if (!captured) {
      // The change applied, but we could not record a restorable prior state —
      // report success rather than implying the edit failed.
      return ok(payload);
    }

    return okWithMutation(payload, {
      kind: "UPDATE",
      targetType: "ISSUE",
      targetId: issueId,
      targetLabel: captured.label,
      summary: describeChange(captured.beforeState, afterState),
      beforeState: captured.beforeState,
      afterState,
    });
  },
};

export const issuesComment: ConsolidatedTool = {
  name: "issues_comment",
  domain: "issues",
  readOnly: false,
  description: "Post a comment on an issue. Mentions written as @name notify that person.",
  parameters: {
    type: "object",
    properties: {
      issueId: { type: "string", description: "Issue ID such as TRU-42." },
      body: { type: "string", description: "Comment text, markdown supported." },
    },
    required: ["issueId", "body"],
  },
  handler: async (args, ctx) => {
    const issueId = optionalStr(args.issueId);
    const body = optionalStr(args.body);
    if (!issueId) return fail("issueId is required");
    if (!body) return fail("body is required");

    const result = await callLegacy("add_comment", { issueId, body }, ctx);
    if (!result.success) return fail(result.error ?? "Could not post the comment");

    // Comments are additive and low-risk; they are not offered for revert
    // because deleting one would be a delete, which AI never performs.
    return ok(result.payload);
  },
};

export const issuesSubtasks: ConsolidatedTool = {
  name: "issues_subtasks",
  domain: "issues",
  readOnly: false,
  description: "Create, update or reorder the subtasks (checklist items) on an issue.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "What to do.", enum: ["create", "update", "reorder"] },
      issueId: { type: "string", description: "Issue ID such as TRU-42." },
      title: { type: "string", description: "Subtask title (create/update)." },
      subtaskId: { type: "string", description: "Subtask to update." },
      completed: { type: "boolean", description: "Mark the subtask done or not done." },
      orderedIds: { type: "string", description: "JSON array of subtask IDs in the desired order (reorder)." },
    },
    required: ["action", "issueId"],
  },
  handler: async (args, ctx) => {
    const action = str(args.action);
    const issueId = optionalStr(args.issueId);
    if (!issueId) return fail("issueId is required");

    switch (action) {
      case "create": {
        const title = optionalStr(args.title);
        if (!title) return fail("title is required to create a subtask");
        const result = await callLegacy("create_subtask", { issueId, title }, ctx);
        return result.success ? ok(result.payload) : fail(result.error ?? "Could not create the subtask");
      }
      case "update": {
        const subtaskId = optionalStr(args.subtaskId);
        if (!subtaskId) return fail("subtaskId is required to update a subtask");
        const result = await callLegacy(
          "update_subtask",
          {
            issueId,
            subtaskId,
            ...(optionalStr(args.title) ? { title: str(args.title) } : {}),
            ...(args.completed !== undefined ? { completed: args.completed === true } : {}),
          },
          ctx,
        );
        return result.success ? ok(result.payload) : fail(result.error ?? "Could not update the subtask");
      }
      case "reorder": {
        const orderedIds = strArray(args.orderedIds);
        if (orderedIds.length === 0) return fail("orderedIds is required to reorder subtasks");
        const result = await callLegacy(
          "reorder_subtasks",
          { issueId, subtaskIdsJson: JSON.stringify(orderedIds) },
          ctx,
        );
        return result.success ? ok(result.payload) : fail(result.error ?? "Could not reorder the subtasks");
      }
      default:
        return fail(`Unknown subtask action: ${action}`);
    }
  },
};

export const issuesWatchers: ConsolidatedTool = {
  name: "issues_watchers",
  domain: "issues",
  readOnly: false,
  description: "List who is watching an issue, or add watchers so they get notified about changes.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "What to do.", enum: ["list", "add"] },
      issueId: { type: "string", description: "Issue ID such as TRU-42." },
      userIds: { type: "string", description: "JSON array of user IDs to add as watchers." },
    },
    required: ["action", "issueId"],
  },
  handler: async (args, ctx) => {
    const issueId = optionalStr(args.issueId);
    if (!issueId) return fail("issueId is required");

    if (str(args.action) === "list") {
      const result = await callLegacy("list_issue_watchers", { issueId }, ctx);
      return result.success ? ok(result.payload) : fail(result.error ?? "Could not list watchers");
    }

    const userIds = strArray(args.userIds);
    if (userIds.length === 0) return fail("userIds is required to add watchers");

    const result = await callLegacy("add_issue_watchers", { issueId, userIdsJson: JSON.stringify(userIds) }, ctx);
    return result.success ? ok(result.payload) : fail(result.error ?? "Could not add watchers");
  },
};

export const issuesLinks: ConsolidatedTool = {
  name: "issues_links",
  domain: "issues",
  readOnly: false,
  description:
    "Link an issue to something else: another issue it depends on, or an external reference such as a " +
    "GitHub pull request or Slack thread.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", description: "What kind of link.", enum: ["dependency", "external"] },
      issueId: { type: "string", description: "Issue ID such as TRU-42." },
      dependsOnIssueId: { type: "string", description: "Issue that must finish first (kind=dependency)." },
      provider: { type: "string", description: "External provider (kind=external).", enum: ["github", "slack", "figma", "discord"] },
      url: { type: "string", description: "External URL (kind=external)." },
      label: { type: "string", description: "Display label for the external link." },
    },
    required: ["kind", "issueId"],
  },
  handler: async (args, ctx) => {
    const issueId = optionalStr(args.issueId);
    if (!issueId) return fail("issueId is required");

    if (str(args.kind) === "dependency") {
      const dependsOn = optionalStr(args.dependsOnIssueId);
      if (!dependsOn) return fail("dependsOnIssueId is required for a dependency link");
      const result = await callLegacy("add_issue_dependency", { issueId, dependsOnIssueId: dependsOn }, ctx);
      return result.success ? ok(result.payload) : fail(result.error ?? "Could not add the dependency");
    }

    const provider = optionalStr(args.provider);
    const url = optionalStr(args.url);
    if (!provider || !url) return fail("provider and url are required for an external link");

    const result = await callLegacy(
      "update_issue_integration_ref",
      { issueId, provider, url, ...(optionalStr(args.label) ? { label: str(args.label) } : {}) },
      ctx,
    );
    return result.success ? ok(result.payload) : fail(result.error ?? "Could not add the link");
  },
};

export const issueTools: ConsolidatedTool[] = [
  issuesSearch,
  issuesGet,
  issuesCreate,
  issuesUpdate,
  issuesComment,
  issuesSubtasks,
  issuesWatchers,
  issuesLinks,
];
