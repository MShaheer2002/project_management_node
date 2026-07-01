import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { env } from "../../config/env.js";
import {
  createApiKey,
  getApiKeyById,
  listApiKeys,
  revokeApiKey,
} from "../api-key/api-key.service.js";
import type { CreateAiConnectionInput } from "./ai-connection.schemas.js";

const AI_CONNECTION_PREFIX = "AI Connection — ";

type ApiKeyListItem = Awaited<ReturnType<typeof listApiKeys>>[number];

function toStoredName(label: string) {
  return `${AI_CONNECTION_PREFIX}${label}`;
}

function isAiConnectionKey(name: string) {
  return name.startsWith(AI_CONNECTION_PREFIX);
}

function toDisplayName(name: string) {
  return isAiConnectionKey(name) ? name.slice(AI_CONNECTION_PREFIX.length) : name;
}

function toSummary(key: ApiKeyListItem | Awaited<ReturnType<typeof createApiKey>>) {
  return {
    id: key.id,
    name: toDisplayName(key.name),
    keyPrefix: key.keyPrefix,
    createdAt: key.createdAt,
    lastUsedAt: "lastUsedAt" in key ? key.lastUsedAt : null,
    expiresAt: key.expiresAt,
    isExpired: "isExpired" in key ? key.isExpired : (key.expiresAt ? key.expiresAt < new Date() : false),
    createdBy: key.createdBy,
  };
}

function resolveMcpBaseUrl() {
  const baseUrl = env.BACKEND_URL ?? `http://localhost:${env.PORT}`;
  return new URL("/mcp", baseUrl).toString();
}

function resolveCodexMcpUrl(token: string) {
  const url = new URL(resolveMcpBaseUrl());
  url.searchParams.set("api_key", token);
  return url.toString();
}

function buildCodexConfig(token: string) {
  return [
    '[mcp_servers.trussen]',
    `url = "${resolveCodexMcpUrl(token)}"`,
  ].join("\n");
}

function buildClaudeDesktopConfig(token: string) {
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

function buildCursorConfig(token: string) {
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

function buildGenericSetup(token: string) {
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

function buildSetupArtifacts(token: string) {
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

export async function listAiConnections(workspaceId: string) {
  const keys = await listApiKeys(workspaceId);
  return keys.filter((key) => isAiConnectionKey(key.name)).map((key) => toSummary(key));
}

export async function createAiConnection(
  workspaceId: string,
  userId: string,
  input: CreateAiConnectionInput,
) {
  const created = await createApiKey(workspaceId, userId, {
    name: toStoredName(input.name),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });

  return {
    connection: toSummary(created),
    token: created.key,
    primaryClient: input.primaryClient ?? null,
    setup: buildSetupArtifacts(created.key),
  };
}

export async function revokeAiConnection(workspaceId: string, id: string, actorId: string) {
  const key = await getApiKeyById(workspaceId, id);

  if (!isAiConnectionKey(key.name)) {
    throw new AppError(404, ERROR_CODES.API_KEY_NOT_FOUND, "AI connection not found");
  }

  await revokeApiKey(workspaceId, id, actorId);
}
