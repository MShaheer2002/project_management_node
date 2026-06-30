import { getCapabilityForIntent, type AiActionRisk, type AiIntent, type CapabilityToolMetadata } from "./ai.capabilities.js";

export type ExecutionPlanStep = {
  id: string;
  capability: string;
  executor: string;
  args: Record<string, unknown>;
  dependsOn: string[];
  toolMetadata?: CapabilityToolMetadata | undefined;
};

export type ExecutionPlan = {
  intent: AiIntent;
  steps: ExecutionPlanStep[];
  requiresUserInput: boolean;
  requiresConfirmation: boolean;
};

export type ExecutorResult = {
  success: boolean;
  payload: unknown | null;
  warnings: string[];
  nextSuggestions: string[];
  error?: string | undefined;
  meta?: Record<string, unknown> | undefined;
};

export type ExecutionPlanObservation = {
  stepId: string;
  executor: string;
  result: ExecutorResult;
};

export type ExecutionPlanContinuation = {
  action: "issue_action";
  intent: "ASSIGN_ISSUE" | "UPDATE_ISSUE_STATUS" | "ADD_COMMENT";
  field: "issue" | "member";
  prompt: string;
  candidates: Array<{ id: string; label: string }>;
  slots: Record<string, string>;
};

function isTruthyFlag(value: unknown) {
  return value === true || value === "true";
}

function buildSingleCapabilityPlan(input: {
  intent: AiIntent;
  slots?: Record<string, unknown> | undefined;
  resolvedEntities?: Record<string, unknown> | undefined;
  riskLevel?: AiActionRisk | undefined;
}) {
  const capability = getCapabilityForIntent(input.intent);
  if (!capability) {
    return {
      intent: input.intent,
      steps: [],
      requiresUserInput: true,
      requiresConfirmation: false,
    } satisfies ExecutionPlan;
  }

  const stepArgs = {
    ...(input.slots ?? {}),
    ...(input.resolvedEntities ?? {}),
  };

  return {
    intent: input.intent,
      steps: [{
        id: `step:${capability.intent.toLowerCase()}`,
        capability: capability.intent,
        executor: capability.executor,
        args: stepArgs,
        dependsOn: [],
        toolMetadata: capability.metadata,
      }],
    requiresUserInput: capability.requiredSlots.some((slot) => !(slot in stepArgs)),
    requiresConfirmation: (input.riskLevel ?? capability.riskLevel) === "high" || capability.riskLevel === "high",
  } satisfies ExecutionPlan;
}

function buildIssueMutationPlan(input: {
  intent: "ASSIGN_ISSUE" | "UPDATE_ISSUE_STATUS" | "ADD_COMMENT";
  slots?: Record<string, unknown> | undefined;
  resolvedEntities?: Record<string, unknown> | undefined;
}) {
  const stepArgs = {
    ...(input.slots ?? {}),
    ...(input.resolvedEntities ?? {}),
  };

  const steps: ExecutionPlanStep[] = [];
  const mutateArgs: Record<string, unknown> = {};

  if (typeof stepArgs.issueId === "string") {
    mutateArgs.issueId = stepArgs.issueId;
  } else if (typeof stepArgs.issueQuery === "string" && stepArgs.issueQuery.trim().length > 0) {
    steps.push({
      id: "step:resolve:issue",
      capability: "SEARCH_ISSUES",
      executor: "search_issues",
      args: { query: stepArgs.issueQuery, limit: 5 },
      dependsOn: [],
      toolMetadata: getCapabilityForIntent("SEARCH_ISSUES")?.metadata,
    });
  } else if (isTruthyFlag(stepArgs.overdueOnly) || isTruthyFlag(stepArgs.blockedOnly) || isTruthyFlag(stepArgs.highPriorityOnly) || typeof stepArgs.priority === "string") {
    steps.push({
      id: "step:resolve:issue",
      capability: "SEARCH_ISSUES",
      executor: "list_issues",
      args: {
        overdueOnly: isTruthyFlag(stepArgs.overdueOnly),
        blockedOnly: isTruthyFlag(stepArgs.blockedOnly),
        ...(isTruthyFlag(stepArgs.highPriorityOnly) ? { priority: "HIGH" } : {}),
        ...(typeof stepArgs.priority === "string" ? { priority: stepArgs.priority } : {}),
        limit: 5,
      },
      dependsOn: [],
      toolMetadata: getCapabilityForIntent("SEARCH_ISSUES")?.metadata,
    });
  }

  if (input.intent === "ASSIGN_ISSUE") {
    if (typeof stepArgs.assigneeId === "string") {
      mutateArgs.assigneeId = stepArgs.assigneeId;
    } else if (typeof stepArgs.assigneeQuery === "string" && stepArgs.assigneeQuery.trim().length > 0) {
      steps.push({
        id: "step:resolve:member",
        capability: "USER_TASKS",
        executor: "list_workspace_members",
        args: { q: stepArgs.assigneeQuery, limit: 5 },
        dependsOn: [],
        toolMetadata: {
          requires: ["workspace", "member"],
          optional: ["query"],
          supportsStreaming: false,
          supportsPagination: true,
          risk: "low",
        },
      });
    }
  }

  if (input.intent === "UPDATE_ISSUE_STATUS" && typeof stepArgs.status === "string") {
    mutateArgs.status = stepArgs.status;
  }
  if (input.intent === "ADD_COMMENT" && typeof stepArgs.body === "string") {
    mutateArgs.body = stepArgs.body;
  }

  const mutationExecutor = input.intent === "ASSIGN_ISSUE"
    ? "assign_issue"
    : input.intent === "UPDATE_ISSUE_STATUS"
      ? "update_issue_status"
      : "add_comment";

  steps.push({
    id: `step:mutate:${mutationExecutor}`,
    capability: input.intent,
    executor: mutationExecutor,
    args: mutateArgs,
    dependsOn: steps.map((step) => step.id),
    toolMetadata: getCapabilityForIntent(input.intent)?.metadata,
  });

  const requiresUserInput = (
    !("issueId" in mutateArgs) &&
    !(typeof stepArgs.issueQuery === "string" && stepArgs.issueQuery.trim().length > 0)
  ) || (
    input.intent === "ASSIGN_ISSUE" &&
    !("assigneeId" in mutateArgs) &&
    !(typeof stepArgs.assigneeQuery === "string" && stepArgs.assigneeQuery.trim().length > 0)
  ) || (
    input.intent === "UPDATE_ISSUE_STATUS" &&
    typeof mutateArgs.status !== "string"
  ) || (
    input.intent === "ADD_COMMENT" &&
    typeof mutateArgs.body !== "string"
  );

  return {
    intent: input.intent,
    steps,
    requiresUserInput,
    requiresConfirmation: false,
  } satisfies ExecutionPlan;
}

