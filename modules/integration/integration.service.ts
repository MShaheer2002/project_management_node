/**
 * Integration Module — Shared Service
 *
 * Shared logic used by all providers:
 *   - List all integrations for a workspace
 *   - Disconnect a provider (generic)
 *   - Settings CRUD helpers (read/write IntegrationSetting rows)
 */

import { prisma } from "../../shared/utils/prisma.js";
import { Prisma, type IntegrationProvider } from "../../app/generated/prisma/client.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { logActivity } from "../../shared/utils/activity.js";

// ─── Provider Mapping ────────────────────────────────────────────────────────

const PROVIDER_MAP: Record<string, IntegrationProvider> = {
  github: "GITHUB",
  slack: "SLACK",
  discord: "DISCORD",
  figma: "FIGMA",
};

export function resolveProvider(provider: string): IntegrationProvider {
  const resolved = PROVIDER_MAP[provider.toLowerCase()];
  if (!resolved) {
    throw new AppError(400, ERROR_CODES.INTEGRATION_PROVIDER_INVALID, `Unknown provider: ${provider}`);
  }
  return resolved;
}

// ─── List Integrations ───────────────────────────────────────────────────────

export async function listIntegrations(workspaceId: string) {
  const integrations = await prisma.integration.findMany({
    where: { workspaceId },
    select: {
      id: true,
      provider: true,
      connected: true,
      providerMeta: true,
      connectedAt: true,
      connectedBy: { select: { id: true, name: true, email: true } },
    },
  });

  const providers = ["GITHUB", "SLACK", "DISCORD", "FIGMA"] as const;
  return providers.map((provider) => {
    const integration = integrations.find((i) => i.provider === provider);
    return {
      provider: provider.toLowerCase(),
      connected: integration?.connected ?? false,
      connectedAt: integration?.connectedAt ?? null,
      connectedBy: integration?.connectedBy ?? null,
      providerMeta: integration?.providerMeta ?? null,
    };
  });
}

// ─── Connection Status (all members) ─────────────────────────────────────────
// Unlike listIntegrations, this exposes no config/connectedBy details, so it's
// safe for any workspace member — used to gate feature visibility (e.g. Figma
// previews) for users who aren't allowed to manage integrations.

export async function getIntegrationConnectionStatus(workspaceId: string) {
  const integrations = await prisma.integration.findMany({
    where: { workspaceId },
    select: { provider: true, connected: true },
  });

  const providers = ["GITHUB", "SLACK", "DISCORD", "FIGMA"] as const;
  return providers.map((provider) => ({
    provider: provider.toLowerCase(),
    connected: integrations.find((i) => i.provider === provider)?.connected ?? false,
  }));
}

// ─── Disconnect ──────────────────────────────────────────────────────────────

export async function disconnectProvider(workspaceId: string, provider: string, actorId: string) {
  const dbProvider = resolveProvider(provider);

  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider: dbProvider } },
    select: { id: true, connected: true, accessToken: true, providerMeta: true },
  });

  if (!integration || !integration.connected) {
    throw new AppError(404, ERROR_CODES.INTEGRATION_NOT_CONNECTED, `${provider} is not connected`);
  }

  // Clean up GitHub webhooks on disconnect (best-effort)
  if (dbProvider === "GITHUB" && integration.accessToken) {
    const meta = integration.providerMeta as { repos?: string[] } | null;
    if (meta?.repos) {
      const { env } = await import("../../config/env.js");
      const webhookUrl = `${env.BACKEND_URL ?? `http://localhost:${env.PORT}`}/webhooks/github`;
      for (const repoFullName of meta.repos) {
        try {
          const hooksResponse = await fetch(`https://api.github.com/repos/${repoFullName}/hooks`, {
            headers: { Authorization: `Bearer ${integration.accessToken}`, Accept: "application/vnd.github.v3+json" },
          });
          if (hooksResponse.ok) {
            const hooks = (await hooksResponse.json()) as Array<{ id: number; config: { url?: string } }>;
            for (const hook of hooks) {
              if (hook.config.url === webhookUrl) {
                await fetch(`https://api.github.com/repos/${repoFullName}/hooks/${hook.id}`, {
                  method: "DELETE",
                  headers: { Authorization: `Bearer ${integration.accessToken}`, Accept: "application/vnd.github.v3+json" },
                });
              }
            }
          }
        } catch { /* best-effort */ }
      }
    }
  }

  // Delete all child records + reset parent
  await prisma.$transaction([
    prisma.integrationSetting.deleteMany({ where: { integrationId: integration.id } }),
    prisma.integrationChannel.deleteMany({ where: { integrationId: integration.id } }),
    prisma.integrationWebhook.deleteMany({ where: { integrationId: integration.id } }),
    prisma.integration.update({
      where: { id: integration.id },
      data: { connected: false, accessToken: null, providerMeta: Prisma.JsonNull, connectedAt: null, connectedById: null },
    }),
  ]);

  await logActivity({
    workspaceId,
    actorId,
    type: "INTEGRATION_DISCONNECTED",
    targetType: "INTEGRATION",
    targetId: dbProvider,
    message: `${provider} integration disconnected`,
    metadata: { provider },
  });
}

// ─── Settings Helpers ────────────────────────────────────────────────────────

export async function getSettings(integrationId: string): Promise<Record<string, boolean>> {
  const rows = await prisma.integrationSetting.findMany({
    where: { integrationId },
    select: { key: true, enabled: true },
  });
  return Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
}

export async function upsertSettings(integrationId: string, settings: Record<string, boolean | undefined>) {
  const ops = Object.entries(settings)
    .filter((entry): entry is [string, boolean] => entry[1] !== undefined)
    .map(([key, enabled]) =>
      prisma.integrationSetting.upsert({
        where: { integrationId_key: { integrationId, key } },
        create: { integrationId, key, enabled },
        update: { enabled },
      }),
    );
  if (ops.length > 0) await prisma.$transaction(ops);
}

export async function initDefaultSettings(integrationId: string, defaults: Record<string, boolean>) {
  const existing = await prisma.integrationSetting.findMany({
    where: { integrationId },
    select: { key: true },
  });
  const existingKeys = new Set(existing.map((r) => r.key));

  const newSettings = Object.entries(defaults)
    .filter(([key]) => !existingKeys.has(key))
    .map(([key, enabled]) => ({ integrationId, key, enabled }));

  if (newSettings.length > 0) {
    await prisma.integrationSetting.createMany({ data: newSettings, skipDuplicates: true });
  }
}

// ─── Find Integration ────────────────────────────────────────────────────────

export async function findConnectedIntegration(workspaceId: string, provider: IntegrationProvider) {
  const integration = await prisma.integration.findUnique({
    where: { workspaceId_provider: { workspaceId, provider } },
    select: { id: true, connected: true, accessToken: true, providerMeta: true, connectedById: true },
  });

  if (!integration?.connected) return null;
  return integration;
}
