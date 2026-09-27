/**
 * Workspace Module — Service Layer
 *
 * Business logic for workspace CRUD operations.
 * All workspace queries are scoped correctly — no cross-tenant leaks.
 *
 * Key operations:
 *   - Create workspace + OWNER membership in a single transaction
 *   - List workspaces for a user (returns workspaces they belong to)
 *   - Check slug availability
 *   - Update/delete workspace with permission enforcement
 */

import { visibleIssueWhere, type Viewer } from "../../shared/utils/visibility.js";
import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { isPlaceholderEmail } from "../../shared/utils/crypto.js";
import {
  normalizeWorkflowAutomation,
  normalizeWorkspaceStatuses,
  statusVisibleOnBoard,
} from "../../shared/workflow/workflow-automation.js";
import {
  validateWorkflowUserReferences,
  validateWorkflowAutomationAgainstStatuses,
  validateWorkflowStatusList,
} from "../../shared/workflow/status-validation.js";
import { moveIssuesToStatus, workspaceWorkflowIssueScope } from "../../shared/workflow/bulk-status.js";
import { createInitialWorkspaceSubscription } from "../billing/billing.service.js";
import { createPresignedGetUrl, isWorkspaceLogoUrl, workspaceLogoKey } from "../../infra/storage/s3.js";
import { publicWorkspaceLogo } from "./workspace-logo.js";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  UpdateWorkspaceStatusesInput,
  UpdateWorkflowAutomationInput,
  UpdateInviteDomainPolicyInput,
} from "./workspace.schemas.js";

/**
 * Create a workspace and set up the initial structure:
 *   1. Create Workspace
 *   2. Create WorkspaceMembership (OWNER) for the creator
 *   3. Create a default Team (same name as workspace) with creator as lead
 *   4. Create TeamMembership for the creator in the default team
 *
 * All records are created in a single transaction — if any fails, nothing is persisted.
 * The default team ensures the workspace is immediately usable (issues, projects, cycles
 * all belong to a team, so at least one team must exist).
 */
/**
 * Generate an issue prefix from the workspace name.
 * Takes first 2-3 uppercase letters, deduplicates by appending a digit if taken.
 *
 * Examples: "Vative" → "VAT", "Fission" → "FIS", "My App" → "MA"
 */
