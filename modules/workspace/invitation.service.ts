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
  teamId: string;
  departmentId?: string;
  invitedById: string;
  inviterName: string;
  workspaceName: string;
}) {
  const email = normalizeEmail(params.email);

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
      throw new AppError(409, ERROR_CODES.MEMBER_ALREADY_EXISTS, "This user is already a member of this workspace");
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

  return invitation;
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
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Invitation not found or has been revoked");
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
    throw new AppError(400, ERROR_CODES.CONFLICT, "This invitation has expired");
  }

  return {
    workspaceId: invitation.workspace.id,
    workspaceName: invitation.workspace.name,
    workspaceSlug: invitation.workspace.slug,
    workspaceLogo: invitation.workspace.logo,
    role: invitation.role,
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
  const normalizedUserEmail = normalizeEmail(userEmail);

  const invitation = await prisma.workspaceInvitation.findUnique({
    where: { tokenHash },
    include: {
      workspace: {
        select: { id: true, name: true, slug: true },
      },
    },
  });

  if (!invitation) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Invitation not found or has been revoked");
  }

  // ─── Email ownership verification ──────────────────────────────────────
  // The authenticated user's email MUST match the invitation email.
  // This prevents: Jane gets invite → forwards link to Mike → Mike accepts.
  if (normalizedUserEmail !== invitation.email) {
    throw new AppError(
      403,
      ERROR_CODES.FORBIDDEN,
      "This invitation was sent to a different email address. Sign in with the invited email.",
    );
  }

  // ─── Status checks ────────────────────────────────────────────────────
  if (invitation.status === "ACCEPTED") {
    // Idempotent — already accepted, return success (double-click safe)
    return {
      workspaceId: invitation.workspace.id,
      workspaceName: invitation.workspace.name,
      workspaceSlug: invitation.workspace.slug,
      role: invitation.role,
      alreadyAccepted: true,
    };
  }

  if (invitation.status !== "PENDING") {
    throw new AppError(400, ERROR_CODES.CONFLICT, `This invitation has been ${invitation.status.toLowerCase()}`);
  }

  if (invitation.expiresAt < new Date()) {
    await prisma.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    throw new AppError(400, ERROR_CODES.CONFLICT, "This invitation has expired");
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
      workspaceId: invitation.workspace.id,
      workspaceName: invitation.workspace.name,
      workspaceSlug: invitation.workspace.slug,
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

  return {
    workspaceId: invitation.workspace.id,
    workspaceName: invitation.workspace.name,
    workspaceSlug: invitation.workspace.slug,
    role: invitation.role,
    alreadyAccepted: false,
  };
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
    status: inv.status,
    team: inv.team,
    department: inv.department,
    invitedBy: inv.invitedBy,
    expiresAt: inv.expiresAt,
    acceptedAt: inv.acceptedAt,
    createdAt: inv.createdAt,
  }));
}
