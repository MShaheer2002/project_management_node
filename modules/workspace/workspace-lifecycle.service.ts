/**
 * Workspace soft delete.
 *
 * An OWNER "deleting" a workspace deactivates it: nobody can use it (the
 * OWNER only sees a restore screen, see require-workspace.ts), its
 * subscription stops renewing, and it can be restored for 30 days. The hourly
 * lifecycle job then sends the countdown emails and, at purgeAt, deletes it
 * together with everything it owns outside the database — Stripe, GitHub,
 * Slack, S3 — so nothing keeps running or billing afterwards (F-35).
 *
 * Every state change is a conditional updateMany on the workspace row, so two
 * overlapping requests or job runs can never both win: a double deactivate,
 * a restore racing the purge, or two replicas sending the same reminder.
 */
import { env } from "../../config/env.js";
import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { deleteObjectsWithPrefix } from "../../infra/storage/s3.js";
import {
  sendWorkspaceDeactivatedEmail,
  sendWorkspaceDeactivatedMemberEmail,
  sendWorkspaceDeletedEmail,
  sendWorkspaceDeletionReminderEmail,
  sendWorkspaceRestoredEmail,
} from "../../infra/email/workspace-lifecycle-emails.js";
import { endBillingForPurge, resumeRenewalAfterRestore, stopRenewalForDeactivation } from "../billing/billing.service.js";
import { disconnectProvider } from "../integration/integration.service.js";
import { disconnectWorkspaceDrive } from "../drive/drive.service.js";
import { getSocketServer } from "../../socket/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEACTIVATION_GRACE_DAYS = 30;
/** Countdown emails, by days left. Only the most urgent one due is sent, so a
 *  job outage never produces a burst of stale reminders. */
export const DELETION_REMINDER_DAYS_LEFT = [15, 5, 1] as const;
/** A purge lock older than this belongs to a crashed run and may be retaken. */
const PURGE_LOCK_STALE_MS = 60 * 60 * 1000;
/** Resend's default limit is 2 requests/second. */
const EMAIL_PACING_MS = 600;

type Recipient = { email: string };

export function daysUntil(purgeAt: Date, now: Date) {
  return Math.max(0, Math.ceil((purgeAt.getTime() - now.getTime()) / DAY_MS));
}

/** The reminder due now, or null. `lastSent` is the days-left value of the last one sent. */
export function dueReminder(purgeAt: Date, now: Date, lastSent: number | null) {
  const msLeft = purgeAt.getTime() - now.getTime();
  if (msLeft <= 0) return null;
  const due = [...DELETION_REMINDER_DAYS_LEFT].reverse().find((days) => msLeft <= days * DAY_MS) ?? null;
  return due !== null && (lastSent === null || due < lastSent) ? due : null;
}

async function workspaceUsers(workspaceId: string, owners: boolean): Promise<Recipient[]> {
  const memberships = await prisma.workspaceMembership.findMany({
    where: { workspaceId, role: owners ? "OWNER" : { not: "OWNER" }, user: { deletedAt: null } },
    select: { user: { select: { email: true } } },
  });
  return memberships.map((membership) => membership.user);
}

async function sendPaced(recipients: Recipient[], send: (to: string) => Promise<void>, label: string) {
  let failed = 0;
  for (const [index, recipient] of recipients.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, EMAIL_PACING_MS));
    try {
      await send(recipient.email);
    } catch (error) {
      failed += 1;
      console.error(`[Workspace lifecycle] ${label} email failed`, error);
    }
  }
  return failed;
}

// ─── Deactivate / restore ─────────────────────────────────────────────────────

