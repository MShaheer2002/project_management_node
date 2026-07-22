/**
 * Effective Workflow Resolution
 *
 * A project may define its own workflow (statuses + automation) that overrides
 * the workspace default. This module resolves which one actually applies —
 * the "effective" workflow — for a given project.
 *
 * Pure functions only — no Prisma access. Callers fetch the raw JSON columns
 * (workspace.customStatuses/workflowAutomation, project.customStatuses/workflowAutomation)
 * and pass them in here.
 */
import {
  normalizeWorkflowAutomation,
  normalizeWorkspaceStatuses,
  type WorkflowAutomationConfig,
  type WorkspaceStatusRecord,
} from "./workflow-automation.js";

export type EffectiveWorkflowSource = "workspace" | "project";

export type EffectiveWorkflow = {
  source: EffectiveWorkflowSource;
  statuses: WorkspaceStatusRecord[];
  automation: WorkflowAutomationConfig;
};

type WorkspaceWorkflowInput = {
  customStatuses: unknown;
  workflowAutomation: unknown;
};

type ProjectWorkflowInput = {
  customStatuses: unknown;
  workflowAutomation: unknown;
};

/**
 * A project override is only active when it defines at least one status.
 * An empty/null value means "inherit the workspace default" — this is how
 * clearing an override is represented, rather than a separate boolean flag.
 */
export function projectHasWorkflowOverride(projectCustomStatuses: unknown): boolean {
  return Array.isArray(projectCustomStatuses) && projectCustomStatuses.length > 0;
}

export function resolveEffectiveWorkflow(
  workspace: WorkspaceWorkflowInput,
  project: ProjectWorkflowInput | null | undefined,
): EffectiveWorkflow {
  const usesProjectOverride = projectHasWorkflowOverride(project?.customStatuses);

  const statuses = normalizeWorkspaceStatuses(
    (usesProjectOverride ? project!.customStatuses : workspace.customStatuses) as any[] | null | undefined,
  );
  const automation = normalizeWorkflowAutomation(
    usesProjectOverride ? project!.workflowAutomation : workspace.workflowAutomation,
    statuses,
  );

  return {
    source: usesProjectOverride ? "project" : "workspace",
    statuses,
    automation,
  };
}

type ProjectWorkflowRow = ProjectWorkflowInput & { id: string };

/**
 * Batched variant for resolving multiple projects against one workspace at once —
 * used where a single team-scoped resource (e.g. a cycle) can span issues from
 * several projects that each may have a different effective workflow.
 */
export function resolveEffectiveWorkflowMap(
  workspace: WorkspaceWorkflowInput,
  projects: ProjectWorkflowRow[],
): Map<string, EffectiveWorkflow> {
  const map = new Map<string, EffectiveWorkflow>();
  for (const project of projects) {
    map.set(project.id, resolveEffectiveWorkflow(workspace, project));
  }
  return map;
}
