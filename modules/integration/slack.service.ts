/**
 * Slack Integration — Service Layer
 *
 * Handles the full Slack integration lifecycle:
 *   - OAuth connect/disconnect
 *   - Outbound messages (issue events → Slack channels)
 *   - Outbound DMs (personal notifications → Slack DMs)
 *   - Inbound slash commands (/linearis create, /linearis status, etc.)
 *
 * Security:
 *   - Slash commands verified via HMAC SHA-256 signing secret
 *   - OAuth tokens stored in Integration.config JSON
 *   - All queries workspace-scoped
 */

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { logActivity } from "../../shared/utils/activity.js";
import { env } from "../../config/env.js";
import {
  buildIssueMessage,
  buildCycleMessage,
  parseSlashCommand,
  parseCommandFlags,
  ephemeralResponse,
} from "./slack.utils.js";

// ─── Default Slack Settings ──────────────────────────────────────────────────

const DEFAULT_SLACK_SETTINGS = {
  notifyOnIssueCreatedUrgent: true,
  notifyOnIssueCompleted: true,
  notifyOnIssueAssigned: false,
  notifyOnCycleStarted: true,
  notifyOnCycleCompleted: true,
  dmOnAssignment: true,
  dmOnMention: true,
  dmOnDueDateApproaching: true,
  slashCommandsEnabled: true,
};

// ─── Slack OAuth ─────────────────────────────────────────────────────────────

/**
 * Generate Slack OAuth authorization URL.
 */
export function getSlackAuthUrl(workspaceId: string, userId: string): string {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    throw new AppError(500, ERROR_CODES.SLACK_NOT_CONFIGURED, "Slack integration is not configured on this server");
  }

  const state = Buffer.from(JSON.stringify({ workspaceId, userId })).toString("base64url");

  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    scope: "chat:write,chat:write.public,commands,users:read,users:read.email,im:write,channels:read,groups:read",
    redirect_uri: `${env.BACKEND_URL ?? `http://localhost:${env.PORT}`}/integrations/slack/callback`,
    state,
  });

  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

/**
 * Handle Slack OAuth callback — exchange code for bot token, store integration.
 */
export async function handleSlackCallback(code: string, state: string) {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    throw new AppError(500, ERROR_CODES.SLACK_NOT_CONFIGURED, "Slack integration is not configured");
  }

  let stateData: { workspaceId: string; userId: string };
  try {
    stateData = JSON.parse(Buffer.from(state, "base64url").toString());
  } catch {
    throw new AppError(400, ERROR_CODES.SLACK_OAUTH_FAILED, "Invalid OAuth state parameter");
  }

  const { workspaceId, userId } = stateData;

  // Exchange code for access token
  const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: `${env.BACKEND_URL ?? `http://localhost:${env.PORT}`}/integrations/slack/callback`,
    }),
  });

  const tokenData = (await tokenResponse.json()) as {
    ok: boolean;
    access_token?: string;
    bot_user_id?: string;
    team?: { id: string; name: string };
    incoming_webhook?: { channel: string; channel_id: string; url: string };
    error?: string;
  };

  if (!tokenData.ok || !tokenData.access_token) {
    throw new AppError(
      400,
      ERROR_CODES.SLACK_OAUTH_FAILED,
      tokenData.error || "Failed to exchange Slack authorization code",
    );
  }

  const config = {
    accessToken: tokenData.access_token,
    botUserId: tokenData.bot_user_id,
    team: tokenData.team,
    defaultChannel: tokenData.incoming_webhook?.channel_id ?? null,
    defaultChannelName: tokenData.incoming_webhook?.channel ?? null,
    settings: DEFAULT_SLACK_SETTINGS,
  };

  await prisma.integration.upsert({
    where: { workspaceId_provider: { workspaceId, provider: "SLACK" } },
    create: {
      workspaceId,
      provider: "SLACK",
      connected: true,
      config,
      connectedAt: new Date(),
      connectedById: userId,
    },
    update: {
      connected: true,
      config,
      connectedAt: new Date(),
      connectedById: userId,
    },
  });

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "INTEGRATION_CONNECTED",
    targetType: "INTEGRATION",
    targetId: "SLACK",
    message: `Slack integration connected (${tokenData.team?.name ?? "unknown team"})`,
    metadata: { provider: "slack", teamName: tokenData.team?.name },
  });

  return { workspaceId, provider: "slack", teamName: tokenData.team?.name };
}

// ─── Slack Config Resolver ───────────────────────────────────────────────────