export async function deactivateWorkspace(
  workspaceId: string,
  actorUserId: string,
  confirmName: string,
  now = new Date(),
) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, slug: true, deactivatedAt: true },
  });
  if (!workspace) throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  if (workspace.deactivatedAt) {
    throw new AppError(409, ERROR_CODES.WORKSPACE_DEACTIVATED, "This workspace is already deactivated");
  }
  if (confirmName.trim() !== workspace.name.trim()) {
    throw new AppError(422, ERROR_CODES.WORKSPACE_NAME_MISMATCH, "Type the workspace name exactly to confirm");
  }

  const purgeAt = new Date(now.getTime() + DEACTIVATION_GRACE_DAYS * DAY_MS);
  const claimed = await prisma.workspace.updateMany({
    where: { id: workspaceId, deactivatedAt: null },
    data: {
      deactivatedAt: now,
      deactivatedById: actorUserId,
      purgeAt,
      purgeStartedAt: null,
      lastDeletionReminderDaysLeft: null,
      resumeBillingOnRestore: false,
    },
  });
  if (claimed.count === 0) {
    throw new AppError(409, ERROR_CODES.WORKSPACE_DEACTIVATED, "This workspace is already deactivated");
  }

  // Billing after the row is claimed, and undone if Stripe fails: a workspace
  // must never be left deactivated while its subscription still renews.
  try {
    const resumeBillingOnRestore = await stopRenewalForDeactivation(workspaceId);
    if (resumeBillingOnRestore) {
      await prisma.workspace.update({ where: { id: workspaceId }, data: { resumeBillingOnRestore } });
    }
  } catch (error) {
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { deactivatedAt: null, deactivatedById: null, purgeAt: null },
    });
    throw error;
  }

  // Live sessions get the news now rather than at their next request.
  const io = getSocketServer();
  if (io) {
    io.to(`workspace:${workspaceId}`).emit("workspace:deactivated", { workspaceId });
    io.in(`workspace:${workspaceId}`).disconnectSockets(true);
  }

  const ref = { name: workspace.name, slug: workspace.slug };
  const owners = await workspaceUsers(workspaceId, true);
  await sendPaced(owners, (to) => sendWorkspaceDeactivatedEmail(to, ref, purgeAt, DEACTIVATION_GRACE_DAYS), "deactivated");
  await enqueueMemberNotices(workspaceId);

  return { deactivatedAt: now, purgeAt };
}

export async function restoreWorkspace(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, slug: true, deactivatedAt: true, purgeStartedAt: true, resumeBillingOnRestore: true },
  });
  if (!workspace) throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  if (!workspace.deactivatedAt) {
    throw new AppError(409, ERROR_CODES.WORKSPACE_NOT_DEACTIVATED, "This workspace is already active");
  }

  // purgeStartedAt: null is the lock — once the purge has begun, restoring
  // would bring back a workspace with half its data and files gone.
  const restored = await prisma.workspace.updateMany({
    where: { id: workspaceId, deactivatedAt: { not: null }, purgeStartedAt: null },
    data: {
      deactivatedAt: null,
      deactivatedById: null,
      purgeAt: null,
      lastDeletionReminderDaysLeft: null,
      resumeBillingOnRestore: false,
    },
  });
  if (restored.count === 0) {
    throw new AppError(409, ERROR_CODES.WORKSPACE_DELETION_IN_PROGRESS, "This workspace is already being deleted and can no longer be restored");
  }

  // The workspace is back either way; a Stripe hiccup must not undo that.
  // The owner can switch renewal back on from billing settings.
  if (workspace.resumeBillingOnRestore) {
    try {
      await resumeRenewalAfterRestore(workspaceId);
    } catch (error) {
      console.error(`[Workspace lifecycle] could not resume billing for restored workspace ${workspaceId}`, error);
    }
  }

  const ref = { name: workspace.name, slug: workspace.slug };
  await sendPaced(await workspaceUsers(workspaceId, true), (to) => sendWorkspaceRestoredEmail(to, ref), "restored");
}

// ─── Member notices (queued) ──────────────────────────────────────────────────

let memberNoticeQueue: ((workspaceId: string) => Promise<void>) | null = null;

/** Set by the lifecycle worker; without Redis the notices go out in-process. */
export function setMemberNoticeQueue(enqueue: typeof memberNoticeQueue) {
  memberNoticeQueue = enqueue;
}

async function enqueueMemberNotices(workspaceId: string) {
  if (memberNoticeQueue) {
    await memberNoticeQueue(workspaceId).catch((error) => {
      console.error(`[Workspace lifecycle] could not queue member notices for ${workspaceId}`, error);
    });
    return;
  }
  // ponytail: in-process fallback dies with the process; fine for a courtesy notice.
  void sendMemberNotices(workspaceId).catch((error) => console.error("[Workspace lifecycle] member notices failed", error));
}

export async function sendMemberNotices(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { name: true, slug: true, deactivatedAt: true },
  });
  // Restored before the job ran — nothing to tell anyone.
  if (!workspace?.deactivatedAt) return;

  const ref = { name: workspace.name, slug: workspace.slug };
  await sendPaced(await workspaceUsers(workspaceId, false), (to) => sendWorkspaceDeactivatedMemberEmail(to, ref), "member notice");
}

// ─── Hourly job ───────────────────────────────────────────────────────────────

