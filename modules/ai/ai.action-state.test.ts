import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { resolveAiPreflight, type PendingAiAction } from "./ai.action-state.js";
import type { ConversationMemory } from "./ai.memory.js";
import { prisma } from "../../shared/utils/prisma.js";

type FindManyMock = (...args: Array<unknown>) => Promise<Array<unknown>>;

const originalProjectFindMany = prisma.project.findMany.bind(prisma.project);
const originalTeamFindMany = prisma.team.findMany.bind(prisma.team);
const originalIssueFindMany = prisma.issue.findMany.bind(prisma.issue);
const originalWorkspaceMembershipFindMany = prisma.workspaceMembership.findMany.bind(prisma.workspaceMembership);
const originalCycleFindMany = (prisma as any).cycle.findMany.bind((prisma as any).cycle);

function stubFindMany(target: unknown, value: Array<unknown>) {
  (target as { findMany: FindManyMock }).findMany = (async () => value) as FindManyMock;
}

function createInput(overrides: Partial<{
  message: string;
  pendingAction: PendingAiAction | null;
  conversationMemory: ConversationMemory | null;
  workspaceId: string;
  userId: string;
  userRole: string;
}> = {}) {
  return {
    message: overrides.message ?? "hello",
    pendingAction: overrides.pendingAction ?? null,
    conversationMemory: overrides.conversationMemory ?? null,
    workspaceId: overrides.workspaceId ?? "ws-1",
    userId: overrides.userId ?? "user-1",
    userRole: overrides.userRole ?? "MEMBER",
  };
}

function createPendingAction(input: Partial<PendingAiAction>): PendingAiAction {
  const now = new Date().toISOString();
  return {
    action: input.action ?? "invite_member",
    status: input.status ?? "collecting_slots",
    slots: input.slots ?? {},
    missing: input.missing ?? [],
    prompt: input.prompt ?? "seed prompt",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    ...(input.ambiguity ? { ambiguity: input.ambiguity } : {}),
    ...(input.confirmationRequired ? { confirmationRequired: true } : {}),
  };
}

afterEach(() => {
  prisma.project.findMany = originalProjectFindMany;
  prisma.team.findMany = originalTeamFindMany;
  prisma.issue.findMany = originalIssueFindMany;
  prisma.workspaceMembership.findMany = originalWorkspaceMembershipFindMany;
  (prisma as any).cycle.findMany = originalCycleFindMany;
});

test("blocks delete requests with a no-delete boundary", async () => {
  const result = await resolveAiPreflight(createInput({
    message: "Delete issue FIS-15",
  }));

  assert.equal(result.kind, "respond");
  assert.match(result.content, /cannot delete anything/i);
  assert.equal(result.pendingAction?.action, "delete_boundary");
  assert.equal(result.pendingAction?.status, "blocked_boundary");
  assert.equal(result.pendingAction?.slots.targetRef, "FIS-15");
});

test("handles vague revert without mutating anything", async () => {
  const result = await resolveAiPreflight(createInput({
    message: "revert what you did",
  }));

  assert.equal(result.kind, "respond");
  assert.match(result.content, /exact restore action/i);
  assert.equal(result.pendingAction, null);
});

