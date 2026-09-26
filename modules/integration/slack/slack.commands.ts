/**
 * Slack Integration — Slash Command Handling
 *
 * Processes /trussen slash commands from Slack:
 *   create, status, my-issues, cycle, help
 *
 * Resolves the Slack user to a Trussen user by email lookup.
 */

import { prisma } from "../../../shared/utils/prisma.js";
import { env } from "../../../config/env.js";
import { getSettings } from "../integration.service.js";
import { decryptSecretOrLegacy } from "../../../shared/utils/secret-box.js";
import { visibleIssueWhere, type Viewer } from "../../../shared/utils/visibility.js";
import type { WorkspaceRole } from "../../../app/generated/prisma/client.js";
import {
  parseSlashCommand,
  parseCommandFlags,
  ephemeralResponse,
  findIntegrationForTeam,
  escapeSlackText,
} from "./slack.utils.js";

// ─── Main Handler ───────────────────────────────────────────────────────────

/**
 * Handle /trussen slash command.
 * Returns a Slack response object (ephemeral message).
 */
export async function handleSlashCommand(body: {
  command: string;
  text: string;
  user_id: string;
  user_name: string;
  team_id: string;
  channel_id: string;
  response_url: string;
}) {
  const { command: subCommand, args } = parseSlashCommand(body.text);

  // Find workspace by Slack team ID stored in providerMeta
  const integrations = await prisma.integration.findMany({
    where: { provider: "SLACK", connected: true },
    select: {
      id: true,
      workspaceId: true,
      accessToken: true,
      providerMeta: true,
      connectedById: true,
      workspace: { select: { deactivatedAt: true } },
    },
  });

  // Match by team_id — no fallback to another tenant, see findIntegrationForTeam (F-03).
  const integration = findIntegrationForTeam(integrations, body.team_id);

  if (!integration) {
    return ephemeralResponse(":x: No Trussen workspace is connected to this Slack workspace.");
  }

  if (integration.workspace.deactivatedAt) {
    return ephemeralResponse(":x: This Trussen workspace has been deactivated by its owner.");
  }

  const settings = await getSettings(integration.id);
  if (settings.slashCommandsEnabled === false) {
    return ephemeralResponse(":x: Slash commands are disabled for this workspace.");
  }

  const workspaceId = integration.workspaceId;
  const token = decryptSecretOrLegacy(integration.accessToken!);

  // Resolve the Slack user to a Trussen user by email.
  //
  // There is deliberately NO fallback to the integration's connecting admin.
  // Anyone in the connected Slack team can run /trussen — including
  // single-channel guests — so falling back meant an unmapped Slack user
  // created issues attributed to an admin and read issues with that admin's
  // reach (F-18).
  let viewer: Viewer | null = null;
  try {
    const slackUserResponse = await fetch(
      `https://slack.com/api/users.info?user=${body.user_id}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const slackUserData = (await slackUserResponse.json()) as {
      ok: boolean;
      user?: { profile?: { email?: string } };
    };

    if (slackUserData.ok && slackUserData.user?.profile?.email) {
      const trussenUser = await prisma.user.findUnique({
        where: { email: slackUserData.user.profile.email.toLowerCase() },
        select: { id: true },
      });
      if (trussenUser) {
        // Verify user is a member of this workspace
        const membership = await prisma.workspaceMembership.findUnique({
          where: { userId_workspaceId: { userId: trussenUser.id, workspaceId } },
          select: { role: true },
        });
        if (membership) {
          viewer = { userId: trussenUser.id, role: membership.role as WorkspaceRole };
        }
      }
    }
  } catch {
    // Leave viewer null — an unresolved Slack user gets no access at all.
  }

  if (!viewer) {
    return ephemeralResponse(
      ":x: Your Slack account isn't linked to a Trussen member in this workspace. " +
      "Make sure your Slack email matches your Trussen account.",
    );
  }

  switch (subCommand) {
    case "create":
      return handleCreateCommand(workspaceId, viewer.userId, args);
    case "status":
      return handleStatusCommand(workspaceId, viewer, args);
    case "my-issues":
    case "my":
      return handleMyIssuesCommand(workspaceId, viewer.userId);
    case "cycle":
      return handleCycleCommand(workspaceId, viewer);
    case "help":
    case "":
      return handleHelpCommand();
    default:
      return ephemeralResponse(
        `:question: Unknown command \`${subCommand}\`. Type \`/trussen help\` for available commands.`,
      );
  }
}

// ─── Sub-command Handlers ───────────────────────────────────────────────────

export async function handleCreateCommand(workspaceId: string, actorId: string, args: string) {
  if (!args) {
    return ephemeralResponse(":x: Usage: `/trussen create Fix the bug --priority high`");
  }

  const { text: rawTitle, flags } = parseCommandFlags(args);
  if (!rawTitle) {
    return ephemeralResponse(":x: Please provide an issue title.");
  }

  // Sanitize: trim, limit length, strip control characters
  const title = rawTitle.replace(/[\x00-\x1f]/g, "").trim().slice(0, 500);
  if (!title) {
    return ephemeralResponse(":x: Please provide a valid issue title.");
  }

  // Find a default project to create the issue in
  const project = await prisma.project.findFirst({
    where: { workspaceId, status: "ACTIVE" },
    select: { id: true, name: true, teamId: true, departmentId: true },
    orderBy: { updatedAt: "desc" },
  });

  if (!project) {
    return ephemeralResponse(":x: No active project found in this workspace. Create a project first.");
  }

  const priorityMap: Record<string, string> = {
    urgent: "URGENT",
    high: "HIGH",
    medium: "MEDIUM",
    low: "LOW",
  };
  const priority = priorityMap[flags.priority?.toLowerCase() ?? ""] ?? "MEDIUM";

  // Get workspace prefix for issue ID
  const workspace = await prisma.workspace.update({
    where: { id: workspaceId },
    data: { issueCounter: { increment: 1 } },
    select: { issueCounter: true, issuePrefix: true },
  });

  const issueId = `${workspace.issuePrefix}-${workspace.issueCounter}`;

  await prisma.issue.create({
    data: {
      id: issueId,
      number: workspace.issueCounter,
      workspaceId,
      projectId: project.id,
      teamId: project.teamId,
      departmentId: project.departmentId,
      title,
      type: "TASK",
      status: "BACKLOG",
      priority: priority as any,
      creatorId: actorId,
    },
  });

  const issueUrl = `${env.FRONTEND_URL}/issues/${issueId}`;
  return ephemeralResponse(
    `:white_check_mark: Issue created\n<${issueUrl}|${issueId}> ${title}\nPriority: ${priority} \u00b7 Project: ${project.name}`,
  );
}

