/**
 * Auth Module — Service Layer
 *
 * Handles user synchronization between Clerk and our database.
 * Clerk is the source of truth for auth — this service keeps our User table
 * in sync via webhook events (user.created, user.updated, user.deleted).
 *
 * Our User table only stores profile data needed for relations and display.
 * Auth state (passwords, OAuth tokens, sessions) lives entirely in Clerk.
 */

import { prisma } from "../../shared/utils/prisma.js";
import { releaseWorkspaceDrivesOf } from "../drive/drive.service.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { normalizeEmail } from "../../shared/utils/crypto.js";
import type { ClerkUserPayload } from "./auth.schemas.js";

/**
 * The email we store, which invitations and everything else trust. Only a
 * verified address counts: the primary one if verified, else any verified one
 * (N-02). The first address could be one the person never proved they own.
 * With none verified, a placeholder that matches no invitation is stored
 * (email is unique, so it also can't take anyone's address); the next
 * user.updated after verifying replaces it.
 */
export function verifiedEmailOf(data: ClerkUserPayload) {
  const verified = data.email_addresses.filter((e) => e.verification?.status === "verified");
  const email = verified.find((e) => e.id === data.primary_email_address_id) ?? verified[0];
  return email ? normalizeEmail(email.email_address) : `${data.id}@unverified.invalid`;
}

/**
 * Create or update a user from Clerk webhook data.
 * Called on `user.created` event.
 * Uses upsert for idempotency — if webhook fires twice, we don't fail.
 */
export async function createUser(data: ClerkUserPayload) {
  const primaryEmail = verifiedEmailOf(data);
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || "User";

  return prisma.user.upsert({
    where: { id: data.id },
    create: {
      id: data.id,
      email: primaryEmail,
      name,
      avatar: data.image_url,
    },
    update: {
      email: primaryEmail,
      name,
      avatar: data.image_url,
    },
  });
}

/**
 * Update a user's profile from Clerk webhook data.
 * Called on `user.updated` event.
 * Only updates fields that Clerk manages (name, email, avatar).
 */
export async function updateUser(data: ClerkUserPayload) {
  const primaryEmail = verifiedEmailOf(data);
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || "User";

  return prisma.user.upsert({
    where: { id: data.id },
    create: {
      id: data.id,
      email: primaryEmail,
      name,
      avatar: data.image_url,
    },
    update: {
      email: primaryEmail,
      name,
      avatar: data.image_url,
    },
  });
}

/**
 * Offboard a user whose Clerk account was deleted (`user.deleted`).
 *
 * This used to call `prisma.user.delete`, which ALWAYS threw: Activity,
 * ApiKey, Issue, Comment, Workspace and Team all reference User with
 * ON DELETE RESTRICT, and every member has at least one Activity row from
 * joining. The webhook returned 500, Clerk's retries failed identically, and
 * the account's API keys and memberships stayed live indefinitely (F-19).
 *
 * So the row is kept — authorship on issues and comments has to survive — and
 * access is revoked instead, in one transaction:
 *   - `deletedAt` stamped, so API-key auth can reject the creator
 *   - workspace/team/department/project memberships removed (also frees seats)
 *   - API keys deleted, AI connections revoked
 *   - Google Drive tokens deleted
 *
 * Idempotent: re-running is a no-op for an already-offboarded user.
 */
export async function deleteUser(clerkUserId: string) {
  const user = await prisma.user.findUnique({
    where: { id: clerkUserId },
    select: { id: true, deletedAt: true },
  });
  if (!user || user.deletedAt) return;

  await prisma.$transaction([
    // Frees the email (it's unique) so the person can sign up again with it.
    prisma.user.update({
      where: { id: clerkUserId },
      data: { deletedAt: new Date(), email: `${clerkUserId}@deleted.invalid` },
    }),
    // Deleted, as removeMember does: ApiKey has no revoked state to set, and
    // AI connections/sessions pointing at a key are kept (their FK is SET NULL).
    prisma.apiKey.deleteMany({ where: { createdById: clerkUserId } }),
    prisma.aiConnection.updateMany({
      where: { userId: clerkUserId, status: { not: "REVOKED" } },
      data: { status: "REVOKED" },
    }),
    prisma.userDriveConnection.deleteMany({ where: { userId: clerkUserId } }),
    prisma.projectMembership.deleteMany({ where: { userId: clerkUserId } }),
    prisma.teamMembership.deleteMany({ where: { userId: clerkUserId } }),
    prisma.departmentMembership.deleteMany({ where: { userId: clerkUserId } }),
    prisma.workspaceMembership.deleteMany({ where: { userId: clerkUserId } }),
  ]);

  // Workspace Drives they connected live in their Google account.
  await releaseWorkspaceDrivesOf(clerkUserId);
}

/**
 * Get a user by their Clerk ID.
 * Used by the /me endpoint and auth middleware.
 * Throws NOT_FOUND if user doesn't exist in our DB.
 */
export async function getUserById(clerkUserId: string) {
  const user = await prisma.user.findUnique({
    where: { id: clerkUserId },
    select: {
      id: true,
      email: true,
      name: true,
      avatar: true,
      lastActiveAt: true,
      createdAt: true,
    },
  });

  if (!user) {
    throw new AppError(403, ERROR_CODES.USER_NOT_SYNCED, "User not synced. Try again shortly.");
  }

  return user;
}

/**
 * Update user's last active timestamp.
 * Called on each authenticated request (debounced — only updates if > 5 min since last update).
 */
export async function touchLastActive(clerkUserId: string) {
  await prisma.user.update({
    where: { id: clerkUserId },
    data: { lastActiveAt: new Date() },
  });
}
