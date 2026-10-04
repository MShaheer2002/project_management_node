/**
 * Workspace facts AI Assistance gets with every question, so it can answer
 * "why can't I invite anyone?" or "can I connect GitHub?" for THIS workspace
 * instead of in general.
 *
 * Each fact is only included for roles that can already see it in the app:
 * plan for everyone (it shows in upgrade messages), member and storage usage
 * for owners and admins (Billing is theirs), integrations for everyone but
 * guests (the Integrations page is lead-only). Nothing here is a secret, and
 * nothing names other people.
 */
import { prisma } from "../../shared/utils/prisma.js";
import {
  FREE_PLAN_MEMBER_CAP,
  getAccessPlanForWorkspace,
  getEntitlements,
  getWorkspaceStorageUsage,
} from "../billing/billing.service.js";

type Role = "OWNER" | "ADMIN" | "MEMBER" | "GUEST";
type Plan = "FREE" | "STANDARD" | "PREMIUM";

export interface AssistContext {
  role: Role;
  plan: Plan;
  members?: { count: number; pendingInvites: number; cap: number | null };
  storage?: { usedBytes: number; limitBytes: number | null };
  integrations?: string[];
  driveConnected?: boolean;
}

const PLAN_NAMES: Record<Plan, string> = { FREE: "Free", STANDARD: "Standard", PREMIUM: "Premium" };
const PROVIDER_NAMES: Record<string, string> = { GITHUB: "GitHub", SLACK: "Slack", DISCORD: "Discord", FIGMA: "Figma" };

export async function buildAssistContext(workspaceId: string, userId: string, role: Role): Promise<AssistContext> {
  const isAdmin = role === "OWNER" || role === "ADMIN";
  const plan = (await getAccessPlanForWorkspace(workspaceId)) as Plan;

  const [members, pendingInvites, storageUsed, integrations, drive] = await Promise.all([
    isAdmin ? prisma.workspaceMembership.count({ where: { workspaceId } }) : null,
    isAdmin ? prisma.workspaceInvitation.count({ where: { workspaceId, status: "PENDING" } }) : null,
    isAdmin ? getWorkspaceStorageUsage(workspaceId) : null,
    role !== "GUEST"
      ? prisma.integration.findMany({ where: { workspaceId, connected: true }, select: { provider: true }, orderBy: { provider: "asc" } })
      : null,
    role !== "GUEST" ? prisma.userDriveConnection.findUnique({ where: { userId }, select: { id: true } }) : null,
  ]);

  const entitlements = getEntitlements(plan);
  return {
    role,
    plan,
    ...(members !== null && pendingInvites !== null
      ? { members: { count: members, pendingInvites, cap: plan === "FREE" ? FREE_PLAN_MEMBER_CAP : null } }
      : {}),
    ...(storageUsed !== null ? { storage: { usedBytes: storageUsed, limitBytes: entitlements.storageLimitBytes } } : {}),
    ...(integrations !== null ? { integrations: integrations.map((item) => PROVIDER_NAMES[item.provider] ?? item.provider) } : {}),
    ...(role !== "GUEST" ? { driveConnected: Boolean(drive) } : {}),
  };
}

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

/** Plain lines for the system prompt. */
export function describeAssistContext(context: AssistContext): string {
  const lines = [`Workspace plan: ${PLAN_NAMES[context.plan]}`, `User role: ${context.role}`];
  if (context.members) {
    const { count, pendingInvites, cap } = context.members;
    lines.push(
      cap === null
        ? `Members: ${count} (${pendingInvites} pending invites), no member limit`
        : `Members: ${count} plus ${pendingInvites} pending invites, of a ${cap} limit (${Math.max(cap - count - pendingInvites, 0)} left)`,
    );
  }
  if (context.storage) {
    const { usedBytes, limitBytes } = context.storage;
    lines.push(`Storage: ${formatBytes(usedBytes)} used of ${limitBytes === null ? "unlimited" : formatBytes(limitBytes)}`);
  }
  if (context.integrations) {
    lines.push(`Connected integrations: ${context.integrations.length ? context.integrations.join(", ") : "none"}`);
  }
  if (context.driveConnected !== undefined) {
    lines.push(`This user's Google Drive: ${context.driveConnected ? "connected" : "not connected"}`);
  }
  return lines.join("\n");
}
