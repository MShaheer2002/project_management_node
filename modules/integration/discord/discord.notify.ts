/**
 * Discord Integration -- Notification Handler
 *
 * Dispatches integration events to Discord via webhook embeds.
 * Called by the central event dispatcher with a normalized IntegrationEvent.
 */

import { findConnectedIntegration, getSettings } from "../integration.service.js";
import { resolveWebhooks } from "./discord.service.js";
import {
  maskWebhookUrl,
  buildIssueEmbed,
  DISCORD_EMBED_COLORS,
  type DiscordEmbed,
} from "./discord.utils.js";
import { env } from "../../../config/env.js";

// ─── Event Types ────────────────────────────────────────────────────────────

export interface IntegrationEvent {
  type:
    | "issue.created"
    | "issue.completed"
    | "issue.assigned"
    | "issue.status_changed"
    | "cycle.started"
    | "cycle.completed"
    | "project.completed";
  payload: Record<string, any>;
}

// ─── Discord Webhook Poster ────────────────────────────────────────────────

async function discordPost(webhookUrl: string, embeds: DiscordEmbed[]): Promise<void> {
  const logId = maskWebhookUrl(webhookUrl);
  try {
    const response = await fetch(`${webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "Linearis",
        embeds,
      }),
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 404) {
        console.warn(`[Discord] Webhook deleted (404): ${logId}`);
      } else if (status === 429) {
        const retryAfter = response.headers.get("retry-after");
        console.warn(`[Discord] Rate limited (${logId}). Retry after: ${retryAfter}s`);
      } else {
        console.warn(`[Discord] Webhook failed (${status}): ${logId}`);
      }
    }
  } catch (err) {
    console.warn(`[Discord] Webhook error (${logId}):`, err);
  }
}

// ─── Event Handler ──────────────────────────────────────────────────────────

/**
 * Handle an integration event for Discord.
 * Checks settings, resolves webhooks, and posts embeds.
 */
export async function handleEvent(workspaceId: string, event: IntegrationEvent): Promise<void> {
  let integration;
  try {
    integration = await findConnectedIntegration(workspaceId, "DISCORD");
  } catch {
    // Not connected -- silently skip
    return;
  }

  if (!integration) return;

  const settings = await getSettings(integration.id);

  switch (event.type) {
    case "issue.created":
      await notifyIssueCreated(integration.id, settings, event.payload);
      break;
    case "issue.completed":
      await notifyIssueCompleted(integration.id, settings, event.payload);
      break;
    case "issue.assigned":
      await notifyIssueAssigned(integration.id, settings, event.payload);
      break;
    case "issue.status_changed":
      if (!settings.notifyOnStatusChange) return;
      // Status change uses same embed style as assignment
      await notifyStatusChanged(integration.id, settings, event.payload);
      break;
    case "cycle.started":
      await notifyCycleEvent(integration.id, settings, "started", event.payload);
      break;
    case "cycle.completed":
      await notifyCycleEvent(integration.id, settings, "completed", event.payload);
      break;
    case "project.completed":
      if (!settings.notifyOnProjectCompleted) return;
      await notifyProjectCompleted(integration.id, settings, event.payload);
      break;
  }
}

// ─── Individual Notification Functions ───────────────────────────────────────

async function notifyIssueCreated(
  integrationId: string,
  settings: Record<string, boolean>,
  payload: Record<string, any>,
): Promise<void> {
  if (settings.notifyOnIssueCreatedUrgent !== true) return;

  const priorityLower = (payload.priority ?? "").toLowerCase();
  if (priorityLower !== "urgent" && priorityLower !== "high") return;

  const urls = await resolveWebhooks(integrationId, {
    projectId: payload.projectId,
    teamId: payload.teamId,
    priority: payload.priority,
  });
  if (urls.length === 0) return;

  const color = priorityLower === "urgent" ? DISCORD_EMBED_COLORS.urgent : DISCORD_EMBED_COLORS.high;
  const emoji = priorityLower === "urgent" ? "\ud83d\udd34" : "\ud83d\udfe0";

  const embed = buildIssueEmbed({
    title: `${emoji} ${payload.priority} Issue Created`,
    issueId: payload.id,
    issueTitle: payload.title,
    color,
    fields: [
      { name: "Priority", value: payload.priority },
      { name: "Assignee", value: payload.assigneeName ?? "Unassigned" },
      { name: "Project", value: payload.projectName ?? "\u2014" },
      { name: "Created by", value: payload.creatorName },
    ],
  });

  await Promise.all(urls.map((url) => discordPost(url, [embed])));
}

async function notifyIssueCompleted(
  integrationId: string,
  settings: Record<string, boolean>,
  payload: Record<string, any>,
): Promise<void> {
  if (settings.notifyOnIssueCompleted !== true) return;

  const urls = await resolveWebhooks(integrationId, {
    projectId: payload.projectId,
    teamId: payload.teamId,
  });
  if (urls.length === 0) return;

  const embed = buildIssueEmbed({
    title: "\u2705 Issue Completed",
    issueId: payload.id,
    issueTitle: payload.title,
    color: DISCORD_EMBED_COLORS.success,
    fields: [
      { name: "Completed by", value: payload.completedByName },
      ...(payload.projectName ? [{ name: "Project", value: payload.projectName }] : []),
    ],
  });

  await Promise.all(urls.map((url) => discordPost(url, [embed])));
}

async function notifyIssueAssigned(
  integrationId: string,
  settings: Record<string, boolean>,
  payload: Record<string, any>,
): Promise<void> {
  if (settings.notifyOnIssueAssigned !== true) return;

  const urls = await resolveWebhooks(integrationId, {
    projectId: payload.projectId,
    teamId: payload.teamId,
    priority: payload.priority,
  });
  if (urls.length === 0) return;

  const color =
    DISCORD_EMBED_COLORS[(payload.priority?.toLowerCase() ?? "") as keyof typeof DISCORD_EMBED_COLORS] ??
    DISCORD_EMBED_COLORS.info;

  const embed = buildIssueEmbed({
    title: "\ud83d\udc64 Issue Assigned",
    issueId: payload.id,
    issueTitle: payload.title,
    color,
    fields: [
      { name: "Assigned to", value: payload.assigneeName },
      { name: "Assigned by", value: payload.assignedByName },
      { name: "Priority", value: payload.priority },
    ],
  });

  await Promise.all(urls.map((url) => discordPost(url, [embed])));
}

async function notifyStatusChanged(
  integrationId: string,
  _settings: Record<string, boolean>,
  payload: Record<string, any>,
): Promise<void> {
  const urls = await resolveWebhooks(integrationId, {
    projectId: payload.projectId,
    teamId: payload.teamId,
    priority: payload.priority,
  });
  if (urls.length === 0) return;

  const embed = buildIssueEmbed({
    title: "\ud83d\udd04 Status Changed",
    issueId: payload.id,
    issueTitle: payload.title,
    color: DISCORD_EMBED_COLORS.info,
    fields: [
      { name: "From", value: payload.oldStatus ?? "\u2014" },
      { name: "To", value: payload.newStatus ?? "\u2014" },
      { name: "Changed by", value: payload.changedByName ?? "\u2014" },
    ],
  });

  await Promise.all(urls.map((url) => discordPost(url, [embed])));
}

async function notifyCycleEvent(
  integrationId: string,
  settings: Record<string, boolean>,
  type: "started" | "completed",
  payload: Record<string, any>,
): Promise<void> {
  if (type === "started" && settings.notifyOnCycleStarted !== true) return;
  if (type === "completed" && settings.notifyOnCycleCompleted !== true) return;

  const urls = await resolveWebhooks(integrationId, { teamId: payload.teamId });
  if (urls.length === 0) return;

  const isCompleted = type === "completed";
  const fields: Array<{ name: string; value: string }> = [];
  if (payload.teamName) fields.push({ name: "Team", value: payload.teamName });
  if (payload.dateRange) fields.push({ name: "Period", value: payload.dateRange });
  if (payload.totalIssues !== undefined) fields.push({ name: "Issues", value: String(payload.totalIssues) });
  if (isCompleted && payload.completedIssues !== undefined) {
    fields.push({ name: "Completed", value: String(payload.completedIssues) });
  }
  if (isCompleted && payload.carriedOver !== undefined) {
    fields.push({ name: "Carried over", value: String(payload.carriedOver) });
  }
  if (isCompleted && payload.totalIssues && payload.completedIssues) {
    fields.push({
      name: "Velocity",
      value: `${Math.round((payload.completedIssues / payload.totalIssues) * 100)}%`,
    });
  }

  const embed: DiscordEmbed = {
    title: isCompleted ? "\ud83c\udfc1 Cycle Completed" : "\ud83d\ude80 Cycle Started",
    description: payload.cycleName,
    color: isCompleted ? DISCORD_EMBED_COLORS.success : DISCORD_EMBED_COLORS.info,
    fields: fields.map((f) => ({ name: f.name, value: f.value, inline: true })),
    footer: { text: "Linearis" },
    timestamp: new Date().toISOString(),
  };

  await Promise.all(urls.map((url) => discordPost(url, [embed])));
}

async function notifyProjectCompleted(
  integrationId: string,
  _settings: Record<string, boolean>,
  payload: Record<string, any>,
): Promise<void> {
  const urls = await resolveWebhooks(integrationId, {
    projectId: payload.id,
    teamId: payload.teamId,
  });
  if (urls.length === 0) return;

  const embed: DiscordEmbed = {
    title: "\ud83c\udf89 Project Completed",
    description: payload.name,
    color: DISCORD_EMBED_COLORS.success,
    fields: [
      ...(payload.teamName ? [{ name: "Team", value: payload.teamName, inline: true }] : []),
      ...(payload.completedByName ? [{ name: "Completed by", value: payload.completedByName, inline: true }] : []),
    ],
    footer: { text: "Linearis" },
    timestamp: new Date().toISOString(),
    url: `${env.FRONTEND_URL}/projects/${payload.id}`,
  };

  await Promise.all(urls.map((url) => discordPost(url, [embed])));
}
