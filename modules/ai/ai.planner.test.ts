import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExecutionPlan,
  getPendingPlanSteps,
  observeAndReplanExecution,
} from "./ai.planner.js";

test("builds multi-step compare-projects plan", () => {
  const plan = buildExecutionPlan({
    intent: "COMPARE_PROJECTS",
    slots: {
      projectId: "p-left",
      comparisonTarget: "p-right",
    },
  });

  assert.equal(plan.requiresUserInput, false);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0]?.executor, "get_project_analytics");
  assert.equal(plan.steps[1]?.executor, "get_project_analytics");
});

test("replanning stops after a failed step", () => {
  const plan = buildExecutionPlan({
    intent: "COMPARE_PROJECTS",
    slots: {
      projectId: "p-left",
      comparisonTarget: "p-right",
    },
  });

  const observation = {
    stepId: plan.steps[0]!.id,
    executor: plan.steps[0]!.executor,
    result: {
      success: false,
      payload: null,
      warnings: [],
      nextSuggestions: [],
      error: "failed",
    },
  };

  const replanned = observeAndReplanExecution({
    plan,
    observations: [observation],
  });

  assert.equal(replanned.shouldStop, true);
  assert.equal(replanned.plan.steps.length, 1);
});

test("pending plan steps shrink as observations are recorded", () => {
  const plan = buildExecutionPlan({
    intent: "COMPARE_PROJECTS",
    slots: {
      projectId: "p-left",
      comparisonTarget: "p-right",
    },
  });

  assert.equal(getPendingPlanSteps(plan, []).length, 2);
  assert.equal(getPendingPlanSteps(plan, [{
    stepId: plan.steps[0]!.id,
    executor: plan.steps[0]!.executor,
    result: {
      success: true,
      payload: { ok: true },
      warnings: [],
      nextSuggestions: [],
    },
  }]).length, 1);
});

test("builds multi-step assign-issue plan when ids are missing", () => {
  const plan = buildExecutionPlan({
    intent: "ASSIGN_ISSUE",
    slots: {
      issueQuery: "login safari bug",
      assigneeQuery: "Ali Khan",
    },
  });

  assert.equal(plan.requiresUserInput, false);
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[0]?.executor, "search_issues");
  assert.equal(plan.steps[1]?.executor, "list_workspace_members");
  assert.equal(plan.steps[2]?.executor, "assign_issue");
});

test("replans assign-issue mutation after exact search resolution", () => {
  const plan = buildExecutionPlan({
    intent: "ASSIGN_ISSUE",
    slots: {
      issueQuery: "login safari bug",
      assigneeQuery: "Ali Khan",
    },
  });

  const replanned = observeAndReplanExecution({
    plan,
    observations: [
      {
        stepId: "step:resolve:issue",
        executor: "search_issues",
        result: {
          success: true,
          payload: [{ id: "FIS-21", title: "Login broken on Safari" }],
          warnings: [],
          nextSuggestions: [],
        },
      },
      {
        stepId: "step:resolve:member",
        executor: "list_workspace_members",
        result: {
          success: true,
          payload: [{ id: "user-2", name: "Ali Khan" }],
          warnings: [],
          nextSuggestions: [],
        },
      },
    ],
  });

  const mutateStep = replanned.plan.steps.find((step) => step.executor === "assign_issue");
  assert.equal(mutateStep?.args.issueId, "FIS-21");
  assert.equal(mutateStep?.args.assigneeId, "user-2");
});

test("builds multi-step my-tasks prioritization plan", () => {
  const plan = buildExecutionPlan({
    intent: "MY_TASKS",
  });

  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0]?.executor, "list_issues");
  assert.equal(plan.steps[1]?.executor, "prioritize_tasks");
});

test("builds multi-step blocked-task summary plan", () => {
  const plan = buildExecutionPlan({
    intent: "BLOCKED_TASKS",
  });

  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0]?.executor, "list_issues");
  assert.equal(plan.steps[1]?.executor, "prioritize_tasks");
});

test("carries an interactive continuation when issue search stays ambiguous mid-plan", () => {
  const plan = buildExecutionPlan({
    intent: "ADD_COMMENT",
    slots: {
      issueQuery: "login bug",
      body: "Please investigate root cause.",
    },
  });

  const replanned = observeAndReplanExecution({
    plan,
    observations: [
      {
        stepId: "step:resolve:issue",
        executor: "search_issues",
        result: {
          success: true,
          payload: [
            { id: "FIS-21", title: "Login broken on Safari" },
            { id: "FIS-22", title: "Login broken on Android" },
          ],
          warnings: [],
          nextSuggestions: [],
        },
      },
    ],
  });

  assert.equal(replanned.shouldStop, true);
  assert.equal(replanned.continuation?.field, "issue");
  assert.equal(replanned.continuation?.intent, "ADD_COMMENT");
  assert.equal(replanned.continuation?.candidates.length, 2);
});

test("builds overdue-issue mutation resolution plan from filters", () => {
  const plan = buildExecutionPlan({
    intent: "ADD_COMMENT",
    slots: {
      overdueOnly: "true",
      highPriorityOnly: "true",
      body: "Please post an ETA update.",
    },
  });

  assert.equal(plan.steps[0]?.executor, "list_issues");
  assert.equal(plan.steps[1]?.executor, "add_comment");
});