function buildTaskSummaryPlan(input: {
  intent: "MY_TASKS" | "OVERDUE_TASKS" | "BLOCKED_TASKS";
  slots?: Record<string, unknown> | undefined;
}) {
  const sharedArgs =
    input.intent === "MY_TASKS"
      ? { assigneeId: "me" }
      : input.intent === "OVERDUE_TASKS"
        ? { overdueOnly: true }
        : { blockedOnly: true };

  return {
    intent: input.intent,
    steps: [
      {
        id: `step:list:${input.intent.toLowerCase()}`,
        capability: input.intent,
        executor: "list_issues",
        args: {
          ...sharedArgs,
          ...(input.slots ?? {}),
        },
        dependsOn: [],
        toolMetadata: getCapabilityForIntent(input.intent)?.metadata,
      },
      {
        id: `step:prioritize:${input.intent.toLowerCase()}`,
        capability: "PRIORITIZE_TASKS",
        executor: "prioritize_tasks",
        args: {
          ...sharedArgs,
          ...(input.slots ?? {}),
        },
        dependsOn: [`step:list:${input.intent.toLowerCase()}`],
        toolMetadata: getCapabilityForIntent("PRIORITIZE_TASKS")?.metadata,
      },
    ],
    requiresUserInput: false,
    requiresConfirmation: false,
  } satisfies ExecutionPlan;
}

export function buildExecutionPlan(input: {
  intent: AiIntent;
  slots?: Record<string, unknown> | undefined;
  resolvedEntities?: Record<string, unknown> | undefined;
  riskLevel?: AiActionRisk | undefined;
  observations?: ExecutionPlanObservation[] | undefined;
}) {
  const stepArgs = {
    ...(input.slots ?? {}),
    ...(input.resolvedEntities ?? {}),
  };

  if (input.intent === "COMPARE_PROJECTS") {
    const leftProjectId = typeof stepArgs.projectId === "string"
      ? stepArgs.projectId
      : typeof stepArgs.leftProjectId === "string"
        ? stepArgs.leftProjectId
        : undefined;
    const rightProjectId = typeof stepArgs.comparisonTarget === "string"
      ? stepArgs.comparisonTarget
      : typeof stepArgs.rightProjectId === "string"
        ? stepArgs.rightProjectId
        : undefined;

    const steps: ExecutionPlanStep[] = [];
    if (leftProjectId) {
      steps.push({
        id: "step:compare:left_project_analytics",
        capability: "PROJECT_REPORT",
        executor: "get_project_analytics",
        args: {
          ...Object.fromEntries(
            Object.entries(stepArgs).filter(([key]) => ["period", "from", "to"].includes(key)),
          ),
          projectId: leftProjectId,
        },
        dependsOn: [],
        toolMetadata: getCapabilityForIntent("PROJECT_REPORT")?.metadata,
      });
    }
    if (rightProjectId) {
      steps.push({
        id: "step:compare:right_project_analytics",
        capability: "PROJECT_REPORT",
        executor: "get_project_analytics",
        args: {
          ...Object.fromEntries(
            Object.entries(stepArgs).filter(([key]) => ["period", "from", "to"].includes(key)),
          ),
          projectId: rightProjectId,
        },
        dependsOn: [],
        toolMetadata: getCapabilityForIntent("PROJECT_REPORT")?.metadata,
      });
    }

    return {
      intent: input.intent,
      steps,
      requiresUserInput: !(leftProjectId && rightProjectId),
      requiresConfirmation: false,
    } satisfies ExecutionPlan;
  }

  if (input.intent === "ASSIGN_ISSUE" || input.intent === "UPDATE_ISSUE_STATUS" || input.intent === "ADD_COMMENT") {
    return buildIssueMutationPlan({
      intent: input.intent,
      ...(input.slots ? { slots: input.slots } : {}),
      ...(input.resolvedEntities ? { resolvedEntities: input.resolvedEntities } : {}),
    });
  }

  if (input.intent === "MY_TASKS" || input.intent === "OVERDUE_TASKS" || input.intent === "BLOCKED_TASKS") {
    return buildTaskSummaryPlan({
      intent: input.intent,
      ...(input.slots ? { slots: input.slots } : {}),
    });
  }

  return buildSingleCapabilityPlan(input);
}

