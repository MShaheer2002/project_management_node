/**
 * Before-state capture for reviewable AI changes (Phase 20K)
 *
 * Accept/reject in the chat panel needs to know what an entity looked like
 * before the AI touched it. Capturing happens here rather than inside the
 * executor so the executor stays a pure "apply the change" layer.
 *
 * Two rules that matter:
 *   1. Capture only the fields the mutation actually intends to change. Storing
 *      a whole snapshot and writing it all back on revert would silently undo
 *      edits other people made in between.
 *   2. Capture *before* the mutation runs and never let a capture failure block
 *      it. A change that applied but wasn't recorded is recoverable (activity
 *      log); a change refused because bookkeeping failed is just a broken tool.
 */

import { prisma } from "../../../../shared/utils/prisma.js";
import { logAiWarn } from "../../ai.observability.js";

/** Fields we can capture and restore per entity type. Anything else is not revertable. */
const REVERTABLE_FIELDS = {
  ISSUE: ["title", "description", "status", "priority", "type", "assigneeId", "dueDate"],
  PROJECT: ["name", "description", "status", "leadId", "visibility"],
  TEAM: ["name", "description", "leadId", "visibility", "departmentId"],
} as const;

export type CapturableEntity = keyof typeof REVERTABLE_FIELDS;

export interface CapturedState {
  /** Prior values for the requested fields, suitable for a targeted revert. */
  beforeState: Record<string, unknown>;
  /** Human-readable label for the change card, e.g. "TRU-1 — Login crash". */
  label: string;
}

/**
 * Reads the current values of `fields` on an entity. Returns null when the
 * entity is missing or the read fails — the caller should still proceed with
 * the mutation and simply record it as non-revertable.
 */
export async function captureBeforeState(
  entity: CapturableEntity,
  entityId: string,
  workspaceId: string,
  fields: string[],
): Promise<CapturedState | null> {
  const allowed = REVERTABLE_FIELDS[entity] as readonly string[];
  const requested = fields.filter((field) => allowed.includes(field));
  if (requested.length === 0) return null;

  try {
    switch (entity) {
      case "ISSUE": {
        const issue = await prisma.issue.findFirst({
          where: { id: entityId, workspaceId },
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            priority: true,
            type: true,
            assigneeId: true,
            dueDate: true,
          },
        });
        if (!issue) return null;
        return {
          beforeState: pick(normalizeIssue(issue), requested),
          label: `${issue.id} — ${issue.title}`,
        };
      }

      case "PROJECT": {
        const project = await prisma.project.findFirst({
          where: { id: entityId, workspaceId },
          select: { id: true, name: true, description: true, status: true, leadId: true, visibility: true },
        });
        if (!project) return null;
        return { beforeState: pick(project, requested), label: project.name };
      }

      case "TEAM": {
        const team = await prisma.team.findFirst({
          where: { id: entityId, workspaceId },
          select: { id: true, name: true, description: true, leadId: true, visibility: true, departmentId: true },
        });
        if (!team) return null;
        return { beforeState: pick(team, requested), label: team.name };
      }

      default:
        return null;
    }
  } catch (error) {
    logAiWarn("mutation_capture_failed", {
      workspaceId,
      feature: "chat",
      success: false,
      errorMessage: error instanceof Error ? error.message : "Capture failed",
      metadata: { entity, entityId },
    });
    return null;
  }
}

/**
 * Renders a short, human-readable description of what changed, for the review
 * card. Deliberately values-not-field-names ("Status: todo → done") because the
 * card is read by the user, not by a developer.
 */
export function describeChange(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const [field, previous] of Object.entries(before)) {
    if (!(field in after)) continue;
    const next = after[field];
    if (String(previous ?? "—") === String(next ?? "—")) continue;
    parts.push(`${humanizeField(field)}: ${formatValue(previous)} → ${formatValue(next)}`);
  }

  return parts.length > 0 ? parts.join(" · ") : "Updated";
}

// ─── Internals ──────────────────────────────────────────────────────────────

function normalizeIssue(issue: {
  title: string;
  description: string | null;
  status: string;
  priority: string;
  type: string;
  assigneeId: string | null;
  dueDate: Date | null;
}): Record<string, unknown> {
  return {
    title: issue.title,
    description: issue.description,
    status: issue.status,
    // Lowercased to match the shape the update services accept, so a captured
    // value can be handed straight back on revert without translation.
    priority: issue.priority.toLowerCase(),
    type: issue.type.toLowerCase(),
    assigneeId: issue.assigneeId,
    dueDate: issue.dueDate ? issue.dueDate.toISOString().slice(0, 10) : null,
  };
}

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) result[key] = source[key];
  }
  return result;
}

const FIELD_LABELS: Record<string, string> = {
  assigneeId: "Assignee",
  dueDate: "Due date",
  departmentId: "Department",
  leadId: "Lead",
};

function humanizeField(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  return field.charAt(0).toUpperCase() + field.slice(1);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "string" && value.length > 40) return `${value.slice(0, 37)}…`;
  return String(value);
}