interface SlackConfig {
  accessToken: string;
  botUserId?: string;
  team?: { id: string; name: string };
  defaultChannel: string | null;
  settings: typeof DEFAULT_SLACK_SETTINGS;
  actorId: string;
}

async function getSlackConfig(workspaceId: string): Promise<SlackConfig | null> {
  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: "SLACK" } },
    select: { connected: true, config: true, connectedById: true },
  });

  if (!integration?.connected || !integration.config || !integration.connectedById) return null;

  const config = integration.config as {
    accessToken: string;
    botUserId?: string;
    team?: { id: string; name: string };
    defaultChannel: string | null;
    settings: typeof DEFAULT_SLACK_SETTINGS;
  };

  return { ...config, actorId: integration.connectedById };
}

// ─── Slack Channel Management ────────────────────────────────────────────────

/**
 * List available Slack channels for the workspace.
 * Used by the frontend channel picker after connecting.
 */
export async function listSlackChannels(workspaceId: string) {
  const config = await getSlackConfig(workspaceId);
  if (!config) {
    throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Slack is not connected");
  }

  const channels: Array<{ id: string; name: string; isPrivate: boolean; memberCount: number }> = [];
  let cursor: string | undefined;

  // Paginate through all channels (Slack returns max 200 per page)
  do {
    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });

    const response = await fetch(`https://slack.com/api/conversations.list?${params}`, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });

    const data = (await response.json()) as {
      ok: boolean;
      channels?: Array<{
        id: string;
        name: string;
        is_private: boolean;
        num_members: number;
      }>;
      response_metadata?: { next_cursor?: string };
      error?: string;
    };

    if (!data.ok) {
      console.warn("[Slack] Failed to list channels:", data.error);
      break;
    }

    for (const ch of data.channels ?? []) {
      channels.push({
        id: ch.id,
        name: ch.name,
        isPrivate: ch.is_private,
        memberCount: ch.num_members,
      });
    }

    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return channels;
}

/**
 * Set the default notification channel for the Slack integration.
 */
export async function setDefaultChannel(workspaceId: string, channelId: string, channelName: string) {
  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: "SLACK" } },
    select: { id: true, connected: true, config: true },
  });

  if (!integration?.connected || !integration.config) {
    throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Slack is not connected");
  }

  const currentConfig = integration.config as Record<string, unknown>;

  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      config: {
        ...currentConfig,
        defaultChannel: channelId,
        defaultChannelName: channelName,
      },
    },
  });

  return { channelId, channelName };
}

// ─── Channel Resolution ──────────────────────────────────────────────────────

interface ChannelMapping {
  channelId: string;
  channelName: string;
}

interface ChannelRouting {
  projects: Record<string, ChannelMapping[]>;
  teams: Record<string, ChannelMapping[]>;
  urgent: ChannelMapping | null;
}

/**
 * Resolve which Slack channels to post to for a given issue context.
 *
 * Priority order:
 *   1. Project-specific channels (if issue has a projectId with mapped channels)
 *   2. Team-specific channels (if no project channels, check teamId)
 *   3. Default channel (fallback)
 *   4. Urgent channel (ADDED ON TOP for high/urgent priority — not instead of)
 */
function resolveChannels(
  config: SlackConfig,
  context: { projectId?: string | null | undefined; teamId?: string | null | undefined; priority?: string | null | undefined },
): string[] {
  const routing = (config as any).channelRouting as ChannelRouting | undefined;
  const channels: string[] = [];

  // 1. Project-specific channels
  const projectChannels = context.projectId ? routing?.projects?.[context.projectId] : undefined;
  if (projectChannels?.length) {
    for (const m of projectChannels) {
      if (!channels.includes(m.channelId)) channels.push(m.channelId);
    }
  }

  // 2. Team-specific channels (only if no project channels found)
  const teamChannels = context.teamId ? routing?.teams?.[context.teamId] : undefined;
  if (channels.length === 0 && teamChannels?.length) {
    for (const m of teamChannels) {
      if (!channels.includes(m.channelId)) channels.push(m.channelId);
    }
  }

  // 3. Default channel (only if no project or team channels found)
  if (channels.length === 0 && config.defaultChannel) {
    channels.push(config.defaultChannel);
  }

  // 4. Urgent channel — ADDED ON TOP for high/urgent (not instead of)
  const priorityLower = (context.priority ?? "").toLowerCase();
  if ((priorityLower === "urgent" || priorityLower === "high") && routing?.urgent?.channelId) {
    if (!channels.includes(routing.urgent.channelId)) {
      channels.push(routing.urgent.channelId);
    }
  }

  return channels;
}

