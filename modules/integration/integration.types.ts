/**
 * Integration Module — Shared Event Types
 *
 * All integration notification events pass through the dispatcher.
 * Each event has a type discriminator and a typed payload.
 */

export type IntegrationEvent =
  | { type: "issue.created"; payload: IssueEventPayload }
  | { type: "issue.completed"; payload: IssueCompletedPayload }
  | { type: "issue.assigned"; payload: IssueAssignedPayload }
  | { type: "cycle.started"; payload: CycleEventPayload }
  | { type: "cycle.completed"; payload: CycleEventPayload };

export interface IssueEventPayload {
  id: string;
  title: string;
  priority: string;
  status?: string | undefined;
  projectId?: string | null | undefined;
  teamId?: string | null | undefined;
  assigneeName?: string | null | undefined;
  assigneeEmail?: string | null | undefined;
  creatorName: string;
  projectName?: string | null | undefined;
}

export interface IssueCompletedPayload {
  id: string;
  title: string;
  completedByName: string;
  projectId?: string | null | undefined;
  teamId?: string | null | undefined;
  projectName?: string | null | undefined;
}

export interface IssueAssignedPayload {
  id: string;
  title: string;
  assigneeName: string;
  assigneeEmail?: string | null | undefined;
  assignedByName: string;
  priority: string;
  projectId?: string | null | undefined;
  teamId?: string | null | undefined;
  projectName?: string | null | undefined;
}

export interface CycleEventPayload {
  cycleName: string;
  teamId?: string | null | undefined;
  teamName?: string | undefined;
  dateRange?: string | undefined;
  totalIssues?: number | undefined;
  completedIssues?: number | undefined;
  carriedOver?: number | undefined;
}