test("resolves high-impact actions before asking for confirmation", async () => {
  const result = await resolveAiPreflight(createInput({
    message: "change Ahmed to admin",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.pendingAction, null);
  assert.match(result.systemContext ?? "", /resolve the exact target/i);
  assert.match(result.systemContext ?? "", /tool returns confirmationRequired/i);
});

test("treats remove-from-team phrasing as high-impact without routing into delete flow", async () => {
  stubFindMany(prisma.team, [{ id: "team-1", name: "Design" }]);
  stubFindMany(prisma.workspaceMembership, [{
    user: { id: "user-9", name: "Unknown Shaheer" },
  }]);

  const result = await resolveAiPreflight(createInput({
    message: "remove @Unknown Shaheer from design team",
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "high_impact_action");
  assert.equal(result.pendingAction?.status, "awaiting_confirmation");
  assert.equal(result.pendingAction?.slots.toolName, "remove_team_member");
  assert.equal(result.pendingAction?.slots.teamId, "team-1");
  assert.equal(result.pendingAction?.slots.userId, "user-9");
  assert.match(result.content, /reply `confirm`/i);
});

test("builds exact confirmation payload for workspace member removal", async () => {
  stubFindMany(prisma.workspaceMembership, [{
    user: { id: "user-4", name: "Ahmed Khan" },
  }]);

  const result = await resolveAiPreflight(createInput({
    message: "remove @Ahmed Khan from workspace",
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "high_impact_action");
  assert.equal(result.pendingAction?.status, "awaiting_confirmation");
  assert.equal(result.pendingAction?.slots.toolName, "remove_workspace_member");
  assert.equal(result.pendingAction?.slots.userId, "user-4");
  assert.match(result.content, /remove Ahmed Khan from the workspace/i);
});

test("uses membership-removal-specific ambiguity copy for duplicate member matches", async () => {
  stubFindMany(prisma.team, [{ id: "team-1", name: "Design" }]);
  stubFindMany(prisma.workspaceMembership, [
    { user: { id: "user-1", name: "Unknown Shaheer" } },
    { user: { id: "user-2", name: "Unknown Shaheer" } },
  ]);

  const result = await resolveAiPreflight(createInput({
    message: "remove @Unknown Shaheer from design team",
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "high_impact_action");
  assert.equal(result.pendingAction?.status, "collecting_slots");
  assert.match(result.content, /which member should i remove/i);
  assert.match(result.content, /reply with the exact option/i);
  assert.match(result.content, /Unknown Shaheer \[user-1\]/);
  assert.match(result.content, /Unknown Shaheer \[user-2\]/);
});

test("does not treat a shorter member name as a match for a longer @mention", async () => {
  stubFindMany(prisma.team, [{ id: "team-1", name: "Design" }]);
  stubFindMany(prisma.workspaceMembership, [
    { user: { id: "user-1", name: "Unknown Shaheer" } },
    { user: { id: "user-2", name: "Unknown" } },
  ]);

  const result = await resolveAiPreflight(createInput({
    message: "remove @Unknown Shaheer from design team",
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.status, "awaiting_confirmation");
  assert.equal(result.pendingAction?.slots.userId, "user-1");
  assert.doesNotMatch(result.content, /Which member should I remove/i);
});

test("collects missing team slot for create-project requests before any tool execution", async () => {
  const result = await resolveAiPreflight(createInput({
    message: "Create a project called AI Assistant.",
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "create_project");
  assert.deepEqual(result.pendingAction?.missing, ["team"]);
  assert.equal(result.pendingAction?.slots.name, "AI Assistant");
  assert.match(result.content, /which team should own this project/i);
});

test("extracts project name from broken punctuation in create-project requests", async () => {
  const result = await resolveAiPreflight(createInput({
    message: "create. a project called SulitCheck app",
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "create_project");
  assert.deepEqual(result.pendingAction?.missing, ["team"]);
  assert.equal(result.pendingAction?.slots.name, "SulitCheck app");
  assert.match(result.content, /which team should own this project/i);
});

test("accepts a direct follow-up reply as the missing project name", async () => {
  const pending = createPendingAction({
    action: "create_project",
    status: "collecting_slots",
    slots: {},
    missing: ["name", "team"],
    prompt: "create project",
  });

  const result = await resolveAiPreflight(createInput({
    message: "SulitCheck app",
    pendingAction: pending,
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "create_project");
  assert.equal(result.pendingAction?.slots.name, "SulitCheck app");
  assert.deepEqual(result.pendingAction?.missing, ["team"]);
});

test("continues create-project pending action when the user later supplies the team", async () => {
  stubFindMany(prisma.team, [{ id: "team-1", name: "Design Team" }]);

  const pending = createPendingAction({
    action: "create_project",
    status: "collecting_slots",
    slots: { name: "AI Assistant" },
    missing: ["team"],
    prompt: "Create a project called AI Assistant.",
  });

  const result = await resolveAiPreflight(createInput({
    message: "Design Team",
    pendingAction: pending,
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.pendingAction, null);
  assert.equal(result.resolvedToolName, "create_project");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ name: "AI Assistant", teamId: "team-1" }));
});

test("routes project rename requests into deterministic project updates", async () => {
  stubFindMany(prisma.project, [{ id: "project-1", name: "demoda" }]);

  const result = await resolveAiPreflight(createInput({
    message: "Rename demoda to Demoda Mobile",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.pendingAction, null);
  assert.equal(result.resolvedToolName, "update_project");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ projectId: "project-1", name: "Demoda Mobile" }));
});

test("asks only for the missing project when a rename target is unresolved", async () => {
  stubFindMany(prisma.project, []);

  const result = await resolveAiPreflight(createInput({
    message: "Rename demoda to Demoda Mobile",
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "project_action");
  assert.equal(result.pendingAction?.slots.name, "Demoda Mobile");
  assert.deepEqual(result.pendingAction?.missing, ["project"]);
  assert.match(result.content, /which project should i update/i);
});

test("uses current project memory when asking to update project description", async () => {
  stubFindMany(prisma.project, [{ id: "project-1", name: "Demoda Mobile" }]);

  const result = await resolveAiPreflight(createInput({
    message: "Update project description.",
    conversationMemory: {
      currentProjectId: "project-1",
      lastResolvedEntities: [{ entityType: "project", entityId: "project-1", name: "Demoda Mobile" }],
      recentReferences: [],
    },
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "project_action");
  assert.equal(result.pendingAction?.slots.projectId, "project-1");
  assert.equal(result.pendingAction?.slots.updateFieldTarget, "description");
  assert.deepEqual(result.pendingAction?.missing, ["updateField"]);
  assert.match(result.content, /new description for Demoda Mobile/i);
});

test("treats the next plain sentence as the pending project description value", async () => {
  const pending = createPendingAction({
    action: "project_action",
    status: "collecting_slots",
    slots: {
      intent: "UPDATE_PROJECT",
      projectId: "project-1",
      projectLabel: "Demoda Mobile",
      updateFieldTarget: "description",
    },
    missing: ["updateField"],
    prompt: "Update project description.",
  });

  const result = await resolveAiPreflight(createInput({
    message: "This is the clone of Tikshot enterprice, need some new feature and remove bugs",
    pendingAction: pending,
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.pendingAction, null);
  assert.equal(result.resolvedToolName, "update_project");
  assert.equal(
    result.resolvedToolArgsJson,
    JSON.stringify({
      projectId: "project-1",
      description: "This is the clone of Tikshot enterprice, need some new feature and remove bugs",
    }),
  );
});

test("fills the missing project first before consuming a description reply", async () => {
  stubFindMany(prisma.project, [{ id: "project-1", name: "Demoda Mobile" }]);

  const pending = createPendingAction({
    action: "project_action",
    status: "collecting_slots",
    slots: {
      intent: "UPDATE_PROJECT",
      updateFieldTarget: "description",
    },
    missing: ["project", "updateField"],
    prompt: "Update project description.",
  });

  const result = await resolveAiPreflight(createInput({
    message: "Demoda Mobile",
    pendingAction: pending,
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "project_action");
  assert.equal(result.pendingAction?.slots.projectId, "project-1");
  assert.equal(result.pendingAction?.slots.projectLabel, "Demoda Mobile");
  assert.equal(result.pendingAction?.slots.updateFieldTarget, "description");
  assert.equal(result.pendingAction?.slots.description, undefined);
  assert.deepEqual(result.pendingAction?.missing, ["updateField"]);
  assert.match(result.content, /new description for Demoda Mobile/i);
});

test("binds confirmed high-impact actions to the exact stored tool call", async () => {
  const pending = createPendingAction({
    action: "high_impact_action",
    status: "awaiting_confirmation",
    confirmationRequired: true,
    slots: {
      toolName: "remove_workspace_member",
      toolArgsJson: JSON.stringify({ userId: "user-9" }),
    },
  });

  const result = await resolveAiPreflight(createInput({
    message: "Confirm",
    pendingAction: pending,
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.pendingAction, null);
  assert.equal(result.confirmedHighImpact, true);
  assert.equal(result.confirmedHighImpactToolName, "remove_workspace_member");
  assert.equal(result.confirmedHighImpactToolArgsJson, JSON.stringify({ userId: "user-9" }));
  assert.equal(result.compactMode, "confirmation");
  assert.equal(result.historyLimit, 1);
});

test("asks for email first when invite intent is incomplete", async () => {
  stubFindMany(prisma.team, []);

  const result = await resolveAiPreflight(createInput({
    message: "invite someone to backend",
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "invite_member");
  assert.deepEqual(result.pendingAction?.missing, ["email", "role", "team"]);
  assert.match(result.content, /email address/i);
});

test("preserves invite pending state across turns and advances one missing slot at a time", async () => {
  stubFindMany(prisma.team, []);

  const pending = createPendingAction({
    action: "invite_member",
    status: "collecting_slots",
    slots: { teamId: "team-1" },
    missing: ["email", "role"],
    prompt: "invite someone to backend",
  });

  const result = await resolveAiPreflight(createInput({
    message: "ahmed@example.com",
    pendingAction: pending,
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "invite_member");
  assert.equal(result.pendingAction?.slots.email, "ahmed@example.com");
  assert.equal(result.pendingAction?.slots.teamId, "team-1");
  assert.deepEqual(result.pendingAction?.missing, ["role"]);
  assert.match(result.content, /what role/i);
});

test("asks for analytics scope when the prompt is missing one", async () => {
  const result = await resolveAiPreflight(createInput({
    message: "Who is overloaded?",
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "analytics_report");
  assert.deepEqual(result.pendingAction?.missing, ["scope"]);
  assert.match(result.content, /which scope should i report on/i);
});

test("asks for report-type clarification when the request is too generic", async () => {
  const result = await resolveAiPreflight(createInput({
    message: "create a report",
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "analytics_report");
  assert.deepEqual(result.pendingAction?.missing, ["scope"]);
  assert.match(result.content, /which report should i prepare/i);
  assert.match(result.content, /workspace report/i);
  assert.match(result.content, /project report/i);
});

test("resolves typo-heavy role questions through deterministic access summary", async () => {
  const result = await resolveAiPreflight(createInput({
    message: "tell me what is my rle",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.pendingAction, null);
  assert.equal(result.resolvedToolName, "get_workspace_access_summary");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({}));
});

test("blocks destructive billing and credential requests explicitly", async () => {
  const billing = await resolveAiPreflight(createInput({
    message: "cancel the workspace subscription right now",
  }));
  const apiKey = await resolveAiPreflight(createInput({
    message: "revoke that api key permanently",
  }));

  assert.equal(billing.kind, "respond");
  assert.match(billing.content, /cannot make destructive billing/i);
  assert.equal(apiKey.kind, "respond");
  assert.match(apiKey.content, /api key/i);
});

test("routes broad project-health phrasing into project analytics flow", async () => {
  stubFindMany(prisma.project, [{ id: "p1", name: "Ridely App" }]);

  const result = await resolveAiPreflight(createInput({
    message: "I think Ridely App is in bad shape",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.resolvedToolName, "get_project_analytics");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ projectId: "p1" }));
});

test("resolves contained project names in broad health questions", async () => {
  stubFindMany(prisma.project, [{ id: "p1", name: "Telegrant" }]);

  const result = await resolveAiPreflight(createInput({
    message: "How is Telegrant doing?",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.resolvedToolName, "get_project_analytics");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ projectId: "p1" }));
});

test("routes broad tell-me-about project prompts into project analytics flow", async () => {
  stubFindMany(prisma.project, [{ id: "p1", name: "Ridely App" }]);

  const result = await resolveAiPreflight(createInput({
    message: "Tell me about Ridely.",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.resolvedToolName, "get_project_analytics");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ projectId: "p1" }));
});

test("does not fall back to conversation context when a fresh project name is present", async () => {
  stubFindMany(prisma.project, [
    { id: "p1", name: "Ridely App" },
    { id: "p2", name: "Telegrant" },
  ]);

  const result = await resolveAiPreflight(createInput({
    message: "Is Ridely healthy?",
    conversationMemory: {
      currentProjectId: "p2",
      lastResolvedEntities: [{ entityType: "project", entityId: "p2", name: "Telegrant" }],
      recentReferences: [],
    },
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.resolvedToolName, "get_project_analytics");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ projectId: "p1" }));
});

test("routes my tasks into deterministic issue listing", async () => {
  const result = await resolveAiPreflight(createInput({
    message: "show my tasks",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.resolvedToolName, "list_issues");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ assigneeId: "me" }));
});

test("routes navigation help into deterministic app help", async () => {
  const result = await resolveAiPreflight(createInput({
    message: "where can i find projects?",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.resolvedToolName, "app_help");
});

test("collects issue mutation slots for assignment flows", async () => {
  stubFindMany(prisma.issue, [{ id: "FIS-21", title: "Login broken on Safari" }]);
  stubFindMany(prisma.workspaceMembership, [{ user: { id: "user-2", name: "Ali Khan" } }]);

  const result = await resolveAiPreflight(createInput({
    message: "assign FIS-21 to Ali Khan",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.resolvedToolName, "assign_issue");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ issueId: "FIS-21", assigneeId: "user-2" }));
});

test("expires stale pending confirmations safely", async () => {
  const stale = createPendingAction({
    action: "high_impact_action",
    status: "awaiting_confirmation",
    updatedAt: new Date(Date.now() - (16 * 60 * 1000)).toISOString(),
    slots: {
      toolName: "remove_team_member",
      toolArgsJson: JSON.stringify({ teamId: "team-1", userId: "user-2" }),
    },
  });

  const result = await resolveAiPreflight(createInput({
    message: "confirm",
    pendingAction: stale,
  }));

  assert.equal(result.kind, "respond");
  assert.match(result.content, /expired/i);
});

test("resolves workspace analytics to an exact tool after scope clarification", async () => {
  const pending = createPendingAction({
    action: "analytics_report",
    status: "collecting_slots",
    slots: {},
    missing: ["scope"],
    prompt: "Who is overloaded?",
  });

  const result = await resolveAiPreflight(createInput({
    message: "workspace",
    pendingAction: pending,
    userRole: "ADMIN",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.pendingAction, null);
  assert.equal(result.resolvedToolName, "get_workspace_analytics");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({}));
  assert.equal(result.resolvedResponseMode, "overloaded");
});

test("returns project ambiguity options for analytics prompts", async () => {
  stubFindMany(prisma.project, [
    { id: "p1", name: "Ridely App" },
    { id: "p2", name: "Ridely Admin" },
  ]);

  const result = await resolveAiPreflight(createInput({
    message: "show project report for project: Ridely",
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "analytics_report");
  assert.equal(result.pendingAction?.ambiguity?.[0]?.field, "project");
  assert.match(result.content, /available projects:/i);
  assert.match(result.content, /Ridely App/);
  assert.match(result.content, /Ridely Admin/);
});

test("resolves natural-language project analytics requests without re-asking for project", async () => {
  stubFindMany(prisma.project, [
    { id: "p1", name: "Ridely App" },
  ]);

  const result = await resolveAiPreflight(createInput({
    message: "give me report of ridely app",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.pendingAction, null);
  assert.equal(result.resolvedToolName, "get_project_analytics");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ projectId: "p1" }));
});

test("uses conversation memory for 'compare it with' follow-up project comparisons", async () => {
  stubFindMany(prisma.project, [
    { id: "p1", name: "Ridely App" },
    { id: "p2", name: "USingle2 App" },
  ]);

  const result = await resolveAiPreflight(createInput({
    message: "compare it with USingle2 App",
    conversationMemory: {
      currentProjectId: "p1",
      lastResolvedEntities: [{ entityType: "project", entityId: "p1", name: "Ridely App" }],
      recentReferences: ["it"],
    },
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.resolvedToolName, "compare_projects");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ projectId: "p1", comparisonTarget: "p2" }));
});

test("uses conversation memory for vague project-risk follow-ups", async () => {
  stubFindMany(prisma.project, [
    { id: "p1", name: "Ridely App" },
  ]);

  const result = await resolveAiPreflight(createInput({
    message: "Should I worry about it",
    conversationMemory: {
      currentProjectId: "p1",
      lastResolvedEntities: [{ entityType: "project", entityId: "p1", name: "Ridely App" }],
      recentReferences: ["it"],
    },
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.resolvedToolName, "get_project_analytics");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ projectId: "p1" }));
});

test("resolves repeated natural-language project report after an initial scope clarification turn", async () => {
  stubFindMany(prisma.project, [
    { id: "p1", name: "Ridely App" },
  ]);

  const pending = createPendingAction({
    action: "analytics_report",
    status: "collecting_slots",
    slots: {},
    missing: ["scope"],
    prompt: "give me report",
  });

  const result = await resolveAiPreflight(createInput({
    message: "give me report of ridely app",
    pendingAction: pending,
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.pendingAction, null);
  assert.equal(result.resolvedToolName, "get_project_analytics");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ projectId: "p1" }));
});

test("drops stale analytics clarification when the user starts a new invite request", async () => {
  stubFindMany(prisma.team, [{ id: "team-1", name: "Design Team" }]);

  const pending = createPendingAction({
    action: "analytics_report",
    status: "collecting_slots",
    slots: { scopeKind: "project" },
    missing: ["project"],
    prompt: "give me report",
  });

  const result = await resolveAiPreflight(createInput({
    message: "invite m.shaheer13@gmail.com to design team",
    pendingAction: pending,
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "invite_member");
  assert.match(result.content, /what role should they have/i);
});

test("drops stale analytics clarification when the user sends a fresh project report request", async () => {
  stubFindMany(prisma.project, [
    { id: "p1", name: "Ridely App" },
    { id: "p2", name: "USingle2 App" },
  ]);

  const pending = createPendingAction({
    action: "analytics_report",
    status: "collecting_slots",
    slots: {},
    missing: ["scope"],
    prompt: "give me report of ridely app",
  });

  const result = await resolveAiPreflight(createInput({
    message: "give me report of usingle2 app",
    pendingAction: pending,
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.pendingAction, null);
  assert.equal(result.resolvedToolName, "get_project_analytics");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ projectId: "p2" }));
});

test("routes resolved issue creation through deterministic tool guidance", async () => {
  stubFindMany(prisma.project, [
    { id: "p1", name: "Ridely App" },
  ]);

  const result = await resolveAiPreflight(createInput({
    message: "create a issue, login not working in ridely app",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.pendingAction, null);
  assert.match(result.systemContext ?? "", /Issue creation project is resolved/i);
  assert.match(result.systemContext ?? "", /\"projectId\":\"p1\"/);
});

test("uses conversation memory for follow-up issue assignment and status updates", async () => {
  stubFindMany(prisma.issue, [{ id: "FIS-21", title: "Login broken on Safari" }]);
  stubFindMany(prisma.workspaceMembership, [{ user: { id: "user-2", name: "Ali Khan" } }]);

  const assign = await resolveAiPreflight(createInput({
    message: "assign it to Ali Khan",
    conversationMemory: {
      currentIssueId: "FIS-21",
      lastResolvedEntities: [{ entityType: "issue", entityId: "FIS-21", name: "Login broken on Safari" }],
      recentReferences: ["it"],
    },
  }));

  assert.equal(assign.kind, "continue");
  assert.equal(assign.resolvedToolName, "assign_issue");
  assert.equal(assign.resolvedToolArgsJson, JSON.stringify({ issueId: "FIS-21", assigneeId: "user-2" }));

  const update = await resolveAiPreflight(createInput({
    message: "move that to review",
    conversationMemory: {
      currentIssueId: "FIS-21",
      lastResolvedEntities: [{ entityType: "issue", entityId: "FIS-21", name: "Login broken on Safari" }],
      recentReferences: ["that"],
    },
  }));

  assert.equal(update.kind, "continue");
  assert.equal(update.resolvedToolName, "update_issue_status");
  assert.equal(update.resolvedToolArgsJson, JSON.stringify({ issueId: "FIS-21", status: "review" }));
});

test("treats broken-grammar member assignment follow-up as a continuation, not a fresh request", async () => {
  stubFindMany(prisma.issue, [{ id: "FIS-21", title: "Login broken on Safari" }]);
  stubFindMany(prisma.workspaceMembership, [{ user: { id: "user-2", name: "Ali Khan" } }]);

  const result = await resolveAiPreflight(createInput({
    message: "assign it ali",
    conversationMemory: {
      currentIssueId: "FIS-21",
      lastResolvedEntities: [{ entityType: "issue", entityId: "FIS-21", name: "Login broken on Safari" }],
      recentReferences: ["it"],
    },
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.resolvedToolName, "assign_issue");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ issueId: "FIS-21", assigneeId: "user-2" }));
});

test("accepts emoji-heavy mixed-language analytics prompts through semantic routing", async () => {
  stubFindMany(prisma.project, [{ id: "p1", name: "Ridely App" }]);

  const result = await resolveAiPreflight(createInput({
    message: "🚨 Ridely app ka status kya hai??",
  }));

  assert.ok(result.kind === "continue" || result.kind === "respond");
});

test("resolves member analytics for 'my' prompts without ambiguity", async () => {
  const result = await resolveAiPreflight(createInput({
    message: "give me my last 5 day report",
    userId: "member-7",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.pendingAction, null);
  assert.match(result.systemContext ?? "", /memberId\":\"member-7\"/);
  assert.match(result.systemContext ?? "", /Use the scoped analytics tool/i);
});

test("does not treat 'give me' as a self-member report when the entity is a project", async () => {
  stubFindMany(prisma.project, [{ id: "p1", name: "Ridely App" }]);
  stubFindMany(prisma.workspaceMembership, []);
  stubFindMany(prisma.team, []);
  stubFindMany(prisma.cycle, []);

  const result = await resolveAiPreflight(createInput({
    message: "Give me a report for Ridely.",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.resolvedToolName, "get_project_analytics");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ projectId: "p1" }));
});

test("infers project analytics scope from a resolved entity when the business prompt omits scope words", async () => {
  stubFindMany(prisma.project, [{ id: "p1", name: "Ridely App" }]);
  stubFindMany(prisma.team, []);
  stubFindMany(prisma.workspaceMembership, []);
  stubFindMany(prisma.cycle, []);

  const result = await resolveAiPreflight(createInput({
    message: "Show Ridely analytics.",
  }));

  assert.equal(result.kind, "continue");
  assert.equal(result.resolvedToolName, "get_project_analytics");
  assert.equal(result.resolvedToolArgsJson, JSON.stringify({ projectId: "p1" }));
});

test("requires file metadata for document creation intents", async () => {
  stubFindMany(prisma.team, []);
  stubFindMany(prisma.project, []);

  const result = await resolveAiPreflight(createInput({
    message: "upload a runbook to the workspace docs",
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "create_document");
  assert.match(result.content, /attach or upload the file first/i);
});

test("treats expired pending actions as invalid and asks for a fresh request", async () => {
  const expired = new Date(Date.now() - (16 * 60 * 1000)).toISOString();
  const pending = createPendingAction({
    action: "invite_member",
    status: "collecting_slots",
    missing: ["email"],
    updatedAt: expired,
    createdAt: expired,
  });

  const result = await resolveAiPreflight(createInput({
    message: "ahmed@example.com",
    pendingAction: pending,
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction, null);
  assert.match(result.content, /pending action expired/i);
});

test("keeps delete-boundary protection when the user keeps pressuring for deletion", async () => {
  const pending = createPendingAction({
    action: "delete_boundary",
    status: "blocked_boundary",
    slots: { targetRef: "FIS-15" },
    missing: [],
    prompt: "delete FIS-15",
  });

  const result = await resolveAiPreflight(createInput({
    message: "please delete it",
    pendingAction: pending,
  }));

  assert.equal(result.kind, "respond");
  assert.equal(result.pendingAction?.action, "delete_boundary");
  assert.match(result.content, /will not mark it done, unassign it, archive it/i);
});
