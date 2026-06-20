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
import { findConnectedIntegration, getSettings } from "../integration.service.js";
import { parseSlashCommand, parseCommandFlags, ephemeralResponse } from "./slack.utils.js";

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
    select: { id: true, workspaceId: true, accessToken: true, providerMeta: true, connectedById: true },
  });

  // Match by team_id from the Slack payload
  const integration = integrations.find((i) => {
    const meta = i.providerMeta as { team?: { id: string } } | null;
    return meta?.team?.id === body.team_id;
  }) ?? integrations[0]; // Fallback to first if single workspace

  if (!integration) {
    return ephemeralResponse(":x: No Trussen workspace is connected to this Slack workspace.");
  }

  const settings = await getSettings(integration.id);
  if (settings.slashCommandsEnabled === false) {
    return ephemeralResponse(":x: Slash commands are disabled for this workspace.");
  }

  const workspaceId = integration.workspaceId;
  const token = integration.accessToken!;

  // Resolve the Slack user to a Trussen user by email
  let actorId = integration.connectedById!; // Fallback to admin
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
          select: { userId: true },
        });
        if (membership) {
          actorId = trussenUser.id;
        }
      }
    }
  } catch {
    // Fallback to admin — non-critical
  }

  switch (subCommand) {
    case "create":
      return handleCreateCommand(workspaceId, actorId, args);
    case "status":
      return handleStatusCommand(workspaceId, args);
    case "my-issues":
    case "my":
      return handleMyIssuesCommand(workspaceId, actorId);
    case "cycle":
      return handleCycleCommand(workspaceId);
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

export async function handleStatusCommand(workspaceId: string, args: string) {
  const issueRef = args.trim().toUpperCase();
  if (!issueRef) {
    return ephemeralResponse(":x: Usage: `/trussen status TES-1`");
  }

  const issue = await prisma.issue.findFirst({
    where: { id: issueRef, workspaceId },
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
    `${statusEmoji[issue.status] ?? ":grey_question:"} <${issueUrl}|${issue.id}> ${issue.title}\n` +
    `*Status:* ${issue.status} \u00b7 *Priority:* ${issue.priority}\n` +
    `*Assignee:* ${issue.assignee?.name ?? "Unassigned"} \u00b7 *Project:* ${issue.project?.name ?? "\u2014"}`,
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
    return `${emoji} <${url}|${i.id}> ${i.title} \u2014 _${i.status}_`;
  });

  return ephemeralResponse(`*Your Open Issues (${issues.length})*\n\n${lines.join("\n")}`);
}

export async function handleCycleCommand(workspaceId: string) {
  const cycle = await prisma.cycle.findFirst({
    where: { workspaceId, status: "CURRENT" },
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      _count: { select: { issues: true } },
    },
  });

  if (!cycle) {
    return ephemeralResponse(":calendar: No active cycle found.");
  }

  const completedCount = await prisma.issue.count({
    where: { cycleId: cycle.id, status: "DONE" },
  });

  const total = cycle._count.issues;
  const progress = total > 0 ? Math.round((completedCount / total) * 100) : 0;

  const startStr = cycle.startDate
    ? new Date(cycle.startDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "\u2014";
  const endStr = cycle.endDate
    ? new Date(cycle.endDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "\u2014";

  return ephemeralResponse(
    `:calendar: *${cycle.name}*\n${startStr} \u2013 ${endStr}\n\n` +
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