async function generateUniquePrefix(name: string, explicitPrefix?: string): Promise<string> {
  if (explicitPrefix) {
    const normalized = explicitPrefix.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
    if (normalized.length < 2) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "Issue prefix must be at least 2 uppercase letters");
    }
    const existing = await prisma.workspace.findUnique({
      where: { issuePrefix: normalized },
      select: { id: true },
    });
    if (existing) {
      throw new AppError(409, ERROR_CODES.WORKSPACE_PREFIX_TAKEN, `Issue prefix "${normalized}" is already taken`);
    }
    return normalized;
  }

  // Auto-generate from name: take uppercase consonants + first letter, 2-3 chars
  const letters = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  const base = letters.length >= 3 ? letters.slice(0, 3) : letters.slice(0, Math.max(2, letters.length));

  if (base.length < 2) {
    // Fallback for very short names
    return generateUniquePrefix(name, `${base}X`);
  }

  // Check if base is available
  const existing = await prisma.workspace.findUnique({
    where: { issuePrefix: base },
    select: { id: true },
  });

  if (!existing) return base;

  // Try with suffix: VAT → VAT2 → VAT3 → ...
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base.slice(0, 3)}${i}`;
    const taken = await prisma.workspace.findUnique({
      where: { issuePrefix: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }

  // Extremely unlikely fallback
  throw new AppError(409, ERROR_CODES.WORKSPACE_PREFIX_TAKEN, "Could not generate a unique issue prefix");
}

/** Pulls "trussen.app" out of "someone@trussen.app". */
function domainFromEmail(email: string): string {
  return email.split("@")[1]!.toLowerCase();
}

export async function createWorkspace(userId: string, userEmail: string, input: CreateWorkspaceInput) {
  // Check if slug is already taken
  const existing = await prisma.workspace.findUnique({
    where: { slug: input.slug },
    select: { id: true },
  });

  if (existing) {
    throw new AppError(409, ERROR_CODES.WORKSPACE_SLUG_TAKEN, "This workspace URL is already taken");
  }

  // Generate or validate issue prefix
  const issuePrefix = await generateUniquePrefix(input.name, (input as any).issuePrefix);

  // Resolve the invite domain policy up front — COMPANY_ONLY derives its
  // one domain from the creator's own email; CUSTOM needs at least one
  // domain supplied; ANY (the default) needs nothing.
  const inviteDomainPolicy = input.inviteDomainPolicy ?? "ANY";
  let allowedEmailDomains: string[] = [];
  if (inviteDomainPolicy === "COMPANY_ONLY") {
    allowedEmailDomains = [domainFromEmail(userEmail)];
  } else if (inviteDomainPolicy === "CUSTOM") {
    if (!input.allowedEmailDomains || input.allowedEmailDomains.length === 0) {
      throw new AppError(
        422,
        ERROR_CODES.VALIDATION_ERROR,
        "Add at least one domain, or choose a different invite option",
      );
    }
    allowedEmailDomains = [...new Set(input.allowedEmailDomains)];
  }

  // Create workspace + OWNER membership + default team atomically
  const result = await prisma.$transaction(async (tx) => {
    // 1. Create the workspace
    const ws = await tx.workspace.create({
      data: {
        name: input.name,
        slug: input.slug,
        issuePrefix,
        teamSize: input.teamSize ?? null,
        createdById: userId,
        inviteDomainPolicy,
        allowedEmailDomains,
      },
    });

    // 2. Make the creator the OWNER
    await tx.workspaceMembership.create({
      data: {
        userId,
        workspaceId: ws.id,
        role: "OWNER",
      },
    });

    // 3. Create a default team with the same name as the workspace
    //    Every workspace needs at least one team — issues, projects, and cycles
    //    all belong to a team. This makes the workspace immediately usable.
    const defaultTeam = await tx.team.create({
      data: {
        workspaceId: ws.id,
        name: input.name,
        leadId: userId,
      },
    });

    // 4. Add the creator as a member of the default team
    await tx.teamMembership.create({
      data: {
        userId,
        teamId: defaultTeam.id,
      },
    });

    // 5. Create the initial FREE workspace subscription state
    await createInitialWorkspaceSubscription(tx, ws.id);

    return { workspace: ws, defaultTeam };
  });

  return {
    id: result.workspace.id,
    name: result.workspace.name,
    slug: result.workspace.slug,
    logo: result.workspace.logo,
    teamSize: result.workspace.teamSize,
    issuePrefix: result.workspace.issuePrefix,
    customStatuses: normalizeWorkspaceStatuses((result.workspace as any).customStatuses),
    workflowAutomation: normalizeWorkflowAutomation(
      (result.workspace as any).workflowAutomation,
      (result.workspace as any).customStatuses,
    ),
    role: "OWNER" as const,
    defaultTeamId: result.defaultTeam.id,
    createdAt: result.workspace.createdAt,
    inviteDomainPolicy: result.workspace.inviteDomainPolicy,
    allowedEmailDomains: result.workspace.allowedEmailDomains,
  };
}

/**
 * Update who can be invited to a workspace, by email domain.
 * ANY needs no domain list. COMPANY_ONLY re-derives its one domain from the
 * *caller's own* email (not the original creator's) — whoever is an admin
 * right now is treated as representing "the company domain" going forward.
 * CUSTOM requires at least one domain.
 */
export async function updateInviteDomainPolicy(
  workspaceId: string,
  input: UpdateInviteDomainPolicyInput,
) {
  let allowedEmailDomains: string[] = [];

  if (input.inviteDomainPolicy === "COMPANY_ONLY") {
    // Derived from the workspace's OWNER, not whichever admin happens to be
    // flipping this toggle — otherwise a non-owner admin with a different
    // email domain (e.g. an external consultant) could silently redefine
    // "the company domain" to their own, every time this setting changes.
    const owner = await prisma.workspaceMembership.findFirst({
      where: { workspaceId, role: "OWNER" },
      select: { user: { select: { email: true } } },
    });
    if (!owner) {
      throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace owner not found");
    }
    if (isPlaceholderEmail(owner.user.email)) {
      throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "The owner needs a verified email before invites can be limited to the company domain");
    }
    allowedEmailDomains = [domainFromEmail(owner.user.email)];
  } else if (input.inviteDomainPolicy === "CUSTOM") {
    if (!input.allowedEmailDomains || input.allowedEmailDomains.length === 0) {
      throw new AppError(
        422,
        ERROR_CODES.VALIDATION_ERROR,
        "Add at least one domain, or choose a different invite option",
      );
    }
    allowedEmailDomains = [...new Set(input.allowedEmailDomains)];
  }

  const workspace = await prisma.workspace.update({
    where: { id: workspaceId },
    data: { inviteDomainPolicy: input.inviteDomainPolicy, allowedEmailDomains },
    select: { id: true, inviteDomainPolicy: true, allowedEmailDomains: true },
  });

  return workspace;
}

/**
 * List all workspaces the user belongs to.
 * Returns workspace details + the user's role in each + default team + unread notifications.
 * Used by frontend to populate workspace switcher and determine onboarding state.
 */
export async function listWorkspaces(userId: string) {
  const memberships = await prisma.workspaceMembership.findMany({
    where: { userId },
    include: {
      workspace: {
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          teamSize: true,
          issuePrefix: true,
          customStatuses: true,
          workflowAutomation: true,
          uploadPolicy: true,
          allowPublicDriveLinks: true,
          inviteDomainPolicy: true,
          allowedEmailDomains: true,
          createdAt: true,
          deactivatedAt: true,
          purgeAt: true,
        },
      },
    },
    orderBy: { joinedAt: "desc" },
  });

  const workspaceIds = memberships.map((m) => m.workspaceId);

  if (workspaceIds.length === 0) {
    return [];
  }

  // Batch: per-workspace unread notification counts + default team per workspace
  const [unreadCounts, defaultTeams] = await Promise.all([
    (prisma as any).notification.groupBy({
      by: ["workspaceId"],
      where: {
        recipientUserId: userId,
        readAt: null,
        workspaceId: { in: workspaceIds },
      },
      _count: true,
    }),
    prisma.team.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { id: true, workspaceId: true },
      orderBy: { createdAt: "asc" },
      distinct: ["workspaceId"],
    }),
  ]);

  const unreadMap = new Map<string, number>(
    unreadCounts.map((c: any) => [c.workspaceId, c._count]),
  );
  const defaultTeamMap = new Map<string, string>(
    defaultTeams.map((t: { id: string; workspaceId: string }) => [t.workspaceId, t.id]),
  );

  return memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    logo: publicWorkspaceLogo(m.workspace),
    teamSize: m.workspace.teamSize,
    issuePrefix: m.workspace.issuePrefix,
    customStatuses: normalizeWorkspaceStatuses(m.workspace.customStatuses as any[]),
    workflowAutomation: normalizeWorkflowAutomation(
      m.workspace.workflowAutomation,
      m.workspace.customStatuses as any[],
    ),
    uploadPolicy: m.workspace.uploadPolicy,
    allowPublicDriveLinks: m.workspace.allowPublicDriveLinks,
    inviteDomainPolicy: m.workspace.inviteDomainPolicy,
    allowedEmailDomains: m.workspace.allowedEmailDomains,
    role: m.role,
    defaultTeamId: defaultTeamMap.get(m.workspace.id) ?? null,
    unreadNotifications: unreadMap.get(m.workspace.id) ?? 0,
    joinedAt: m.joinedAt,
    createdAt: m.workspace.createdAt,
    // Soft delete: the picker shows "Deactivated by Owner", or a restore
    // screen for an OWNER (canRestore), instead of opening the workspace.
    deactivatedAt: m.workspace.deactivatedAt,
    purgeAt: m.workspace.purgeAt,
    canRestore: m.workspace.deactivatedAt !== null && m.role === "OWNER",
  }));
}

/**
 * Get workspace details by ID.
 * Only returns data if the user is a member (enforced by requireWorkspace middleware).
 */
export async function getWorkspaceById(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      teamSize: true,
      issuePrefix: true,
      issueCounter: true,
      customStatuses: true,
      workflowAutomation: true,
      uploadPolicy: true,
      allowPublicDriveLinks: true,
      inviteDomainPolicy: true,
      allowedEmailDomains: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          memberships: true,
          projects: true,
          issues: true,
          teams: true,
          departments: true,
        },
      },
    },
  });

  if (!workspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }

  return {
    ...workspace,
    logo: publicWorkspaceLogo(workspace),
    customStatuses: normalizeWorkspaceStatuses(workspace.customStatuses as any[]),
    workflowAutomation: normalizeWorkflowAutomation(workspace.workflowAutomation, workspace.customStatuses as any[]),
  };
}

/**
 * Update workspace settings (name, logo).
 * Slug cannot be changed after creation.
 */
export async function updateWorkspace(workspaceId: string, input: UpdateWorkspaceInput) {
  // Checked here rather than in the route schema so the AI update_workspace
  // tool, which calls this directly, is held to the same rule (F-36).
  let logo = input.logo === undefined ? undefined : input.logo?.trim() || null;
  if (logo && !isWorkspaceLogoUrl(workspaceId, logo)) {
    // Clients (and the AI, via get_workspace) only ever see the served
    // address; sending that back unchanged means "keep the current logo".
    const current = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, logo: true } });
    if (current && logo === publicWorkspaceLogo(current)) {
      logo = undefined;
    } else {
      throw new AppError(
        422,
        ERROR_CODES.VALIDATION_ERROR,
        "The workspace logo must be an image uploaded to this workspace. Links to other sites aren't allowed.",
      );
    }
  }

  const workspace = await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(logo !== undefined && { logo }),
      ...(input.uploadPolicy !== undefined && { uploadPolicy: input.uploadPolicy }),
      // Turning it off doesn't touch files already shared publicly — they're
      // listed in Settings for their uploaders to tighten (F-39).
      ...(input.allowPublicDriveLinks !== undefined && { allowPublicDriveLinks: input.allowPublicDriveLinks }),
    },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      teamSize: true,
      customStatuses: true,
      workflowAutomation: true,
      uploadPolicy: true,
      allowPublicDriveLinks: true,
      updatedAt: true,
    },
  });

  return {
    ...workspace,
    logo: publicWorkspaceLogo(workspace),
    customStatuses: normalizeWorkspaceStatuses(workspace.customStatuses as any[]),
    workflowAutomation: normalizeWorkflowAutomation(workspace.workflowAutomation, workspace.customStatuses as any[]),
  };
}

// Deleting a workspace is a soft delete: see workspace-lifecycle.service.ts.

/**
 * Check if a slug is available.
 * Used by frontend for real-time validation as user types.
 */
export async function checkSlugAvailability(slug: string) {
  const existing = await prisma.workspace.findUnique({
    where: { slug },
    select: { id: true },
  });

  return { available: !existing };
}

/** Signed logo links live 5 minutes; browsers may cache the redirect for 4. */
export const LOGO_LINK_TTL_SECONDS = 300;

/**
 * Signed, short-lived link to a workspace's uploaded logo — PUBLIC, it's shown
 * on the sign-in and invite pages. Only ever our own upload for this
 * workspace (F-36); anything else is treated as "no logo".
 */
export async function getWorkspaceLogoRedirect(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { logo: true } });
  const key = workspace?.logo ? workspaceLogoKey(workspaceId, workspace.logo) : null;
  if (!key) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "No logo");
  }
  return createPresignedGetUrl(key, LOGO_LINK_TTL_SECONDS);
}

/**
 * Look up a workspace by its subdomain slug — PUBLIC, unauthenticated.
 *
 * Used by the frontend before login to decide what to show on
 * `<slug>.trussen.app`: a sign-in page (workspace exists) or a redirect to
 * the marketing landing page (it doesn't). Only ever returns display-safe
 * fields — never anything that would leak workspace contents to a visitor
 * who hasn't proven membership yet.
 */
export async function resolveWorkspaceBySlug(slug: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { slug },
    // `id` is read only to check the logo — an anonymous, pre-login caller has
    // no use for the internal workspace UUID, so it isn't handed out.
    select: { id: true, name: true, slug: true, logo: true },
  });

  if (!workspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "No workspace found for this address");
  }

  // Public, pre-login page: only our own uploaded logo, never a third-party URL (F-36).
  return { name: workspace.name, slug: workspace.slug, logo: publicWorkspaceLogo(workspace) };
}

/**
 * Get workspace custom statuses.
 */
export async function getWorkspaceStatuses(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { customStatuses: true },
  });

  if (!workspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }

  return normalizeWorkspaceStatuses(workspace.customStatuses as any[]);
}

const STATUS_USAGE_PREVIEW_LIMIT = 25;
const STATUS_USAGE_EXPORT_LIMIT = 1000;

export async function getWorkspaceStatusUsage(workspaceId: string, viewer: Viewer, statusKey: string, limit?: number) {
  const statuses = await getWorkspaceStatuses(workspaceId);
  const status = statuses.find((item) => item.key === statusKey);

  if (!status) {
    throw new AppError(404, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "Workflow status not found");
  }

  const take = Math.min(limit ?? STATUS_USAGE_PREVIEW_LIMIT, STATUS_USAGE_EXPORT_LIMIT);

  // Spans every project, so it must be filtered per viewer — unfiltered this
  // returned up to 1000 issue keys + titles + project names to a GUEST (F-06 a).
  // Only issues this workflow governs — projects with their own override keep
  // their issues even when they reuse the key, so counting them here would
  // misreport what a merge or removal is about to touch (F-34).
  const where = {
    AND: [await workspaceWorkflowIssueScope(prisma, workspaceId), { status: statusKey }, visibleIssueWhere(viewer)],
  };

  const [issueCount, issues] = await Promise.all([
    prisma.issue.count({ where }),
    prisma.issue.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: take + 1,
      select: {
        id: true,
        title: true,
        project: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    }),
  ]);

  const truncated = issues.length > take;

  return {
    statusKey,
    label: status.label,
    issueCount,
    truncated,
    issues: issues.slice(0, take).map((issue) => ({
      id: issue.id,
      publicId: issue.id,
      title: issue.title,
      project: issue.project
        ? {
            id: issue.project.id,
            name: issue.project.name,
          }
        : null,
    })),
  };
}

/**
 * Merge one status into another: every issue currently on sourceKey moves to
 * targetKey, then sourceKey is removed from the workflow (and stripped from any
 * other status's transition list). A dedicated action instead of routing merges
 * through the generic "replace the whole status list" update — safer, since the
 * caller doesn't have to resend every other status untouched.
 */
export async function mergeWorkspaceStatus(workspaceId: string, sourceKey: string, targetKey: string) {
  if (sourceKey === targetKey) {
    throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "Merge source and target must be different");
  }

  const statuses = await getWorkspaceStatuses(workspaceId);
  const sourceStatus = statuses.find((status) => status.key === sourceKey);
  const targetStatus = statuses.find((status) => status.key === targetKey);
  if (!sourceStatus) {
    throw new AppError(404, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "Source status not found");
  }
  if (!targetStatus) {
    throw new AppError(404, ERROR_CODES.INVALID_WORKSPACE_STATUSES, "Target status not found");
  }

  const remaining = statuses
    .filter((status) => status.key !== sourceKey)
    .map((status) => ({
      ...status,
      transitions: { ...status.transitions, to: status.transitions.to.filter((key) => key !== sourceKey) },
    }));

  const validatedStatuses = validateWorkflowStatusList(remaining, ERROR_CODES.INVALID_WORKSPACE_STATUSES);
  const nextStatuses = validatedStatuses.map((status, index) => ({
    ...status,
    order: index,
    showOnBoard: statusVisibleOnBoard(status),
  }));

  const currentWorkspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { workflowAutomation: true },
  });
  if (!currentWorkspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Scope resolved inside the transaction so it matches the rows written.
    await moveIssuesToStatus(tx, await workspaceWorkflowIssueScope(tx, workspaceId), sourceKey, targetStatus);

    return tx.workspace.update({
      where: { id: workspaceId },
      data: {
        customStatuses: nextStatuses as any,
        workflowAutomation: normalizeWorkflowAutomation(currentWorkspace.workflowAutomation, nextStatuses) as any,
      },
      select: { customStatuses: true },
    });
  });

  return updated.customStatuses as any[];
}

/**
 * Get workflow automation config for a workspace.
 */
export async function getWorkflowAutomation(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { customStatuses: true, workflowAutomation: true },
  });

  if (!workspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }

  return normalizeWorkflowAutomation(workspace.workflowAutomation, workspace.customStatuses as any[]);
}

/**
 * Replace the entire custom statuses array for a workspace.
 * Validates structure, uniqueness, and business rules.
 */
export async function updateWorkspaceStatuses(workspaceId: string, input: UpdateWorkspaceStatusesInput) {
  const statuses = input.statuses;
  const removalResolutions = input.removalResolutions ?? [];

  const normalizedStatuses = validateWorkflowStatusList(statuses, ERROR_CODES.INVALID_WORKSPACE_STATUSES);
  await validateWorkflowUserReferences(prisma, workspaceId, normalizedStatuses, ERROR_CODES.INVALID_WORKSPACE_STATUSES);

  const currentStatuses = await getWorkspaceStatuses(workspaceId);
  const currentKeys = new Set(currentStatuses.map((s: any) => s.key));
  const newKeys = new Set(statuses.map((s) => s.key));
  const removedKeys = [...currentKeys].filter((k) => !newKeys.has(k));
  const resolutionMap = new Map(removalResolutions.map((resolution) => [resolution.statusKey, resolution]));

  for (const resolution of removalResolutions) {
    if (!removedKeys.includes(resolution.statusKey)) {
      throw new AppError(
        422,
        ERROR_CODES.INVALID_WORKSPACE_STATUSES,
        `Removal resolution references a status that is not being removed: ${resolution.statusKey}`,
      );
    }
  }

  // Projects with their own workflow are unaffected by removing a workspace
  // status, so their issues neither block the removal nor get resolved (F-34).
  const removedStatusCounts =
    removedKeys.length > 0
      ? await (prisma as any).issue.groupBy({
          by: ["status"],
          where: { AND: [await workspaceWorkflowIssueScope(prisma, workspaceId), { status: { in: removedKeys } }] },
          _count: { _all: true },
        })
      : [];

  const removedStatusCountMap = new Map<string, number>(
    (removedStatusCounts as Array<{ status: string; _count: { _all: number } }>).map((item) => [item.status, item._count._all]),
  );

  for (const removedKey of removedKeys) {
    const affectedCount = removedStatusCountMap.get(removedKey) ?? 0;
    if (affectedCount === 0) continue;

    const resolution = resolutionMap.get(removedKey);
    if (!resolution) {
      throw new AppError(
        422,
        ERROR_CODES.INVALID_WORKSPACE_STATUSES,
        `Cannot remove ${removedKey} while ${affectedCount} issue(s) still use it. Move those issues to another workflow or delete them with the workflow.`,
      );
    }

    if (resolution.action === "move") {
      if (!resolution.targetStatusKey) {
        throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, `A destination workflow is required for ${removedKey}`);
      }
      if (!newKeys.has(resolution.targetStatusKey)) {
        throw new AppError(
          422,
          ERROR_CODES.INVALID_WORKSPACE_STATUSES,
          `Destination workflow ${resolution.targetStatusKey} must remain in the workflow list`,
        );
      }
      if (resolution.targetStatusKey === removedKey) {
        throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, `Destination workflow for ${removedKey} must be different`);
      }
    }
  }

  const currentWorkspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { workflowAutomation: true },
  });

  if (!currentWorkspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }

  const nextStatuses = normalizedStatuses.map((status, index) => ({
    ...status,
    order: index,
    showOnBoard: statusVisibleOnBoard(status),
  }));
  const nextStatusMap = new Map(nextStatuses.map((status) => [status.key, status]));

  const workspace = await prisma.$transaction(async (tx) => {
    const scope = removedKeys.length > 0 ? await workspaceWorkflowIssueScope(tx, workspaceId) : { workspaceId };

    for (const removedKey of removedKeys) {
      const affectedCount = removedStatusCountMap.get(removedKey) ?? 0;
      if (affectedCount === 0) continue;

      const resolution = resolutionMap.get(removedKey)!;

      if (resolution.action === "move") {
        const targetStatus = nextStatusMap.get(resolution.targetStatusKey!);
        if (!targetStatus) {
          throw new AppError(422, ERROR_CODES.INVALID_WORKSPACE_STATUSES, `Destination workflow ${resolution.targetStatusKey} was not found`);
        }

        await moveIssuesToStatus(tx, scope, removedKey, targetStatus);
        continue;
      }

      await tx.issue.deleteMany({
        where: { AND: [scope, { status: removedKey }] },
      });
    }

    return tx.workspace.update({
      where: { id: workspaceId },
      data: {
        customStatuses: nextStatuses as any,
        workflowAutomation: normalizeWorkflowAutomation(
          currentWorkspace.workflowAutomation,
          nextStatuses,
        ) as any,
      },
      select: { customStatuses: true },
    });
  });

  return workspace.customStatuses as any[];
}

/**
 * Replace workflow automation config for a workspace.
 */
export async function updateWorkflowAutomation(
  workspaceId: string,
  input: UpdateWorkflowAutomationInput,
) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { customStatuses: true },
  });

  if (!workspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }

  const statuses = normalizeWorkspaceStatuses(workspace.customStatuses as any[]);
  const normalized = validateWorkflowAutomationAgainstStatuses(input, statuses, ERROR_CODES.INVALID_WORKSPACE_STATUSES);

  const updated = await prisma.workspace.update({
    where: { id: workspaceId },
    data: { workflowAutomation: normalized as any },
    select: { workflowAutomation: true, customStatuses: true },
  });

  return normalizeWorkflowAutomation(updated.workflowAutomation, updated.customStatuses as any[]);
}
