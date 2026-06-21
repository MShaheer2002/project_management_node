/**
 * Trussen AI Tool Executor — Complete Implementation
 *
 * SECURITY LAYERS:
 *   1. Workspace isolation — every query includes workspaceId
 *   2. Role-based access — GUEST=read, MEMBER=create+update own, ADMIN/OWNER=all
 *   3. Visibility check — private projects/teams filtered by membership
 *   4. Ownership check — members can only update issues assigned to them
 *   5. NO DELETE — deleting anything is forbidden from AI
 *   6. Invite — ADMIN/OWNER only
 *   7. Project/team creation — ADMIN/OWNER only
 */

import { prisma } from "../../../shared/utils/prisma.js";
import { AppError } from "../../../shared/utils/api-error.js";
import { randomBytes, createHash } from "node:crypto";

interface ToolContext {
  workspaceId: string;
  userId: string;
  userRole: string;
}

interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const resolveUserId = (id: unknown, ctx: ToolContext): string | undefined => {
  if (id === "me") return ctx.userId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

const isAdmin = (ctx: ToolContext): boolean => ctx.userRole === "OWNER" || ctx.userRole === "ADMIN";

const canWrite = (ctx: ToolContext): boolean => ctx.userRole !== "GUEST";

const str = (v: unknown, fallback = ""): string => {
  const s = typeof v === "string" ? v : fallback;
  // Sanitize: strip control chars, limit length
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, 10000);
};

const num = (v: unknown, fallback: number): number => {
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) ? fallback : n;
};

const toSlug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

