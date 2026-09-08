/**
 * Workspace Invitation — Service Layer
 *
 * Handles the full invitation lifecycle with production-grade security:
 *
 * Security measures:
 *   1. Token HASHED before storage (SHA-256) — raw token only in the email link
 *   2. Email-bound acceptance — authenticated user's email MUST match invitation email
 *   3. Idempotent accept — double-click safe, returns success if already accepted
 *   4. Revoke + recreate on resend — no immortal invites, clean audit trail
 *   5. Email normalization — prevents duplicate membership from case differences
 *   6. Expiry enforcement — checked on resolve AND accept
 *
 * Lifecycle: PENDING → ACCEPTED / EXPIRED / REVOKED
 */

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { generateToken, hashToken, normalizeEmail } from "../../shared/utils/crypto.js";
import { sendInvitationEmail } from "../../infra/email/index.js";
import { env } from "../../config/env.js";
import { logActivity } from "../../shared/utils/activity.js";
import {
  enforceFreeWorkspaceCapacity,
  syncPaidSeatQuantityBestEffort,
} from "../billing/billing.service.js";
import { createNotification } from "../notification/notification.service.js";

/** Invitations expire after 7 days */
const INVITE_EXPIRY_DAYS = 7;

/**
 * Create and send a workspace invitation.
 *
 * If a PENDING invite already exists for this email+workspace:
 *   → Revoke the old one + create a new one (clean audit trail, no immortal invites)
 *
 * If the email is already a workspace member:
 *   → Reject with MEMBER_ALREADY_EXISTS
 */