// ─── Slack API Helpers ───────────────────────────────────────────────────────

async function slackPost(token: string, channel: string, message: { text: string; blocks?: any[] }) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text: message.text,
      blocks: message.blocks,
      unfurl_links: false,
    }),
  });

  const result = (await response.json()) as { ok: boolean; error?: string };
  if (!result.ok) {
    console.warn(`[Slack] Failed to post message to ${channel}:`, result.error);
  }
  return result;
}

async function slackDm(token: string, userEmail: string, message: { text: string; blocks?: any[] }) {
  // Look up Slack user by email
  const lookupResponse = await fetch(
    `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(userEmail)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  const lookupResult = (await lookupResponse.json()) as {
    ok: boolean;
    user?: { id: string };
    error?: string;
  };

  if (!lookupResult.ok || !lookupResult.user) {
    // User not in Slack workspace — silently skip
    return;
  }

  // Open DM channel
  const openResponse = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ users: lookupResult.user.id }),
  });

  const openResult = (await openResponse.json()) as {
    ok: boolean;
    channel?: { id: string };
  };

  if (!openResult.ok || !openResult.channel) return;

  await slackPost(token, openResult.channel.id, message);
}

// ─── Outbound: Issue Events → Slack Channel ──────────────────────────────────

/**
 * Post to Slack when a high/urgent priority issue is created.
 */
export async function notifyIssueCreated(workspaceId: string, issue: {
  id: string;
  title: string;
  priority: string;
  status: string;
  projectId?: string | null | undefined;
  teamId?: string | null | undefined;
  assigneeName?: string | undefined | null;
  creatorName: string;
  projectName?: string | undefined | null;
}) {
  const config = await getSlackConfig(workspaceId);
  if (!config) return;
  if (!config.settings.notifyOnIssueCreatedUrgent) return;

  const priorityLower = issue.priority.toLowerCase();
  if (priorityLower !== "urgent" && priorityLower !== "high") return;

  const channels = resolveChannels(config, {
    projectId: issue.projectId,
    teamId: issue.teamId,
    priority: issue.priority,
  });
  if (channels.length === 0) return;

  const emoji = priorityLower === "urgent" ? ":red_circle:" : ":large_orange_circle:";
  const message = buildIssueMessage({
    emoji,
    title: `${issue.priority} Issue Created`,
    issueId: issue.id,
    issueTitle: issue.title,
    fields: [
      { label: "Priority", value: issue.priority },
      { label: "Assignee", value: issue.assigneeName ?? "Unassigned" },
      { label: "Project", value: issue.projectName ?? "—" },
      { label: "Created by", value: issue.creatorName },
    ],
    frontendUrl: env.FRONTEND_URL,
  });

  await Promise.all(channels.map((ch) => slackPost(config.accessToken, ch, message)));
}

/**
 * Post to Slack when an issue is completed.
 */
export async function notifyIssueCompleted(workspaceId: string, issue: {
  id: string;
  title: string;
  completedByName: string;
  projectId?: string | null | undefined;
  teamId?: string | null | undefined;
  projectName?: string | undefined | null;
}) {
  const config = await getSlackConfig(workspaceId);
  if (!config) return;
  if (!config.settings.notifyOnIssueCompleted) return;

  const channels = resolveChannels(config, { projectId: issue.projectId, teamId: issue.teamId });
  if (channels.length === 0) return;

  const message = buildIssueMessage({
    emoji: ":white_check_mark:",
    title: "Issue Completed",
    issueId: issue.id,
    issueTitle: issue.title,
    fields: [
      { label: "Completed by", value: issue.completedByName },
      ...(issue.projectName ? [{ label: "Project", value: issue.projectName }] : []),
    ],
    frontendUrl: env.FRONTEND_URL,
  });

  await Promise.all(channels.map((ch) => slackPost(config.accessToken, ch, message)));
}

/**
 * Post to Slack when an issue is assigned.
 */
export async function notifyIssueAssigned(workspaceId: string, issue: {
  id: string;
  title: string;
  assigneeName: string;
  assignedByName: string;
  priority: string;
  projectId?: string | null | undefined;
  teamId?: string | null | undefined;
  projectName?: string | undefined | null;
}) {
  const config = await getSlackConfig(workspaceId);
  if (!config) return;
  if (!config.settings.notifyOnIssueAssigned) return;

  const channels = resolveChannels(config, {
    projectId: issue.projectId,
    teamId: issue.teamId,
    priority: issue.priority,
  });
  if (channels.length === 0) return;

  const message = buildIssueMessage({
    emoji: ":bust_in_silhouette:",
    title: "Issue Assigned",
    issueId: issue.id,
    issueTitle: issue.title,
    fields: [
      { label: "Assigned to", value: issue.assigneeName },
      { label: "Assigned by", value: issue.assignedByName },
      { label: "Priority", value: issue.priority },
    ],
    frontendUrl: env.FRONTEND_URL,
  });

  await Promise.all(channels.map((ch) => slackPost(config.accessToken, ch, message)));
}

/**
 * Post to Slack when a cycle starts or completes.
 */
export async function notifyCycleEvent(workspaceId: string, event: {
  type: "started" | "completed";
  cycleName: string;
  teamId?: string | null | undefined;
  teamName?: string;
  dateRange?: string;
  totalIssues?: number;
  completedIssues?: number;
  carriedOver?: number;
}) {
  const config = await getSlackConfig(workspaceId);
  if (!config) return;

  if (event.type === "started" && !config.settings.notifyOnCycleStarted) return;
  if (event.type === "completed" && !config.settings.notifyOnCycleCompleted) return;

  const channels = resolveChannels(config, { teamId: event.teamId });
  if (channels.length === 0) return;

  const emoji = event.type === "started" ? ":rocket:" : ":checkered_flag:";
  const title = event.type === "started" ? "Cycle Started" : "Cycle Completed";

  const fields: Array<{ label: string; value: string }> = [];
  if (event.teamName) fields.push({ label: "Team", value: event.teamName });
  if (event.dateRange) fields.push({ label: "Period", value: event.dateRange });
  if (event.totalIssues !== undefined) fields.push({ label: "Issues", value: String(event.totalIssues) });
  if (event.completedIssues !== undefined) fields.push({ label: "Completed", value: String(event.completedIssues) });
  if (event.carriedOver !== undefined) fields.push({ label: "Carried over", value: String(event.carriedOver) });
  if (event.totalIssues && event.completedIssues) {
    const velocity = Math.round((event.completedIssues / event.totalIssues) * 100);
    fields.push({ label: "Velocity", value: `${velocity}%` });
  }

  const message = buildCycleMessage({
    emoji,
    title,
    cycleName: event.cycleName,
    fields,
    frontendUrl: env.FRONTEND_URL,
  });

  await Promise.all(channels.map((ch) => slackPost(config.accessToken, ch, message)));
}

// ─── Outbound: Personal DMs ──────────────────────────────────────────────────

/**
 * Send a DM to a user when they are assigned an issue.
 */
export async function dmIssueAssigned(workspaceId: string, assigneeEmail: string, issue: {
  id: string;
  title: string;
  priority: string;
  assignedByName: string;
}) {
  const config = await getSlackConfig(workspaceId);
  if (!config || !config.settings.dmOnAssignment) return;

  const issueUrl = `${env.FRONTEND_URL}/issues/${issue.id}`;
  await slackDm(config.accessToken, assigneeEmail, {
    text: `:pushpin: You were assigned <${issueUrl}|${issue.id}> "${issue.title}" by ${issue.assignedByName} (${issue.priority})`,
  });
}

/**
 * Send a DM to a user when they are mentioned in a comment.
 */
export async function dmMentioned(workspaceId: string, mentionedEmail: string, mention: {
  issueId: string;
  issueTitle: string;
  mentionedByName: string;
  commentExcerpt: string;
}) {
  const config = await getSlackConfig(workspaceId);
  if (!config || !config.settings.dmOnMention) return;

  const issueUrl = `${env.FRONTEND_URL}/issues/${mention.issueId}`;
  await slackDm(config.accessToken, mentionedEmail, {
    text: `:speech_balloon: ${mention.mentionedByName} mentioned you in <${issueUrl}|${mention.issueId}>:\n> ${mention.commentExcerpt}`,
  });
}

/**
 * Send a DM to a user when their issue is due soon.
 */
export async function dmDueDateApproaching(workspaceId: string, assigneeEmail: string, issue: {
  id: string;
  title: string;
  dueDate: string;
  status: string;
}) {
  const config = await getSlackConfig(workspaceId);
  if (!config || !config.settings.dmOnDueDateApproaching) return;

  const issueUrl = `${env.FRONTEND_URL}/issues/${issue.id}`;
  await slackDm(config.accessToken, assigneeEmail, {
    text: `:alarm_clock: <${issueUrl}|${issue.id}> "${issue.title}" is due ${issue.dueDate} — status: ${issue.status}`,
  });
}

// ─── Inbound: Slash Commands ─────────────────────────────────────────────────

/**
 * Handle /linearis slash command.
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

  // Find workspace by Slack team ID stored in config
  const integrations = await prisma.integration.findMany({
    where: { provider: "SLACK", connected: true },
    select: { workspaceId: true, config: true, connectedById: true },
  });

  // Match by team_id from the Slack payload
  const integration = integrations.find((i) => {
    const cfg = i.config as { team?: { id: string } } | null;
    return cfg?.team?.id === body.team_id;
  }) ?? integrations[0]; // Fallback to first if single workspace

  if (!integration) {
    return ephemeralResponse(":x: No Linearis workspace is connected to this Slack workspace.");
  }

  const config = integration.config as { accessToken: string; settings: typeof DEFAULT_SLACK_SETTINGS };
  if (!config.settings.slashCommandsEnabled) {
    return ephemeralResponse(":x: Slash commands are disabled for this workspace.");
  }

  const workspaceId = integration.workspaceId;

  // Resolve the actual Slack user to a Linearis user by email
  let actorId = integration.connectedById!; // Fallback to admin
  try {
    const slackUserResponse = await fetch(
      `https://slack.com/api/users.info?user=${body.user_id}`,
      { headers: { Authorization: `Bearer ${config.accessToken}` } },
    );
    const slackUserData = (await slackUserResponse.json()) as {
      ok: boolean;
      user?: { profile?: { email?: string } };
    };

    if (slackUserData.ok && slackUserData.user?.profile?.email) {
      const linearisUser = await prisma.user.findUnique({
        where: { email: slackUserData.user.profile.email.toLowerCase() },
        select: { id: true },
      });
      if (linearisUser) {
        // Verify user is a member of this workspace
        const membership = await prisma.workspaceMembership.findUnique({
          where: { userId_workspaceId: { userId: linearisUser.id, workspaceId } },
          select: { userId: true },
        });
        if (membership) {
          actorId = linearisUser.id;
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
        `:question: Unknown command \`${subCommand}\`. Type \`/linearis help\` for available commands.`,
      );
  }
}

async function handleCreateCommand(workspaceId: string, actorId: string, args: string) {
  if (!args) {
    return ephemeralResponse(":x: Usage: `/linearis create Fix the bug --priority high`");
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
    `:white_check_mark: Issue created\n<${issueUrl}|${issueId}> ${title}\nPriority: ${priority} · Project: ${project.name}`,
  );
}

async function handleStatusCommand(workspaceId: string, args: string) {
  const issueRef = args.trim().toUpperCase();
  if (!issueRef) {
    return ephemeralResponse(":x: Usage: `/linearis status TES-1`");
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
    `*Status:* ${issue.status} · *Priority:* ${issue.priority}\n` +
    `*Assignee:* ${issue.assignee?.name ?? "Unassigned"} · *Project:* ${issue.project?.name ?? "—"}`,
  );
}

async function handleMyIssuesCommand(workspaceId: string, actorId: string) {
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
    return `${emoji} <${url}|${i.id}> ${i.title} — _${i.status}_`;
  });

  return ephemeralResponse(`*Your Open Issues (${issues.length})*\n\n${lines.join("\n")}`);
}

async function handleCycleCommand(workspaceId: string) {
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

  const startStr = cycle.startDate ? new Date(cycle.startDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
  const endStr = cycle.endDate ? new Date(cycle.endDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";

  return ephemeralResponse(
    `:calendar: *${cycle.name}*\n${startStr} – ${endStr}\n\n` +
    `:chart_with_upwards_trend: Progress: ${progress}% (${completedCount}/${total} issues)\n` +
    `:white_check_mark: Done: ${completedCount} · :arrows_counterclockwise: Remaining: ${total - completedCount}`,
  );
}

function handleHelpCommand() {
  return ephemeralResponse(
    "*Linearis Commands*\n\n" +
    "`/linearis create <title> --priority <low|medium|high|urgent>` — Create an issue\n" +
    "`/linearis status <TES-1>` — Check issue status\n" +
    "`/linearis my-issues` — View your open issues\n" +
    "`/linearis cycle` — View current cycle progress\n" +
    "`/linearis help` — Show this help message",
  );
}