/** Resolve due date from various formats: YYYY-MM-DD, "tomorrow", "3 days", "next week" */
const resolveDueDate = (input: string): Date | null => {
  // ISO date format
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const d = new Date(input + "T00:00:00");
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const lower = input.toLowerCase().trim();
  const now = new Date();

  if (lower === "today") return now;
  if (lower === "tomorrow") { now.setDate(now.getDate() + 1); return now; }
  if (lower === "next week") { now.setDate(now.getDate() + 7); return now; }

  const daysMatch = lower.match(/^(\d+)\s*days?$/);
  if (daysMatch) { now.setDate(now.getDate() + parseInt(daysMatch[1]!, 10)); return now; }

  const weeksMatch = lower.match(/^(\d+)\s*weeks?$/);
  if (weeksMatch) { now.setDate(now.getDate() + parseInt(weeksMatch[1]!, 10) * 7); return now; }

  // Try parsing as a date string
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

// ─── Main Executor ──────────────────────────────────────────────────────────

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    switch (toolName) {

      // ═══════════════════════════════════════════════════════════
      // ISSUES
      // ═══════════════════════════════════════════════════════════

      case "list_issues": {
        const limit = Math.min(num(args.limit, 10), 25);
        const where: Record<string, unknown> = { workspaceId: ctx.workspaceId };
        // Status can be either Prisma enum (UPPERCASE) or custom status key (kebab-case)
        // Try lowercase kebab first (custom statuses), fall back to uppercase enum
        if (args.status) {
          const statusInput = str(args.status).toLowerCase().replace(/_/g, "-");
          where.status = statusInput;
        }
        if (args.priority) where.priority = str(args.priority).toUpperCase();
        if (args.type) where.type = str(args.type).toUpperCase();
        if (args.assigneeId) where.assigneeId = resolveUserId(args.assigneeId, ctx);
        if (args.projectId) where.projectId = str(args.projectId);
        if (args.teamId) where.teamId = str(args.teamId);
        if (args.q) where.OR = [
          { title: { contains: str(args.q), mode: "insensitive" } },
          { id: { contains: str(args.q), mode: "insensitive" } },
        ];

        const issues = await prisma.issue.findMany({
          where,
          select: { id: true, title: true, status: true, priority: true, type: true, assignee: { select: { name: true } }, project: { select: { name: true } } },
          orderBy: args.sort === "priority:desc" ? { priority: "desc" } : { updatedAt: "desc" },
          take: limit,
        });

        return { success: true, data: issues.map((i) => ({ id: i.id, title: i.title, status: i.status, priority: i.priority, type: i.type, assignee: i.assignee?.name ?? "Unassigned", project: i.project?.name ?? "—" })) };
      }

      case "get_issue": {
        const issue = await prisma.issue.findFirst({
          where: { workspaceId: ctx.workspaceId, id: str(args.issueId) },
          select: { id: true, title: true, description: true, status: true, priority: true, type: true, assignee: { select: { id: true, name: true } }, creator: { select: { name: true } }, project: { select: { id: true, name: true } }, team: { select: { name: true } }, labels: { select: { label: { select: { name: true } } } }, createdAt: true, updatedAt: true, completedAt: true },
        });
        if (!issue) return { success: false, data: null, error: `Issue ${args.issueId} not found` };
        return { success: true, data: { ...issue, labels: issue.labels.map((l) => l.label.name) } };
      }

      case "create_issue": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "You don't have permission to create issues" };

        const project = await prisma.project.findFirst({
          where: { id: str(args.projectId), workspaceId: ctx.workspaceId },
          select: { id: true, teamId: true, visibility: true, memberships: { select: { userId: true } } },
        });
        if (!project) return { success: false, data: null, error: "Project not found" };

        // Private project check — only members can create issues
        if (project.visibility === "PRIVATE" && !isAdmin(ctx)) {
          const isMember = project.memberships.some((m) => m.userId === ctx.userId);
          if (!isMember) return { success: false, data: null, error: "You don't have access to this project" };
        }

        const workspace = await prisma.workspace.update({
          where: { id: ctx.workspaceId },
          data: { issueCounter: { increment: 1 } },
          select: { issuePrefix: true, issueCounter: true, customStatuses: true },
        });

        const issueId = `${workspace.issuePrefix}-${workspace.issueCounter}`;
        const assigneeId = resolveUserId(args.assigneeId, ctx);

        // Resolve status — use workspace custom status keys (kebab-case), not Prisma enums
        let issueStatus = "TODO";
        if (args.status) {
          issueStatus = str(args.status).toLowerCase().replace(/_/g, "-");
        } else {
          // Default to workspace's second status (usually "todo") — first is typically "backlog"
          const statuses = workspace.customStatuses as Array<{ key: string }> | null;
          if (statuses && statuses.length > 1 && statuses[1]) {
            issueStatus = statuses[1].key; // "todo"
          }
        }

        // Auto-generate description if not provided
        const description = args.description
          ? str(args.description)
          : `Created via Trussen AI: "${str(args.title)}"`;

        const dueDate = args.dueDate ? resolveDueDate(str(args.dueDate)) : null;

        const issue = await prisma.issue.create({
          data: { id: issueId, number: workspace.issueCounter, workspaceId: ctx.workspaceId, projectId: project.id, teamId: project.teamId, title: str(args.title, "Untitled"), type: str(args.type, "TASK").toUpperCase() as "TASK" | "BUG" | "ISSUE", priority: str(args.priority, "MEDIUM").toUpperCase() as "LOW" | "MEDIUM" | "HIGH" | "URGENT", status: issueStatus, description, creatorId: ctx.userId, assigneeId: assigneeId ?? null, dueDate },
          select: { id: true, title: true, status: true, priority: true, type: true },
        });

        return { success: true, data: { ...issue, message: `Issue ${issue.id} created` } };
      }

      case "update_issue": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "You don't have permission to update issues" };

        const existing = await prisma.issue.findFirst({
          where: { id: str(args.issueId), workspaceId: ctx.workspaceId },
          select: { id: true, assigneeId: true, creatorId: true, status: true },
        });
        if (!existing) return { success: false, data: null, error: `Issue ${args.issueId} not found` };

        // Ownership check — MEMBER can only update own issues
        if (!isAdmin(ctx) && existing.assigneeId !== ctx.userId && existing.creatorId !== ctx.userId) {
          return { success: false, data: null, error: "You can only update issues assigned to you or created by you" };
        }

        const data: Record<string, unknown> = {};
        if (args.title) data.title = str(args.title);
        if (args.description) data.description = str(args.description);
        if (args.priority) data.priority = str(args.priority).toUpperCase();
        if (args.type) data.type = str(args.type).toUpperCase();
        if (args.status) {
          // Use kebab-case status keys (matching workspace custom statuses)
          const status = str(args.status).toLowerCase().replace(/_/g, "-");
          data.status = status;
          if (status === "done") data.completedAt = new Date();
          else if (existing.status === "done" || existing.status === "DONE") data.completedAt = null;
        }
        if (args.dueDate) {
          const dueDateStr = str(args.dueDate);
          const resolved = resolveDueDate(dueDateStr);
          if (resolved) data.dueDate = resolved;
        }

        const updated = await prisma.issue.update({ where: { id: existing.id }, data, select: { id: true, title: true, status: true, priority: true } });
        return { success: true, data: { ...updated, message: `${existing.id} updated` } };
      }

      case "assign_issue": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "No permission" };

        const existing = await prisma.issue.findFirst({
          where: { id: str(args.issueId), workspaceId: ctx.workspaceId },
          select: { id: true, assigneeId: true, creatorId: true },
        });
        if (!existing) return { success: false, data: null, error: `Issue ${args.issueId} not found` };

        // MEMBER can only assign their own issues or unassigned issues
        if (!isAdmin(ctx) && existing.assigneeId && existing.assigneeId !== ctx.userId && existing.creatorId !== ctx.userId) {
          return { success: false, data: null, error: "You can only reassign issues assigned to you or created by you" };
        }

        const assigneeId = resolveUserId(args.assigneeId, ctx);
        if (assigneeId) {
          const member = await prisma.workspaceMembership.findFirst({ where: { userId: assigneeId, workspaceId: ctx.workspaceId }, select: { user: { select: { name: true } } } });
          if (!member) return { success: false, data: null, error: "That person is not a workspace member" };
        }

        await prisma.issue.update({ where: { id: existing.id }, data: { assigneeId: assigneeId ?? null } });
        return { success: true, data: { issueId: existing.id, message: `${existing.id} ${assigneeId ? "assigned" : "unassigned"}` } };
      }

      case "add_comment": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "No permission" };

        const existing = await prisma.issue.findFirst({ where: { id: str(args.issueId), workspaceId: ctx.workspaceId }, select: { id: true } });
        if (!existing) return { success: false, data: null, error: `Issue ${args.issueId} not found` };

        const commentBody = str(args.body).slice(0, 50000); // Max comment length
        if (!commentBody) return { success: false, data: null, error: "Comment body is empty" };

        await prisma.comment.create({ data: { issueId: existing.id, authorId: ctx.userId, body: commentBody } });
        return { success: true, data: { issueId: existing.id, message: `Comment added to ${existing.id}` } };
      }

      case "add_label_to_issue": {
        if (!canWrite(ctx)) return { success: false, data: null, error: "No permission" };

        const existing = await prisma.issue.findFirst({ where: { id: str(args.issueId), workspaceId: ctx.workspaceId }, select: { id: true } });
        if (!existing) return { success: false, data: null, error: `Issue ${args.issueId} not found` };

        const label = await prisma.label.findFirst({ where: { workspaceId: ctx.workspaceId, name: { equals: str(args.labelName), mode: "insensitive" } }, select: { id: true, name: true } });
        if (!label) return { success: false, data: null, error: `Label "${args.labelName}" not found` };

        await prisma.issueLabel.upsert({ where: { issueId_labelId: { issueId: existing.id, labelId: label.id } }, create: { issueId: existing.id, labelId: label.id }, update: {} });
        return { success: true, data: { issueId: existing.id, label: label.name, message: `Label "${label.name}" added to ${existing.id}` } };
      }

      // ═══════════════════════════════════════════════════════════
      // PROJECTS
      // ═══════════════════════════════════════════════════════════

      case "list_projects": {
        const limit = Math.min(num(args.limit, 10), 25);

        // Get user's project memberships for visibility filtering
        const userProjectIds = await prisma.projectMembership.findMany({ where: { userId: ctx.userId }, select: { projectId: true } });
        const memberProjectIds = new Set(userProjectIds.map((p) => p.projectId));

        const where: Record<string, unknown> = { workspaceId: ctx.workspaceId };
        if (args.status) where.status = str(args.status);
        if (args.teamId) where.teamId = str(args.teamId);
        if (args.q) where.name = { contains: str(args.q), mode: "insensitive" };

        const projects = await prisma.project.findMany({
          where, select: { id: true, name: true, status: true, visibility: true, _count: { select: { issues: true } } },
          orderBy: { name: "asc" }, take: limit,
        });

        // Filter private projects — only show if user is a member or admin
        const visible = projects.filter((p) => p.visibility === "PUBLIC" || isAdmin(ctx) || memberProjectIds.has(p.id));
        return { success: true, data: visible.map((p) => ({ id: p.id, name: p.name, status: p.status, issueCount: p._count.issues })) };
      }

      case "get_project_summary": {
        const project = await prisma.project.findFirst({
          where: { id: str(args.projectId), workspaceId: ctx.workspaceId },
          select: { id: true, name: true, status: true, description: true, visibility: true, lead: { select: { name: true } }, team: { select: { name: true } }, memberships: { select: { userId: true } } },
        });
        if (!project) return { success: false, data: null, error: "Project not found" };

        // Visibility check
        if (project.visibility === "PRIVATE" && !isAdmin(ctx) && !project.memberships.some((m) => m.userId === ctx.userId)) {
          return { success: false, data: null, error: "You don't have access to this project" };
        }

        const statusCounts = await prisma.issue.groupBy({ by: ["status"], where: { projectId: project.id, workspaceId: ctx.workspaceId }, _count: true });
        const stats = Object.fromEntries(statusCounts.map((s) => [s.status, s._count]));

        return { success: true, data: { id: project.id, name: project.name, status: project.status, description: project.description, lead: project.lead?.name ?? "None", team: project.team.name, issuesByStatus: stats } };
      }

      case "create_project": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can create projects" };

        const team = await prisma.team.findFirst({ where: { id: str(args.teamId), workspaceId: ctx.workspaceId }, select: { id: true, departmentId: true } });
        if (!team) return { success: false, data: null, error: "Team not found" };

        const name = str(args.name, "New Project");
        const slug = toSlug(name) || `project-${Date.now()}`;

        const project = await prisma.project.create({
          data: { workspaceId: ctx.workspaceId, teamId: team.id, departmentId: team.departmentId, name, slug, description: args.description ? str(args.description) : null, leadId: ctx.userId },
          select: { id: true, name: true, slug: true },
        });

        return { success: true, data: { ...project, message: `Project "${project.name}" created` } };
      }

      case "update_project": {
        const project = await prisma.project.findFirst({
          where: { id: str(args.projectId), workspaceId: ctx.workspaceId },
          select: { id: true, leadId: true },
        });
        if (!project) return { success: false, data: null, error: "Project not found" };

        if (!isAdmin(ctx) && project.leadId !== ctx.userId) {
          return { success: false, data: null, error: "Only admins, owners, or the project lead can update this project" };
        }

        const data: Record<string, unknown> = {};
        if (args.name) data.name = str(args.name);
        if (args.description !== undefined) data.description = str(args.description) || null;
        if (args.status) data.status = str(args.status);

        const updated = await prisma.project.update({ where: { id: project.id }, data, select: { id: true, name: true, status: true } });
        return { success: true, data: { ...updated, message: `Project "${updated.name}" updated` } };
      }

      // ═══════════════════════════════════════════════════════════
      // TEAMS & MEMBERS
      // ═══════════════════════════════════════════════════════════

      case "list_teams": {
        const where: Record<string, unknown> = { workspaceId: ctx.workspaceId };
        if (args.q) where.name = { contains: str(args.q), mode: "insensitive" };

        const teams = await prisma.team.findMany({
          where, select: { id: true, name: true, visibility: true, lead: { select: { name: true } }, _count: { select: { memberships: true, projects: true } } },
          orderBy: { name: "asc" }, take: 20,
        });

        // Filter private teams
        const userTeamIds = await prisma.teamMembership.findMany({ where: { userId: ctx.userId }, select: { teamId: true } });
        const memberTeamIds = new Set(userTeamIds.map((t) => t.teamId));
        const visible = teams.filter((t) => t.visibility === "PUBLIC" || isAdmin(ctx) || memberTeamIds.has(t.id));

        return { success: true, data: visible.map((t) => ({ id: t.id, name: t.name, lead: t.lead.name, members: t._count.memberships, projects: t._count.projects })) };
      }

      case "list_team_members": {
        const team = await prisma.team.findFirst({
          where: { id: str(args.teamId), workspaceId: ctx.workspaceId },
          select: { id: true, visibility: true, memberships: { select: { userId: true } } },
        });
        if (!team) return { success: false, data: null, error: "Team not found" };

        if (team.visibility === "PRIVATE" && !isAdmin(ctx) && !team.memberships.some((m) => m.userId === ctx.userId)) {
          return { success: false, data: null, error: "You don't have access to this team" };
        }

        const members = await prisma.teamMembership.findMany({
          where: { teamId: team.id },
          select: { role: true, user: { select: { id: true, name: true, email: true } } },
        });

        return { success: true, data: members.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role })) };
      }

      case "list_members": {
        const where: Record<string, unknown> = { workspaceId: ctx.workspaceId };

        const memberships = await prisma.workspaceMembership.findMany({
          where, select: { role: true, user: { select: { id: true, name: true, email: true } } },
          orderBy: { user: { name: "asc" } }, take: 50,
        });

        // Filter by search
        let result = memberships.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role }));
        if (args.q) {
          const q = str(args.q).toLowerCase();
          result = result.filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
        }

        return { success: true, data: result };
      }

      case "get_team_workload": {
        const where: Record<string, unknown> = { workspaceId: ctx.workspaceId, status: { not: "done" } };
        if (args.teamId) {
          // Verify user can see this team (private team check)
          const team = await prisma.team.findFirst({
            where: { id: str(args.teamId), workspaceId: ctx.workspaceId },
            select: { id: true, visibility: true, memberships: { select: { userId: true } } },
          });
          if (!team) return { success: false, data: null, error: "Team not found" };
          if (team.visibility === "PRIVATE" && !isAdmin(ctx) && !team.memberships.some((m) => m.userId === ctx.userId)) {
            return { success: false, data: null, error: "You don't have access to this team" };
          }
          where.teamId = str(args.teamId);
        }

        const issues = await prisma.issue.groupBy({ by: ["assigneeId"], where, _count: true });
        const userIds = issues.map((i) => i.assigneeId).filter(Boolean) as string[];
        const users = userIds.length > 0 ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
        const userMap = new Map(users.map((u) => [u.id, u.name]));

        return { success: true, data: issues.filter((i) => i.assigneeId).map((i) => ({ name: userMap.get(i.assigneeId!) ?? "Unknown", openIssues: i._count })).sort((a, b) => b.openIssues - a.openIssues) };
      }

      case "invite_member": {
        if (!isAdmin(ctx)) return { success: false, data: null, error: "Only admins and owners can send invitations" };

        const email = str(args.email).toLowerCase().trim();
        if (!email || !email.includes("@")) return { success: false, data: null, error: "Invalid email address" };

        const team = await prisma.team.findFirst({ where: { id: str(args.teamId), workspaceId: ctx.workspaceId }, select: { id: true } });
        if (!team) return { success: false, data: null, error: "Team not found" };

        // Check if already a member
        const existingMember = await prisma.user.findFirst({ where: { email }, select: { id: true } });
        if (existingMember) {
          const membership = await prisma.workspaceMembership.findFirst({ where: { userId: existingMember.id, workspaceId: ctx.workspaceId }, select: { id: true } });
          if (membership) return { success: false, data: null, error: `${email} is already a workspace member` };
        }

        // Check for pending invitation
        const existingInvite = await prisma.workspaceInvitation.findFirst({ where: { workspaceId: ctx.workspaceId, email, status: "PENDING" }, select: { id: true } });
        if (existingInvite) return { success: false, data: null, error: `A pending invitation already exists for ${email}` };

        const token = randomBytes(32).toString("hex");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const role = str(args.role, "MEMBER") as "ADMIN" | "MEMBER" | "GUEST";

        await prisma.workspaceInvitation.create({
          data: { workspaceId: ctx.workspaceId, email, role, teamId: team.id, tokenHash, invitedById: ctx.userId, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
        });

        return { success: true, data: { email, role, message: `Invitation sent to ${email} as ${role}` } };
      }

      // ═══════════════════════════════════════════════════════════
      // CYCLES / SPRINTS
      // ═══════════════════════════════════════════════════════════

      case "list_cycles": {
        const where: Record<string, unknown> = { workspaceId: ctx.workspaceId };
        if (args.teamId) where.teamId = str(args.teamId);
        if (args.status) where.status = str(args.status);

        const cycles = await prisma.cycle.findMany({
          where, select: { id: true, name: true, status: true, startsAt: true, endsAt: true, _count: { select: { issues: true } } },
          orderBy: { startsAt: "desc" }, take: 10,
        });

        return { success: true, data: cycles.map((c) => ({ id: c.id, name: c.name, status: c.status, startsAt: c.startsAt.toISOString().slice(0, 10), endsAt: c.endsAt.toISOString().slice(0, 10), issueCount: c._count.issues })) };
      }

      case "get_cycle_progress": {
        const cycle = await prisma.cycle.findFirst({
          where: { id: str(args.cycleId), workspaceId: ctx.workspaceId },
          select: { id: true, name: true, status: true, startsAt: true, endsAt: true, goal: true },
        });
        if (!cycle) return { success: false, data: null, error: "Cycle not found" };

        const statusCounts = await prisma.issue.groupBy({ by: ["status"], where: { cycleId: cycle.id }, _count: true });
        const stats = Object.fromEntries(statusCounts.map((s) => [s.status, s._count]));
        const total = statusCounts.reduce((sum, s) => sum + s._count, 0);
        const done = stats["DONE"] ?? 0;

        return { success: true, data: { ...cycle, startsAt: cycle.startsAt.toISOString().slice(0, 10), endsAt: cycle.endsAt.toISOString().slice(0, 10), issuesByStatus: stats, total, done, progress: total > 0 ? Math.round((done / total) * 100) : 0 } };
      }

      // ═══════════════════════════════════════════════════════════
      // LABELS
      // ═══════════════════════════════════════════════════════════

      case "list_labels": {
        const labels = await prisma.label.findMany({
          where: { workspaceId: ctx.workspaceId },
          select: { id: true, name: true, color: true },
          orderBy: { name: "asc" }, take: 50,
        });
        return { success: true, data: labels };
      }

      // ═══════════════════════════════════════════════════════════
      // ANALYTICS
      // ═══════════════════════════════════════════════════════════

      case "get_analytics": {
        const days = num(args.days, 30);
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const where: Record<string, unknown> = { workspaceId: ctx.workspaceId };
        if (args.teamId) where.teamId = str(args.teamId);
        if (args.projectId) where.projectId = str(args.projectId);

        const [byStatus, byPriority, byType, created, completed] = await Promise.all([
          prisma.issue.groupBy({ by: ["status"], where, _count: true }),
          prisma.issue.groupBy({ by: ["priority"], where, _count: true }),
          prisma.issue.groupBy({ by: ["type"], where, _count: true }),
          prisma.issue.count({ where: { ...where, createdAt: { gte: since } } }),
          prisma.issue.count({ where: { ...where, completedAt: { gte: since } } }),
        ]);

        const total = byStatus.reduce((sum, s) => sum + s._count, 0);

        return {
          success: true,
          data: {
            period: `Last ${days} days`,
            total,
            byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
            byPriority: Object.fromEntries(byPriority.map((s) => [s.priority, s._count])),
            byType: Object.fromEntries(byType.map((s) => [s.type, s._count])),
            createdInPeriod: created,
            completedInPeriod: completed,
            completionRate: created > 0 ? `${Math.round((completed / created) * 100)}%` : "0%",
          },
        };
      }

      // ═══════════════════════════════════════════════════════════
      // SEARCH
      // ═══════════════════════════════════════════════════════════

      case "search_issues": {
        const limit = Math.min(num(args.limit, 10), 25);
        const q = str(args.query);

        const issues = await prisma.issue.findMany({
          where: { workspaceId: ctx.workspaceId, OR: [{ title: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }, { id: { contains: q, mode: "insensitive" } }] },
          select: { id: true, title: true, status: true, priority: true, assignee: { select: { name: true } } },
          orderBy: { updatedAt: "desc" }, take: limit,
        });

        return { success: true, data: issues.map((i) => ({ id: i.id, title: i.title, status: i.status, priority: i.priority, assignee: i.assignee?.name ?? "Unassigned" })) };
      }

      default:
        return { success: false, data: null, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    console.error(`[Tool Executor] ${toolName} failed:`, error);
    const message = error instanceof AppError ? error.message : "Tool execution failed";
    return { success: false, data: null, error: message };
  }
}