export async function createInvitation(params: {
  workspaceId: string;
  email: string;
  role: "ADMIN" | "MEMBER" | "GUEST";
  designation: string;
  teamId: string;
  departmentId?: string;
  invitedById: string;
  inviterName: string;
  workspaceName: string;
}) {
  const email = normalizeEmail(params.email);

  await enforceFreeWorkspaceCapacity(params.workspaceId, email);

  // Check if already a member (by email → find user → check membership)
  const existingUser = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existingUser) {
    const existingMembership = await prisma.workspaceMembership.findUnique({
      where: {
        userId_workspaceId: {
          userId: existingUser.id,
          workspaceId: params.workspaceId,
        },
      },
      select: { id: true },
    });

    if (existingMembership) {
      throw new AppError(409, ERROR_CODES.ALREADY_MEMBER, `${email} is already a member of this workspace`);
    }
  }

  // Revoke any existing PENDING invites for this email+workspace (no immortal invites)
  await prisma.workspaceInvitation.updateMany({
    where: {
      workspaceId: params.workspaceId,
      email,
      status: "PENDING",
    },
    data: {
      status: "REVOKED",
      revokedAt: new Date(),
    },
  });

  // Generate secure token — raw token goes in email, hash goes in DB
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + INVITE_EXPIRY_DAYS);

  // Verify the team exists in this workspace
  const team = await prisma.team.findFirst({
    where: { id: params.teamId, workspaceId: params.workspaceId },
    select: { id: true },
  });

  if (!team) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Team not found in this workspace");
  }

  // Verify department exists in this workspace (if provided)
  if (params.departmentId) {
    const department = await prisma.department.findFirst({
      where: { id: params.departmentId, workspaceId: params.workspaceId },
      select: { id: true },
    });

    if (!department) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND, "Department not found in this workspace");
    }
  }

  // Create the invitation record
  const invitation = await prisma.workspaceInvitation.create({
    data: {
      workspaceId: params.workspaceId,
      email,
      role: params.role,
      designation: params.designation?.trim() || null,
      teamId: params.teamId,
      departmentId: params.departmentId ?? null,
      tokenHash,
      invitedById: params.invitedById,
      expiresAt,
    },
    select: {
      id: true,
      email: true,
      role: true,
      designation: true,
      status: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  const inviteUrl = `${env.FRONTEND_URL}/invite?token=${rawToken}`;

  // Dev/staging convenience: always log the invite URL so manual sharing is possible
  // when provider free-tier delivery limits block outbound email.
  if (env.NODE_ENV !== "production") {
    console.log("[Invite] Workspace invitation link");
    console.log(`  Workspace: ${params.workspaceName} (${params.workspaceId})`);
    console.log(`  Email: ${email}`);
    console.log(`  URL: ${inviteUrl}`);
  }

  // Send the invitation email (raw token in the link, not the hash)
  try {
    await sendInvitationEmail({
      to: email,
      inviterName: params.inviterName,
      workspaceName: params.workspaceName,
      role: params.role,
      inviteToken: rawToken,
    });
  } catch (error) {
    // In production we still fail hard on delivery errors.
    if (env.NODE_ENV === "production") {
      throw error;
    }

    // In non-production, keep invite creation successful and rely on logged URL.
    console.warn("[Invite] Email delivery failed; using logged invite URL fallback", {
      workspaceId: params.workspaceId,
      email,
      error,
    });
  }

  // Send in-app notification to existing platform users so they can accept
  // from their notification inbox without needing to check email.
  if (existingUser) {
    await createNotification({
      workspaceId: params.workspaceId,
      recipientUserId: existingUser.id,
      actorUserId: params.invitedById,
      type: "WORKSPACE_INVITATION",
      category: "membership",
      title: "Workspace invitation",
      message: `${params.inviterName} invited you to join ${params.workspaceName} as ${params.role}`,
      target: {
        type: "workspace",
        id: params.workspaceId,
        url: `/invite?token=${rawToken}`,
      },
      metadata: {
        workspaceId: params.workspaceId,
        workspaceName: params.workspaceName,
        role: params.role,
        invitationId: invitation.id,
        invitedBy: params.inviterName,
      },
      eventId: `invitation:${invitation.id}`,
    }).catch(() => {
      // Non-critical — invitation was created successfully, notification is best-effort
    });
  }

  return {
    ...invitation,
    existingUser: !!existingUser,
  };
}

/**
 * Resolve an invitation by its raw token.
 * Returns metadata only (workspace name, role, invited email) — no sensitive data.
 *
 * This endpoint is PUBLIC (no auth required) so the invite page can show
 * "You've been invited to Acme Corp" before the user signs in.
 *
 * Validates:
 *   - Token exists (hashed lookup)
 *   - Status is PENDING
 *   - Not expired
 */
export async function resolveInvitation(rawToken: string) {
  const tokenHash = hashToken(rawToken);

  const invitation = await prisma.workspaceInvitation.findUnique({
    where: { tokenHash },
    include: {
      workspace: {
        select: { id: true, name: true, slug: true, logo: true },
      },
      team: {
        select: { id: true, name: true },
      },
      department: {
        select: { id: true, name: true },
      },
    },
  });

  if (!invitation) {
    throw new AppError(404, ERROR_CODES.INVITATION_NOT_FOUND, "Invitation not found or has been revoked");
  }

  if (invitation.status === "ACCEPTED") {
    throw new AppError(400, ERROR_CODES.INVITATION_ALREADY_ACCEPTED, "This invitation has already been accepted");
  }

  if (invitation.status === "REVOKED") {
    throw new AppError(410, ERROR_CODES.INVITATION_REVOKED, "This invitation has been revoked");
  }

  if (invitation.status !== "PENDING") {
    throw new AppError(400, ERROR_CODES.CONFLICT, `This invitation has already been ${invitation.status.toLowerCase()}`);
  }

  if (invitation.expiresAt < new Date()) {
    // Auto-mark as expired
    await prisma.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    throw new AppError(410, ERROR_CODES.INVITATION_EXPIRED, "This invitation has expired");
  }

  return {
    workspaceId: invitation.workspace.id,
    workspaceName: invitation.workspace.name,
    workspaceSlug: invitation.workspace.slug,
    workspaceLogo: invitation.workspace.logo,
    role: invitation.role,
    designation: invitation.designation,
    teamName: invitation.team.name,
    departmentName: invitation.department?.name ?? null,
    invitedEmail: invitation.email,
  };
}

/**
 * Accept an invitation.
 *
 * Security: The authenticated user's email MUST match the invitation email.
 * This prevents forwarded-invite abuse (someone else using the link).
 *
 * Idempotent: If the user is already a member (double-click), returns success.
 *
 * On success:
 *   1. Creates WorkspaceMembership with the invited role
 *   2. Marks invitation as ACCEPTED
 *   3. Returns the workspace details
 */
export async function acceptInvitation(rawToken: string, userId: string, userEmail: string) {
  const tokenHash = hashToken(rawToken);
  const invitation = await prisma.workspaceInvitation.findUnique({
    where: { tokenHash },
    include: {
      workspace: {
        select: { id: true, name: true, slug: true, logo: true },
      },
    },
  });

  if (!invitation) {
    throw new AppError(404, ERROR_CODES.INVITATION_NOT_FOUND, "Invitation not found or has been revoked");
  }

  return acceptInvitationRecord(invitation, userId, userEmail);
}

async function acceptInvitationRecord(
  invitation: {
    id: string;
    workspaceId: string;
    email: string;
    role: any;
    designation: string | null;
    status: any;
    expiresAt: Date;
    invitedById: string;
    teamId: string;
    departmentId: string | null;
    workspace: {
      id: string;
      name: string;
      slug: string;
      logo: string | null;
    };
  },
  userId: string,
  userEmail: string,
) {
  const normalizedUserEmail = normalizeEmail(userEmail);

  // ─── Email ownership verification ──────────────────────────────────────
  // The authenticated user's email MUST match the invitation email.
  // This prevents: Jane gets invite → forwards link to Mike → Mike accepts.
  if (normalizedUserEmail !== invitation.email) {
    throw new AppError(
      403,
      ERROR_CODES.INVITATION_EMAIL_MISMATCH,
      "This invitation was sent to a different email address. Sign in with the invited email.",
    );
  }

  // ─── Status checks ────────────────────────────────────────────────────
  if (invitation.status === "ACCEPTED") {
    // Idempotent — already accepted, return success (double-click safe)
    return {
      workspace: {
        id: invitation.workspace.id,
        name: invitation.workspace.name,
        slug: invitation.workspace.slug,
        logo: invitation.workspace.logo,
      },
      role: invitation.role,
      alreadyAccepted: true,
    };
  }

  if (invitation.status === "REVOKED") {
    throw new AppError(410, ERROR_CODES.INVITATION_REVOKED, "This invitation has been revoked");
  }

  if (invitation.status !== "PENDING") {
    throw new AppError(400, ERROR_CODES.CONFLICT, `This invitation has been ${invitation.status.toLowerCase()}`);
  }

  if (invitation.expiresAt < new Date()) {
    await prisma.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    throw new AppError(410, ERROR_CODES.INVITATION_EXPIRED, "This invitation has expired");
  }

  // ─── Check if already a member (extra idempotency) ────────────────────
  const existingMembership = await prisma.workspaceMembership.findUnique({
    where: {
      userId_workspaceId: {
        userId,
        workspaceId: invitation.workspaceId,
      },
    },
  });

  if (existingMembership) {
    // Already a member — mark invite accepted and return
    await prisma.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED", acceptedAt: new Date() },
    });

    return {
      workspace: {
        id: invitation.workspace.id,
        name: invitation.workspace.name,
        slug: invitation.workspace.slug,
        logo: invitation.workspace.logo,
      },
      role: existingMembership.role,
      alreadyAccepted: true,
    };
  }

  // ─── Create memberships + mark accepted (transaction) ─────────────────
  // Creates: WorkspaceMembership + TeamMembership + optional DepartmentMembership
  const operations = [
    // Workspace membership
    prisma.workspaceMembership.create({
      data: {
        userId,
        workspaceId: invitation.workspaceId,
        role: invitation.role,
        designation: invitation.designation,
        invitedById: invitation.invitedById,
      },
    }),
    // Team membership (required — invitee is assigned to a team)
    prisma.teamMembership.create({
      data: {
        userId,
        teamId: invitation.teamId,
      },
    }),
    // Mark invitation as accepted
    prisma.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED", acceptedAt: new Date() },
    }),
  ];

  // Department membership (optional — only if invitation specified a department)
  if (invitation.departmentId) {
    operations.push(
      prisma.departmentMembership.create({
        data: {
          userId,
          departmentId: invitation.departmentId,
        },
      }) as any,
    );
  }

  await prisma.$transaction(operations);

  // Log activity and sync billing AFTER transaction succeeds
  await logActivity({
    workspaceId: invitation.workspaceId,
    actorId: userId,
    type: "WORKSPACE_MEMBER_JOINED",
    targetType: "MEMBER",
    targetId: userId,
      message: `${normalizedUserEmail} joined workspace`,
    metadata: {
      member: { id: userId, email: normalizedUserEmail, designation: invitation.designation },
      roleAfter: invitation.role,
    },
  });

  await syncPaidSeatQuantityBestEffort(invitation.workspaceId);

  return {
    workspace: {
      id: invitation.workspace.id,
      name: invitation.workspace.name,
      slug: invitation.workspace.slug,
      logo: invitation.workspace.logo,
    },
    role: invitation.role,
    alreadyAccepted: false,
  };
}

