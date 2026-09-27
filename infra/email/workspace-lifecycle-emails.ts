/**
 * Emails for the workspace soft-delete lifecycle
 * (modules/workspace/workspace-lifecycle.service.ts):
 *
 *   deactivated (owner) → 15 / 5 / 1 days left (owner) → deleted (owner)
 *   deactivated notice (every other member, once) · restored (owner)
 *
 * Workspace names are admin-controlled, so every value is escaped here
 * before it reaches the layout (F-22).
 */
import { env } from "../../config/env.js";
import { workspaceAppUrl } from "../../shared/utils/workspace-url.js";
import { escapeHtml, renderEmailLayout, sanitizeSubjectValue, sendEmail } from "./index.js";

const AMBER = "#d97706";
const RED = "#dc2626";
const GREEN = "#16a34a";
const GRAY = "#6b7280";

type WorkspaceRef = { name: string; slug: string };

/** Sign-in page on the workspace's own subdomain, where the owner can restore it. */
export function workspaceSignInUrl(slug: string) {
  return workspaceAppUrl(slug, "/login");
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function countdown(daysLeft: number, purgeAt: Date, accent: string) {
  const unit = daysLeft === 1 ? "day" : "days";
  return `
    <div style="margin: 24px 0 0; padding: 18px 20px; border-radius: 12px; background: #f8f9fc; border: 1px solid #eceef5; text-align: center;">
      <div style="font-size: 32px; font-weight: 700; line-height: 1.1; color: ${accent};">${daysLeft} ${unit}</div>
      <div style="margin-top: 6px; font-size: 13px; color: #8a8fa3;">until permanent deletion on ${formatDate(purgeAt)}</div>
    </div>`;
}

function strong(value: string) {
  return `<strong style="color: #14161f;">${value}</strong>`;
}

export async function sendWorkspaceDeactivatedEmail(to: string, workspace: WorkspaceRef, purgeAt: Date, daysLeft: number) {
  const name = strong(escapeHtml(workspace.name));
  await sendEmail({
    to,
    subject: sanitizeSubjectValue(`${workspace.name} has been deactivated`),
    html: renderEmailLayout({
      accent: AMBER,
      eyebrow: "Workspace deactivated",
      heading: `${escapeHtml(workspace.name)} is scheduled for deletion`,
      bodyHtml: `
        You deactivated ${name}. Members can no longer sign in; they'll see that the workspace was
        deactivated by its owner, and its subscription won't renew.
        <br /><br />
        Nothing has been deleted yet. If you don't restore it, the workspace and everything in it
        (issues, projects, documents and files) will be permanently deleted.
        ${countdown(daysLeft, purgeAt, AMBER)}`,
      cta: { label: "Restore workspace", url: workspaceSignInUrl(workspace.slug) },
      footnote: "Changed your mind? Sign in and click Restore. Everything comes back exactly as it was.",
      disclaimer: "If you didn't do this, sign in and restore the workspace, then contact support.",
    }),
  });
}

export async function sendWorkspaceDeletionReminderEmail(to: string, workspace: WorkspaceRef, purgeAt: Date, daysLeft: number) {
  const accent = daysLeft <= 5 ? RED : AMBER;
  const when = daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;
  await sendEmail({
    to,
    subject: sanitizeSubjectValue(`${workspace.name} will be permanently deleted ${when}`),
    html: renderEmailLayout({
      accent,
      eyebrow: daysLeft === 1 ? "Final reminder" : `${daysLeft} days left`,
      heading: `${escapeHtml(workspace.name)} will be permanently deleted ${when}`,
      bodyHtml: `
        ${strong(escapeHtml(workspace.name))} is still deactivated. Once it's deleted, its issues,
        projects, documents and files are gone for good and can't be recovered.
        ${countdown(daysLeft, purgeAt, accent)}`,
      cta: { label: "Restore workspace", url: workspaceSignInUrl(workspace.slug) },
      footnote: "Want it back? Sign in and click Restore before the date above.",
    }),
  });
}

export async function sendWorkspaceDeletedEmail(to: string, workspace: WorkspaceRef, deletedAt: Date) {
  await sendEmail({
    to,
    subject: sanitizeSubjectValue(`${workspace.name} has been permanently deleted`),
    html: renderEmailLayout({
      accent: GRAY,
      eyebrow: "Workspace deleted",
      heading: `${escapeHtml(workspace.name)} has been permanently deleted`,
      bodyHtml: `
        As scheduled, ${strong(escapeHtml(workspace.name))} and all of its data were permanently
        deleted on ${formatDate(deletedAt)}. This can't be undone.
        <br /><br />
        Its subscription has been cancelled, so you won't be charged again. Your Trussen account
        isn't affected, and you can create a new workspace at any time.`,
      cta: { label: "Go to Trussen", url: env.FRONTEND_URL },
    }),
  });
}

export async function sendWorkspaceRestoredEmail(to: string, workspace: WorkspaceRef) {
  await sendEmail({
    to,
    subject: sanitizeSubjectValue(`${workspace.name} has been restored`),
    html: renderEmailLayout({
      accent: GREEN,
      eyebrow: "Workspace restored",
      heading: `${escapeHtml(workspace.name)} is back`,
      bodyHtml: `
        Deletion is cancelled. ${strong(escapeHtml(workspace.name))} is active again with all of its
        data, and members can sign in as before.`,
      cta: { label: "Open workspace", url: workspaceSignInUrl(workspace.slug) },
    }),
  });
}

/** Sent once to every non-owner member when the workspace is deactivated. */
export async function sendWorkspaceDeactivatedMemberEmail(to: string, workspace: WorkspaceRef) {
  await sendEmail({
    to,
    subject: sanitizeSubjectValue(`${workspace.name} was deactivated by its owner`),
    html: renderEmailLayout({
      accent: AMBER,
      eyebrow: "Workspace deactivated",
      heading: `${escapeHtml(workspace.name)} was deactivated by its owner`,
      bodyHtml: `
        You can no longer access ${strong(escapeHtml(workspace.name))}. If this looks like a mistake,
        contact the workspace owner, who can still restore it for a limited time.`,
    }),
  });
}
