/**
 * Bulk status changes (merge, remove-and-move) shared by the workspace and
 * project workflow services.
 *
 * Status keys are plain strings shared between the workspace workflow and every
 * project override, so a bulk write keyed only on `workspaceId + status` also
 * hits projects whose own workflow happens to reuse the key (F-34). Callers pass
 * an explicit issue scope instead.
 */
import type { Prisma } from "../../app/generated/prisma/client.js";
import { projectHasWorkflowOverride } from "./effective-workflow.js";
import type { WorkspaceStatusRecord } from "./workflow-automation.js";

type Db = Prisma.TransactionClient;

/**
 * Issues governed by the workspace workflow: those in projects that inherit it
 * (every issue belongs to a project). Uses projectHasWorkflowOverride so this
 * cannot drift from how the effective workflow is resolved at read time (a
 * cleared override is JSON null, a never-set one is SQL NULL, and [] also
 * means "inherit" — one JSON filter would miss one of the three).
 */
export async function workspaceWorkflowIssueScope(db: Db, workspaceId: string): Promise<Prisma.IssueWhereInput> {
  const projects = await db.project.findMany({
    where: { workspaceId },
    select: { id: true, customStatuses: true },
  });
  const overridden = projects.filter((project) => projectHasWorkflowOverride(project.customStatuses)).map((project) => project.id);

  if (overridden.length === 0) return { workspaceId };
  return { workspaceId, projectId: { notIn: overridden } };
}

/**
 * Move every in-scope issue on `fromKey` to `target`, with the same approval
 * semantics as a single status change: approvals for the status being entered
 * are cleared so a gated status needs fresh sign-off (issue.service updateIssue),
 * and approvals for the status being left no longer mean anything.
 */
export async function moveIssuesToStatus(db: Db, scope: Prisma.IssueWhereInput, fromKey: string, target: WorkspaceStatusRecord) {
  const moving: Prisma.IssueWhereInput = { AND: [scope, { status: fromKey }] };

  await db.issueApproval.deleteMany({
    where: { statusKey: { in: [fromKey, target.key] }, issue: moving },
  });
  // Keep the original completion date when an already-completed issue moves
  // between final statuses; only newly completed issues get stamped.
  if (target.isFinal) {
    await db.issue.updateMany({ where: { AND: [moving, { completedAt: null }] }, data: { completedAt: new Date() } });
  }
  await db.issue.updateMany({
    where: moving,
    data: target.isFinal ? { status: target.key } : { status: target.key, completedAt: null },
  });
}
