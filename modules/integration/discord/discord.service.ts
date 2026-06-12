/**
 * Discord Integration -- Service Layer
 *
 * Manages the Discord integration lifecycle:
 *   - Connect/disconnect via webhook URL (no OAuth)
 *   - IntegrationWebhook CRUD (scoped routing)
 *   - Webhook resolution (project -> team -> default -> + urgent)
 *
 * Database tables:
 *   - Integration: connected flag, accessToken (null for Discord)
 *   - IntegrationSetting: key/value notification toggles
 *   - IntegrationWebhook: webhook URLs with scope routing
 */

import { Prisma } from "../../../app/generated/prisma/client.js";
import { prisma } from "../../../shared/utils/prisma.js";
import { AppError } from "../../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../../shared/errors/error-codes.js";
import { logActivity } from "../../../shared/utils/activity.js";
import {
  findConnectedIntegration,
  getSettings,
  upsertSettings,
  initDefaultSettings,
} from "../integration.service.js";
import { maskWebhookUrl } from "./discord.utils.js";

// ─── Default Settings ───────────────────────────────────────────────────────

const DEFAULT_DISCORD_SETTINGS: Record<string, boolean> = {
  notifyOnIssueCreatedUrgent: true,
  notifyOnIssueCompleted: true,
  notifyOnIssueAssigned: false,
  notifyOnStatusChange: false,
  notifyOnCycleStarted: true,
  notifyOnCycleCompleted: true,
  notifyOnProjectCompleted: true,
};

// ─── Webhook URL Pattern ────────────────────────────────────────────────────

const DISCORD_WEBHOOK_URL_PATTERN =
  /^https:\/\/(?:discord\.com|discordapp\.com|discordptb\.com)\/api\/webhooks\/\d+\/.+$/;

// ─── Connect ────────────────────────────────────────────────────────────────

/**
 * Connect Discord integration.
 *
 * 1. Validate URL format
 * 2. GET the webhook URL to verify it's alive + extract channelId/guildId
 * 3. Upsert Integration (connected=true, no accessToken)
 * 4. Create IntegrationWebhook row with scope="default"
 * 5. Init default settings
 * 6. Preserve existing webhook routing on reconnect
 * 7. Log activity
 */
export async function connectDiscord(
  workspaceId: string,
  userId: string,
  input: { webhookUrl: string; label?: string },
) {
  // 1. Validate URL format
  if (!DISCORD_WEBHOOK_URL_PATTERN.test(input.webhookUrl)) {
    throw new AppError(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      "Invalid Discord webhook URL. It must start with https://discord.com/api/webhooks/",
    );
  }

  // 2. Verify the webhook URL is alive
  const verifyResponse = await fetch(input.webhookUrl);
  if (!verifyResponse.ok) {
    throw new AppError(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      "This Discord webhook URL is invalid or has been deleted. Create a new one in Discord channel settings.",
    );
  }

  const webhookInfo = (await verifyResponse.json()) as {
    name?: string;
    channel_id?: string;
    guild_id?: string;
  };

  const label = input.label ?? webhookInfo.name ?? "Default";

  // 3. Upsert Integration row (no accessToken for Discord)
  const integration = await prisma.integration.upsert({
    where: { workspaceId_provider: { workspaceId, provider: "DISCORD" } },
    create: {
      workspaceId,
      provider: "DISCORD",
      connected: true,
      accessToken: null,
      providerMeta: Prisma.JsonNull,
      connectedAt: new Date(),
      connectedById: userId,
    },
    update: {
      connected: true,
      connectedAt: new Date(),
      connectedById: userId,
    },
  });

  // 4. Upsert the default webhook row (don't duplicate on reconnect)
  const existingDefault = await prisma.integrationWebhook.findFirst({
    where: { integrationId: integration.id, scope: "default" },
  });

  if (existingDefault) {
    await prisma.integrationWebhook.update({
      where: { id: existingDefault.id },
      data: {
        url: input.webhookUrl,
        label,
      },
    });
  } else {
    await prisma.integrationWebhook.create({
      data: {
        integrationId: integration.id,
        url: input.webhookUrl,
        label,
        scope: "default",
        scopeId: null,
      },
    });
  }

  // 5. Init default settings (no-op if settings already exist)
  await initDefaultSettings(integration.id, DEFAULT_DISCORD_SETTINGS);

  // 6. Existing project/team/urgent webhooks are preserved (we only touched default above)

  // 7. Log activity
  await logActivity({
    workspaceId,
    actorId: userId,
    type: "INTEGRATION_CONNECTED",
    targetType: "INTEGRATION",
    targetId: "DISCORD",
    message: "Discord integration connected",
    metadata: { provider: "discord", label },
  });

  return { provider: "discord", label };
}