export async function handleStatusCommand(workspaceId: string, viewer: Viewer, args: string) {
  const issueRef = args.trim().toUpperCase();
  if (!issueRef) {
    return ephemeralResponse(":x: Usage: `/trussen status TES-1`");
  }

  // Scoped to the resolved member: issue keys are sequential, so an unscoped
  // lookup let anyone in the Slack team read private-project issues by
  // guessing keys (F-18). "Not found" covers both cases — no existence oracle.
  const issue = await prisma.issue.findFirst({
    where: { id: issueRef, workspaceId, ...visibleIssueWhere(viewer) },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      assignee: { select: { name: true } },
      project: { select: { name: true } },
      updatedAt: true,
    },
  });

  if (!issue) {
    return ephemeralResponse(`:x: Issue \`${issueRef}\` not found.`);
  }

  const issueUrl = `${env.FRONTEND_URL}/issues/${issue.id}`;
  const statusEmoji: Record<string, string> = {
    BACKLOG: ":clipboard:",
    TODO: ":memo:",
    IN_PROGRESS: ":arrows_counterclockwise:",
    REVIEW: ":eyes:",
    DONE: ":white_check_mark:",
  };

  return ephemeralResponse(
    `${statusEmoji[issue.status] ?? ":grey_question:"} <${issueUrl}|${issue.id}> ${escapeSlackText(issue.title)}\n` +
    `*Status:* ${issue.status} \u00b7 *Priority:* ${issue.priority}\n` +
    `*Assignee:* ${escapeSlackText(issue.assignee?.name ?? "Unassigned")} \u00b7 *Project:* ${escapeSlackText(issue.project?.name ?? "\u2014")}`,
  );
}

export async function handleMyIssuesCommand(workspaceId: string, actorId: string) {
  const issues = await prisma.issue.findMany({
    where: {
      workspaceId,
      assigneeId: actorId,
      status: { not: "DONE" },
    },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
    },
    orderBy: [{ priority: "desc" }, { updatedAt: "desc" }],
    take: 10,
  });

  if (issues.length === 0) {
    return ephemeralResponse(":tada: You have no open issues assigned to you!");
  }

  const priorityEmoji: Record<string, string> = {
    URGENT: ":red_circle:",
    HIGH: ":large_orange_circle:",
    MEDIUM: ":large_blue_circle:",
    LOW: ":white_circle:",
  };

  const lines = issues.map((i) => {
    const emoji = priorityEmoji[i.priority] ?? ":grey_question:";
    const url = `${env.FRONTEND_URL}/issues/${i.id}`;
    return `${emoji} <${url}|${i.id}> ${escapeSlackText(i.title)} \u2014 _${i.status}_`;
  });

  return ephemeralResponse(`*Your Open Issues (${issues.length})*\n\n${lines.join("\n")}`);
}

export async function handleCycleCommand(workspaceId: string, viewer: Viewer) {
  const cycle = await prisma.cycle.findFirst({
    where: { workspaceId, status: "CURRENT" },
    select: {
      id: true,
      name: true,
      startsAt: true,
      endsAt: true,
    },
  });

  if (!cycle) {
    return ephemeralResponse(":calendar: No active cycle found.");
  }

  // Counts scoped the same way — a cycle spans projects the caller may not see.
  const visible = visibleIssueWhere(viewer);
  const [completedCount, total] = await Promise.all([
    prisma.issue.count({ where: { cycleId: cycle.id, status: "DONE", ...visible } }),
    prisma.issue.count({ where: { cycleId: cycle.id, ...visible } }),
  ]);
  const progress = total > 0 ? Math.round((completedCount / total) * 100) : 0;

  const startStr = cycle.startsAt
    ? new Date(cycle.startsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "\u2014";
  const endStr = cycle.endsAt
    ? new Date(cycle.endsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "\u2014";

  return ephemeralResponse(
    `:calendar: *${escapeSlackText(cycle.name)}*\n${startStr} \u2013 ${endStr}\n\n` +
    `:chart_with_upwards_trend: Progress: ${progress}% (${completedCount}/${total} issues)\n` +
    `:white_check_mark: Done: ${completedCount} \u00b7 :arrows_counterclockwise: Remaining: ${total - completedCount}`,
  );
}

export function handleHelpCommand() {
  return ephemeralResponse(
    "*Trussen Commands*\n\n" +
    "`/trussen create <title> --priority <low|medium|high|urgent>` \u2014 Create an issue\n" +
    "`/trussen status <TES-1>` \u2014 Check issue status\n" +
    "`/trussen my-issues` \u2014 View your open issues\n" +
    "`/trussen cycle` \u2014 View current cycle progress\n" +
    "`/trussen help` \u2014 Show this help message",
  );
}