export function getPendingPlanSteps(plan: ExecutionPlan, observations: ExecutionPlanObservation[]) {
  const completed = new Set(observations.map((entry) => entry.stepId));
  return plan.steps.filter((step) => !completed.has(step.id) && step.dependsOn.every((dependency) => completed.has(dependency)));
}

export function shouldUseDeterministicPlanLoop(plan: ExecutionPlan) {
  return !plan.requiresUserInput && !plan.requiresConfirmation && plan.steps.length > 0;
}

export function observeAndReplanExecution(input: {
  plan: ExecutionPlan;
  observations: ExecutionPlanObservation[];
}) {
  const mutationStep = input.plan.steps.find((step) => step.id.startsWith("step:mutate:"));
  if (mutationStep) {
    const issueSearch = input.observations.find((entry) => entry.stepId === "step:resolve:issue");
    const memberSearch = input.observations.find((entry) => entry.stepId === "step:resolve:member");

    if (issueSearch?.result.success && typeof mutationStep.args.issueId !== "string") {
      const payload = Array.isArray(issueSearch.result.payload) ? issueSearch.result.payload : [];
      if (payload.length === 1 && payload[0] && typeof payload[0] === "object" && typeof (payload[0] as { id?: unknown }).id === "string") {
        mutationStep.args.issueId = (payload[0] as { id: string }).id;
      } else if (payload.length !== 1) {
        return {
          plan: input.plan,
          shouldStop: true,
          replanned: true,
          continuation: {
            action: "issue_action",
            intent: mutationStep.capability as "ASSIGN_ISSUE" | "UPDATE_ISSUE_STATUS" | "ADD_COMMENT",
            field: "issue",
            prompt: "Which issue do you mean?",
            candidates: payload
              .slice(0, 5)
              .filter((entry): entry is { id: string; title?: string } => Boolean(entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"))
              .map((entry) => ({
                id: entry.id,
                label: typeof entry.title === "string" ? entry.title : entry.id,
              })),
            slots: Object.fromEntries(
              Object.entries(mutationStep.args)
                .filter(([, value]) => typeof value === "string")
                .map(([key, value]) => [key, value as string]),
            ),
          } satisfies ExecutionPlanContinuation,
        };
      }
    }

    if (memberSearch?.result.success && typeof mutationStep.args.assigneeId !== "string") {
      const payload = Array.isArray(memberSearch.result.payload) ? memberSearch.result.payload : [];
      if (payload.length === 1 && payload[0] && typeof payload[0] === "object" && typeof (payload[0] as { id?: unknown }).id === "string") {
        mutationStep.args.assigneeId = (payload[0] as { id: string }).id;
      } else if (payload.length !== 1) {
        return {
          plan: input.plan,
          shouldStop: true,
          replanned: true,
          continuation: {
            action: "issue_action",
            intent: mutationStep.capability as "ASSIGN_ISSUE" | "UPDATE_ISSUE_STATUS" | "ADD_COMMENT",
            field: "member",
            prompt: "Who should I assign it to?",
            candidates: payload
              .slice(0, 5)
              .filter((entry): entry is { id: string; name?: string } => Boolean(entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"))
              .map((entry) => ({
                id: entry.id,
                label: typeof entry.name === "string" ? entry.name : entry.id,
              })),
            slots: Object.fromEntries(
              Object.entries(mutationStep.args)
                .filter(([, value]) => typeof value === "string")
                .map(([key, value]) => [key, value as string]),
            ),
          } satisfies ExecutionPlanContinuation,
        };
      }
    }
  }

  const failedStep = input.observations.find((entry) => !entry.result.success);
  if (failedStep) {
    return {
      plan: {
        ...input.plan,
        steps: input.plan.steps.filter((step) => step.id === failedStep.stepId),
      },
      shouldStop: true,
      replanned: false,
    };
  }

  const pending = getPendingPlanSteps(input.plan, input.observations);
  if (pending.length === 0) {
    return {
      plan: input.plan,
      shouldStop: true,
      replanned: false,
    };
  }

  return {
    plan: input.plan,
    shouldStop: false,
    replanned: input.observations.length > 0,
  };
}