// ─── Webhook CRUD ───────────────────────────────────────────────────────────

/** Add a new webhook routing row. */
export async function addWebhook(
  workspaceId: string,
  input: { url: string; label: string; scope: string; scopeId?: string | undefined },
) {
  const integration = await findConnectedIntegration(workspaceId, "DISCORD");
  if (!integration) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Discord integration not connected");
  }

  const webhook = await prisma.integrationWebhook.create({
    data: {
      integrationId: integration.id,
      url: input.url,
      label: input.label,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
    },
  });

  return webhook;
}

/** Remove a webhook routing row. */
export async function removeWebhook(workspaceId: string, webhookDbId: string) {
  const integration = await findConnectedIntegration(workspaceId, "DISCORD");
  if (!integration) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Discord integration not connected");
  }

  const webhook = await prisma.integrationWebhook.findFirst({
    where: { id: webhookDbId, integrationId: integration.id },
  });

  if (!webhook) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Webhook not found");
  }

  await prisma.integrationWebhook.delete({ where: { id: webhookDbId } });
}

/** List all webhook rows for this integration. */
export async function getWebhooks(integrationId: string) {
  return prisma.integrationWebhook.findMany({
    where: { integrationId },
    orderBy: { id: "asc" },
  });
}

// ─── Webhook Resolution ────────────────────────────────────────────────────

/**
 * Resolve which webhook URLs to post to for a given context.
 *
 * Priority:
 *   1. Project-scoped webhooks (if issue has a projectId with mapped webhooks)
 *   2. Team-scoped webhooks (if no project webhooks, check teamId)
 *   3. Default-scoped webhook (fallback)
 *   4. Urgent-scoped webhook (ADDED ON TOP for high/urgent priority)
 *
 * Returns deduplicated array of webhook URLs.
 */
export async function resolveWebhooks(
  integrationId: string,
  context: { projectId?: string | null; teamId?: string | null; priority?: string | null },
): Promise<string[]> {
  const allWebhooks = await prisma.integrationWebhook.findMany({
    where: { integrationId },
  });

  const urls: string[] = [];

  // 1. Project-scoped
  if (context.projectId) {
    const projectHooks = allWebhooks.filter(
      (w) => w.scope === "project" && w.scopeId === context.projectId,
    );
    for (const h of projectHooks) {
      if (!urls.includes(h.url)) urls.push(h.url);
    }
  }

  // 2. Team-scoped (only if no project webhooks found)
  if (urls.length === 0 && context.teamId) {
    const teamHooks = allWebhooks.filter(
      (w) => w.scope === "team" && w.scopeId === context.teamId,
    );
    for (const h of teamHooks) {
      if (!urls.includes(h.url)) urls.push(h.url);
    }
  }

  // 3. Default (only if no project/team webhooks found)
  if (urls.length === 0) {
    const defaultHooks = allWebhooks.filter((w) => w.scope === "default");
    for (const h of defaultHooks) {
      if (!urls.includes(h.url)) urls.push(h.url);
    }
  }

  // 4. Urgent -- ADDED ON TOP for high/urgent priority
  const priorityLower = (context.priority ?? "").toLowerCase();
  if (priorityLower === "urgent" || priorityLower === "high") {
    const urgentHooks = allWebhooks.filter((w) => w.scope === "urgent");
    for (const h of urgentHooks) {
      if (!urls.includes(h.url)) urls.push(h.url);
    }
  }

  return urls;
}