export async function acceptInvitationById(invitationId: string, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  if (!user?.email) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Authenticated user was not found");
  }

  const invitation = await prisma.workspaceInvitation.findUnique({
    where: { id: invitationId },
    include: {
      workspace: {
        select: { id: true, name: true, slug: true, logo: true },
      },
    },
  });

  if (!invitation) {
    throw new AppError(404, ERROR_CODES.INVITATION_NOT_FOUND, "Invitation not found or has been revoked");
  }

  return acceptInvitationRecord(invitation, userId, user.email);
}

/**
 * Revoke a pending invitation.
 * Called by workspace admins to cancel an invite before it's accepted.
 */
export async function revokeInvitation(invitationId: string, workspaceId: string) {
  const invitation = await prisma.workspaceInvitation.findFirst({
    where: { id: invitationId, workspaceId, status: "PENDING" },
  });

  if (!invitation) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Pending invitation not found");
  }

  await prisma.workspaceInvitation.update({
    where: { id: invitationId },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
}

/**
 * List all invitations for a workspace.
 * Returns pending, accepted, expired, and revoked invitations.
 */
export async function listInvitations(workspaceId: string) {
  const invitations = await prisma.workspaceInvitation.findMany({
    where: { workspaceId },
    include: {
      invitedBy: {
        select: { id: true, name: true, email: true },
      },
      team: {
        select: { id: true, name: true },
      },
      department: {
        select: { id: true, name: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return invitations.map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    designation: inv.designation,
    status: inv.status,
    teamId: inv.team.id,
    teamName: inv.team.name,
    departmentId: inv.department?.id ?? null,
    departmentName: inv.department?.name ?? null,
    invitedByName: inv.invitedBy.name,
    expiresAt: inv.expiresAt,
    acceptedAt: inv.acceptedAt,
    createdAt: inv.createdAt,
  }));
}

export async function listPendingInvitationsForUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  if (!user?.email) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Authenticated user was not found");
  }

  const email = normalizeEmail(user.email);
  await prisma.workspaceInvitation.updateMany({
    where: {
      email,
      status: "PENDING",
      expiresAt: { lt: new Date() },
    },
    data: { status: "EXPIRED" },
  });

  const invitations = await prisma.workspaceInvitation.findMany({
    where: {
      email,
      status: "PENDING",
      expiresAt: { gte: new Date() },
    },
    include: {
      workspace: {
        select: { id: true, name: true, slug: true, logo: true },
      },
      invitedBy: {
        select: { id: true, name: true, email: true },
      },
      team: {
        select: { id: true, name: true },
      },
      department: {
        select: { id: true, name: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return invitations.map((inv) => ({
    id: inv.id,
    workspace: inv.workspace,
    email: inv.email,
    role: inv.role,
    designation: inv.designation,
    team: inv.team,
    department: inv.department,
    invitedBy: inv.invitedBy,
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
  }));
}
