import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { env } from "../../config/env.js";
import { prisma } from "../../shared/utils/prisma.js";
import {
  createApiKey,
  getApiKeyById,
  revokeApiKey,
} from "../api-key/api-key.service.js";
import {
  assertAiConnectionAuthMethodSupported,
  listAiConnectionCatalog,
} from "./ai-connection.catalog.js";
import type { AiConnectionClientInput, CreateAiConnectionInput } from "./ai-connection.schemas.js";
import {
  AiConnectionAuthType,
  AiConnectionClient,
  AiConnectionStatus,
} from "../../app/generated/prisma/client.js";

const AI_CONNECTION_SCOPES = ["mcp:v1"];

function toClientEnum(client?: AiConnectionClientInput | null) {
  switch (client) {
    case "codex":
      return AiConnectionClient.CODEX;
    case "claude_desktop":
      return AiConnectionClient.CLAUDE_DESKTOP;
    case "cursor":
      return AiConnectionClient.CURSOR;
    case "generic_mcp":
    case undefined:
    case null:
      return AiConnectionClient.GENERIC_MCP;
  }
}

function toClientValue(client: AiConnectionClient): AiConnectionClientInput {
  switch (client) {
    case AiConnectionClient.CODEX:
      return "codex";
    case AiConnectionClient.CLAUDE_DESKTOP:
      return "claude_desktop";
    case AiConnectionClient.CURSOR:
      return "cursor";
    case AiConnectionClient.GENERIC_MCP:
      return "generic_mcp";
  }
}

export function toConnectionStatus(input: {
  status: AiConnectionStatus;
  apiKeyExpiresAt?: Date | null;
  apiKeyId?: string | null;
}) {
  if (input.status === AiConnectionStatus.REVOKED || !input.apiKeyId) {
    return "revoked" as const;
  }
  if (input.apiKeyExpiresAt && input.apiKeyExpiresAt < new Date()) {
    return "expired" as const;
  }
  return "active" as const;
}

function toSummary(connection: {
  id: string;
  label: string;
  client: AiConnectionClient;
  authType: AiConnectionAuthType;
  status: AiConnectionStatus;
  createdAt: Date;
  scopes: unknown;
  apiKey: {
    id: string;
    keyPrefix: string;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    createdBy: { id: string; name: string; email: string };
  } | null;
}) {
  const status = toConnectionStatus({
    status: connection.status,
    apiKeyExpiresAt: connection.apiKey?.expiresAt ?? null,
    apiKeyId: connection.apiKey?.id ?? null,
  });
  return {
    id: connection.id,
    name: connection.label,
    client: toClientValue(connection.client),
    authType: connection.authType.toLowerCase(),
    status,
    scopes: Array.isArray(connection.scopes) ? connection.scopes : AI_CONNECTION_SCOPES,
    keyPrefix: connection.apiKey?.keyPrefix ?? null,
    createdAt: connection.createdAt,
    lastUsedAt: connection.apiKey?.lastUsedAt ?? null,
    expiresAt: connection.apiKey?.expiresAt ?? null,
    isExpired: status === "expired",
    createdBy: connection.apiKey?.createdBy ?? null,
  };
}

export function resolveMcpBaseUrl() {
  const baseUrl = env.BACKEND_URL ?? `http://localhost:${env.PORT}`;
  return new URL("/mcp", baseUrl).toString();
}

export function resolveCodexMcpUrl(token: string) {
  const url = new URL(resolveMcpBaseUrl());
  url.searchParams.set("api_key", token);
  return url.toString();
}

export function buildCodexConfig(token: string) {
  return [
    '[mcp_servers.trussen]',
    `url = "${resolveCodexMcpUrl(token)}"`,
  ].join("\n");
}

