/**
 * Slack Integration — Service Layer
 *
 * OAuth flow, channel management, and channel resolution.
 * Uses the new normalized schema: Integration (accessToken, providerMeta),
 * IntegrationSetting (key/value rows), IntegrationChannel (scoped rows).
 */

import { prisma } from "../../../shared/utils/prisma.js";
import { AppError } from "../../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../../shared/errors/error-codes.js";
import { logActivity } from "../../../shared/utils/activity.js";
import { env } from "../../../config/env.js";
import {
  findConnectedIntegration,
  getSettings,
  upsertSettings,
  initDefaultSettings,
} from "../integration.service.js";

// ─── Default Slack Settings ──────────────────────────────────────────────────

const DEFAULT_SLACK_SETTINGS: Record<string, boolean> = {
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

  // Store integration with new normalized schema
  const integration = await prisma.integration.upsert({
    where: { workspaceId_provider: { workspaceId, provider: "SLACK" } },
    create: {
      workspaceId,
      provider: "SLACK",
      connected: true,
      accessToken: tokenData.access_token,
      providerMeta: {
        botUserId: tokenData.bot_user_id,
        team: tokenData.team,
      },
      connectedAt: new Date(),
      connectedById: userId,
    },
    update: {
      connected: true,
      accessToken: tokenData.access_token,
      providerMeta: {
        botUserId: tokenData.bot_user_id,
        team: tokenData.team,
      },
      connectedAt: new Date(),
      connectedById: userId,
    },
  });

  // Initialize default settings as IntegrationSetting rows
  await initDefaultSettings(integration.id, DEFAULT_SLACK_SETTINGS);

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

// ─── Slack Channel Management ────────────────────────────────────────────────

/**
 * List available Slack channels from the Slack API (for channel picker).
 */
export async function listSlackChannels(workspaceId: string) {
  const integration = await findConnectedIntegration(workspaceId, "SLACK");
  if (!integration?.accessToken) {
    throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Slack is not connected");
  }

  const channels: Array<{ id: string; name: string; isPrivate: boolean; memberCount: number }> = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });

    const response = await fetch(`https://slack.com/api/conversations.list?${params}`, {
      headers: { Authorization: `Bearer ${integration.accessToken}` },
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
 * Add a channel mapping (IntegrationChannel row).
 */
export async function addChannel(
  workspaceId: string,
  input: { channelId: string; channelName: string; scope: string; scopeId?: string },
) {
  const integration = await findConnectedIntegration(workspaceId, "SLACK");
  if (!integration) {
    throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Slack is not connected");
  }

  const channel = await prisma.integrationChannel.create({
    data: {
      integrationId: integration.id,
      channelId: input.channelId,
      channelName: input.channelName,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
    },
  });

  return channel;
}

/**
 * Remove a channel mapping (IntegrationChannel row).
 */
export async function removeChannel(workspaceId: string, channelDbId: string) {
  const integration = await findConnectedIntegration(workspaceId, "SLACK");
  if (!integration) {
    throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, "Slack is not connected");
  }

  await prisma.integrationChannel.deleteMany({
    where: {
      id: channelDbId,
      integrationId: integration.id,
    },
  });
}

/**
 * Get all IntegrationChannel rows for an integration.
 */
export async function getChannels(integrationId: string) {
  return prisma.integrationChannel.findMany({
    where: { integrationId },
    orderBy: { id: "asc" },
  });
}

/**
 * Resolve which Slack channel IDs to post to for a given context.
 *
 * Priority order:
 *   1. Project-specific channels (if context has projectId)
 *   2. Team-specific channels (if no project channels, check teamId)
 *   3. Default channel (fallback)
 *   4. Urgent channel (ADDED ON TOP for high/urgent priority)
 */
export async function resolveChannels(
  integrationId: string,
  context: { projectId?: string | null; teamId?: string | null; priority?: string | null },
): Promise<string[]> {
  const allChannels = await prisma.integrationChannel.findMany({
    where: { integrationId },
  });

  const channelIds: string[] = [];

  // 1. Project-specific channels
  if (context.projectId) {
    const projectChannels = allChannels.filter(
      (c) => c.scope === "project" && c.scopeId === context.projectId,
    );
    for (const c of projectChannels) {
      if (!channelIds.includes(c.channelId)) channelIds.push(c.channelId);
    }
  }

  // 2. Team-specific channels (only if no project channels found)
  if (channelIds.length === 0 && context.teamId) {
    const teamChannels = allChannels.filter(
      (c) => c.scope === "team" && c.scopeId === context.teamId,
    );
    for (const c of teamChannels) {
      if (!channelIds.includes(c.channelId)) channelIds.push(c.channelId);
    }
  }

  // 3. Default channel (only if no project or team channels found)
  if (channelIds.length === 0) {
    const defaultChannels = allChannels.filter((c) => c.scope === "default");
    for (const c of defaultChannels) {
      if (!channelIds.includes(c.channelId)) channelIds.push(c.channelId);
    }
  }

  // 4. Urgent channel — ADDED ON TOP for high/urgent priority
  const priorityLower = (context.priority ?? "").toLowerCase();
  if (priorityLower === "urgent" || priorityLower === "high") {
    const urgentChannels = allChannels.filter((c) => c.scope === "urgent");
    for (const c of urgentChannels) {
      if (!channelIds.includes(c.channelId)) channelIds.push(c.channelId);
    }
  }

  return channelIds;
}