export async function sendDueReminders(now = new Date()) {
  const candidates = await prisma.workspace.findMany({
    where: {
      deactivatedAt: { not: null },
      purgeStartedAt: null,
      purgeAt: { gt: now, lte: new Date(now.getTime() + DELETION_REMINDER_DAYS_LEFT[0] * DAY_MS) },
    },
    select: { id: true, name: true, slug: true, purgeAt: true, lastDeletionReminderDaysLeft: true },
  });

  let sent = 0;
  for (const workspace of candidates) {
    const due = dueReminder(workspace.purgeAt!, now, workspace.lastDeletionReminderDaysLeft);
    if (due === null) continue;

    // Claim first, so only one run sends this reminder.
    const claimed = await prisma.workspace.updateMany({
      where: { id: workspace.id, deactivatedAt: { not: null }, lastDeletionReminderDaysLeft: workspace.lastDeletionReminderDaysLeft },
      data: { lastDeletionReminderDaysLeft: due },
    });
    if (claimed.count === 0) continue;

    const ref = { name: workspace.name, slug: workspace.slug };
    const owners = await workspaceUsers(workspace.id, true);
    const failed = await sendPaced(owners, (to) => sendWorkspaceDeletionReminderEmail(to, ref, workspace.purgeAt!, due), `${due}-day reminder`);

    // Nothing went out at all — release the claim so the next run tries again.
    if (owners.length > 0 && failed === owners.length) {
      await prisma.workspace.updateMany({
        where: { id: workspace.id, lastDeletionReminderDaysLeft: due },
        data: { lastDeletionReminderDaysLeft: workspace.lastDeletionReminderDaysLeft },
      });
      continue;
    }
    sent += 1;
  }
  return sent;
}

export async function purgeDueWorkspaces(now = new Date()) {
  const due = await prisma.workspace.findMany({
    where: { deactivatedAt: { not: null }, purgeAt: { lte: now } },
    select: { id: true },
  });

  const purged: string[] = [];
  for (const { id } of due) {
    // One failing workspace must not hold up the rest; it is retried next run.
    try {
      if (await purgeWorkspace(id, now)) purged.push(id);
    } catch (error) {
      console.error(`[Workspace lifecycle] purge of ${id} failed; will retry`, error);
    }
  }
  return purged;
}

/**
 * Permanently delete one due workspace. Each step is idempotent, so a run that
 * dies halfway is simply repeated by a later one once its lock goes stale.
 * Returns false when another run holds the lock or the workspace was restored.
 */
export async function purgeWorkspace(workspaceId: string, now = new Date()) {
  const locked = await prisma.workspace.updateMany({
    where: {
      id: workspaceId,
      deactivatedAt: { not: null },
      purgeAt: { lte: now },
      OR: [{ purgeStartedAt: null }, { purgeStartedAt: { lt: new Date(now.getTime() - PURGE_LOCK_STALE_MS) } }],
    },
    data: { purgeStartedAt: now },
  });
  if (locked.count === 0) return false;

  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { name: true, slug: true, deactivatedById: true, createdById: true },
  });
  // Read before the rows that hold them are gone.
  const owners = await workspaceUsers(workspaceId, true);

  await endBillingForPurge(workspaceId);

  // The Workspace Drive row cascades with the workspace; withdraw its Google access first.
  const workspaceDrive = await prisma.workspaceDriveConnection.findUnique({ where: { workspaceId }, select: { id: true } });
  if (workspaceDrive) await disconnectWorkspaceDrive(workspaceId);

  const integrations = await prisma.integration.findMany({
    where: { workspaceId, connected: true, provider: { in: ["GITHUB", "SLACK"] } },
    select: { provider: true },
  });
  for (const { provider } of integrations) {
    // Removes the repo webhooks / uninstalls the Slack app, then clears the token.
    await disconnectProvider(workspaceId, provider.toLowerCase(), workspace.deactivatedById ?? workspace.createdById);
  }

  const uploadPrefix = env.AWS_S3_UPLOAD_PREFIX.replace(/\/$/, "");
  const deletedFiles = await deleteObjectsWithPrefix(`${uploadPrefix}/workspaces/${workspaceId}/`);

  // Every workspace-owned row cascades from here, including API keys, AI
  // connections and the Figma/Discord credentials on Integration rows.
  await prisma.workspace.delete({ where: { id: workspaceId } });
  console.log(`[Workspace lifecycle] purged workspace ${workspaceId} (${deletedFiles} file(s))`);

  const ref = { name: workspace.name, slug: workspace.slug };
  await sendPaced(owners, (to) => sendWorkspaceDeletedEmail(to, ref, now), "deleted");
  return true;
}

export async function runWorkspaceLifecycle(now = new Date()) {
  const reminders = await sendDueReminders(now);
  const purged = await purgeDueWorkspaces(now);
  return { reminders, purged: purged.length };
}