export function buildClaudeDesktopConfig(token: string) {
  return JSON.stringify(
    {
      mcpServers: {
        trussen: {
          type: "http",
          url: resolveMcpBaseUrl(),
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  );
}

export function buildCursorConfig(token: string) {
  return JSON.stringify(
    {
      mcpServers: {
        trussen: {
          url: resolveMcpBaseUrl(),
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  );
}

export function buildGenericSetup(token: string) {
  return {
    endpoint: resolveMcpBaseUrl(),
    authHeaderName: "Authorization",
    authHeaderValue: `Bearer ${token}`,
    steps: [
      "Point your MCP client at the Trussen MCP URL shown below.",
      "Send the Authorization header exactly as shown below.",
      "The token already resolves workspace and permissions automatically.",
    ],
  };
}

export function buildSetupArtifacts(token: string) {
  return {
    codex: {
      client: "codex",
      format: "toml",
      title: "Codex Setup",
      config: buildCodexConfig(token),
    },
    claudeDesktop: {
      client: "claude_desktop",
      format: "json",
      title: "Claude Desktop Setup",
      config: buildClaudeDesktopConfig(token),
    },
    cursor: {
      client: "cursor",
      format: "json",
      title: "Cursor Setup",
      config: buildCursorConfig(token),
    },
    genericMcp: {
      client: "generic_mcp",
      format: "guide",
      title: "Generic MCP Setup",
      ...buildGenericSetup(token),
    },
  };
}

export async function getAiConnectionCatalog() {
  return listAiConnectionCatalog();
}

export async function listAiConnections(workspaceId: string) {
  const connections = await prisma.aiConnection.findMany({
    where: {
      workspaceId,
      status: { not: AiConnectionStatus.REVOKED },
    },
    include: {
      apiKey: {
        select: {
          id: true,
          keyPrefix: true,
          lastUsedAt: true,
          expiresAt: true,
          createdBy: {
            select: { id: true, name: true, email: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return connections.map((connection) => toSummary(connection));
}

export async function createAiConnection(
  workspaceId: string,
  userId: string,
  input: CreateAiConnectionInput,
) {
  const primaryClient = input.primaryClient ?? "generic_mcp";
  const authType = input.authType ?? "pat";

  assertAiConnectionAuthMethodSupported(primaryClient, authType);

  const created = await createApiKey(workspaceId, userId, {
    name: input.name,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });

  try {
    const connection = await prisma.aiConnection.create({
      data: {
        workspaceId,
        userId,
        apiKeyId: created.id,
        label: input.name,
        client: toClientEnum(primaryClient),
        authType: AiConnectionAuthType.PAT,
        scopes: AI_CONNECTION_SCOPES,
      },
      include: {
        apiKey: {
          select: {
            id: true,
            keyPrefix: true,
            lastUsedAt: true,
            expiresAt: true,
            createdBy: {
              select: { id: true, name: true, email: true },
            },
          },
        },
      },
    });

    return {
      connection: toSummary(connection),
      token: created.key,
      primaryClient,
      setup: buildSetupArtifacts(created.key),
    };
  } catch (error) {
    await prisma.apiKey.delete({ where: { id: created.id } }).catch(() => undefined);
    throw error;
  }
}

export async function getAiConnectionByApiKeyId(apiKeyId: string) {
  return prisma.aiConnection.findFirst({
    where: { apiKeyId },
    select: {
      id: true,
      workspaceId: true,
      userId: true,
      client: true,
      authType: true,
      status: true,
      scopes: true,
      label: true,
    },
  });
}

export async function revokeAiConnection(workspaceId: string, id: string, actorId: string) {
  const connection = await prisma.aiConnection.findFirst({
    where: { id, workspaceId },
    select: { id: true, apiKeyId: true, status: true },
  });

  if (!connection) {
    throw new AppError(404, ERROR_CODES.API_KEY_NOT_FOUND, "AI connection not found");
  }

  await prisma.aiConnection.update({
    where: { id: connection.id },
    data: {
      status: AiConnectionStatus.REVOKED,
      apiKeyId: null,
    },
  });

  if (connection.apiKeyId) {
    const key = await getApiKeyById(workspaceId, connection.apiKeyId);
    await revokeApiKey(workspaceId, key.id, actorId);
  }
}
