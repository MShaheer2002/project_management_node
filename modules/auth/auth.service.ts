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
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import type { ClerkUserPayload } from "./auth.schemas.js";

/**
 * Create or update a user from Clerk webhook data.
 * Called on `user.created` event.
 * Uses upsert for idempotency — if webhook fires twice, we don't fail.
 */
export async function createUser(data: ClerkUserPayload) {
  const primaryEmail = data.email_addresses[0]!.email_address;
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
  const primaryEmail = data.email_addresses[0]!.email_address;
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
 * Delete a user from our database.
 * Called on `user.deleted` event.
 * Cascades: removes all workspace memberships, team memberships, etc.
 * No-op if user doesn't exist (idempotent).
 */
export async function deleteUser(clerkUserId: string) {
  // Check if user exists before deleting (no-op if already gone)
  const user = await prisma.user.findUnique({ where: { id: clerkUserId } });
  if (!user) return;

  await prisma.user.delete({ where: { id: clerkUserId } });
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
