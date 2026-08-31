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
  AiConnectionSessionStatus,
  AiConnectionStatus,
  AiConnectionVerificationStatus,
} from "../../app/generated/prisma/client.js";

const AI_CONNECTION_SCOPES = ["mcp:v1"];
const LOCAL_MCP_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DEFAULT_SESSION_LIST_LIMIT = 20;
const HTTP_LOGICAL_SESSION_TTL_MS = 10 * 60 * 1000;
const HTTP_BOOTSTRAP_SESSION_TTL_MS = 60 * 1000;

type AiConnectionHealthCheck = {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail";
  message: string;
};

type AiConnectionHealth = {
  status: "ready" | "warning" | "error";
  canConnect: boolean;
  checks: AiConnectionHealthCheck[];
};

export type AiConnectionLogicalSessionHint = {
  sessionKey?: string | null;
  providerSessionId?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
};

function toClientEnum(client?: AiConnectionClientInput | null) {
  switch (client) {
    case "codex":
      return AiConnectionClient.CODEX;
    case "claude_desktop":
      return AiConnectionClient.CLAUDE_DESKTOP;
    case "claude_code":
      return AiConnectionClient.CLAUDE_CODE;
    case "chatgpt":
      return AiConnectionClient.CHATGPT;
    case "gemini_cli":
      return AiConnectionClient.GEMINI_CLI;
    case "windsurf":
      return AiConnectionClient.WINDSURF;
    case "vscode":
      return AiConnectionClient.VSCODE;
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
    case AiConnectionClient.CLAUDE_CODE:
      return "claude_code";
    case AiConnectionClient.CHATGPT:
      return "chatgpt";
    case AiConnectionClient.GEMINI_CLI:
      return "gemini_cli";
    case AiConnectionClient.WINDSURF:
      return "windsurf";
    case AiConnectionClient.VSCODE:
      return "vscode";
    case AiConnectionClient.CURSOR:
      return "cursor";
    case AiConnectionClient.GENERIC_MCP:
      return "generic_mcp";
  }
}

function toVerificationStatusValue(
  status: AiConnectionVerificationStatus | null | undefined,
): "ready" | "warning" | "error" | null {
  switch (status) {
    case AiConnectionVerificationStatus.READY:
      return "ready";
    case AiConnectionVerificationStatus.WARNING:
      return "warning";
    case AiConnectionVerificationStatus.ERROR:
      return "error";
    case null:
    case undefined:
      return null;
  }
}

function toVerificationStatusEnum(status: AiConnectionHealth["status"]) {
  switch (status) {
    case "ready":
      return AiConnectionVerificationStatus.READY;
    case "warning":
      return AiConnectionVerificationStatus.WARNING;
    case "error":
      return AiConnectionVerificationStatus.ERROR;
  }
}

function toSessionStatusValue(
  status: AiConnectionSessionStatus,
): "active" | "succeeded" | "failed" | "rejected" {
  switch (status) {
    case AiConnectionSessionStatus.ACTIVE:
      return "active";
    case AiConnectionSessionStatus.SUCCEEDED:
      return "succeeded";
    case AiConnectionSessionStatus.FAILED:
      return "failed";
    case AiConnectionSessionStatus.REJECTED:
      return "rejected";
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

export function evaluateAiConnectionHealth(input: {
  endpointUrl: string;
  lifecycleStatus: ReturnType<typeof toConnectionStatus>;
  authType: "pat";
  availableAuthMethods?: string[];
}) {
  const checks: AiConnectionHealthCheck[] = [];
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpointUrl);
  } catch {
    return {
      status: "error" as const,
      canConnect: false,
      checks: [
        {
          key: "endpoint_url",
          label: "Endpoint URL",
          status: "fail" as const,
          message: "The configured MCP endpoint URL is invalid. Fix BACKEND_URL before sharing this connection.",
        },
      ],
    };
  }

  const supportsRequestedAuth =
    !input.availableAuthMethods ||
    input.availableAuthMethods.includes(input.authType);

  checks.push({
    key: "connection_lifecycle",
    label: "Connection lifecycle",
    status: input.lifecycleStatus === "active" ? "pass" : "fail",
    message:
      input.lifecycleStatus === "active"
        ? "Connection is active."
        : input.lifecycleStatus === "expired"
          ? "The linked token has expired."
          : "This AI connection has been revoked.",
  });

  checks.push({
    key: "auth_method",
    label: "Auth mode compatibility",
    status: supportsRequestedAuth ? "pass" : "fail",
    message: supportsRequestedAuth
      ? `This client can use ${input.authType.toUpperCase()} authentication.`
      : `This client cannot use ${input.authType.toUpperCase()} authentication in Trussen.`,
  });

  checks.push({
    key: "endpoint_protocol",
    label: "Endpoint transport",
    status:
      endpoint.protocol === "https:"
        ? LOCAL_MCP_HOSTS.has(endpoint.hostname)
          ? "warn"
          : "pass"
        : "fail",
    message:
      endpoint.protocol === "https:"
        ? LOCAL_MCP_HOSTS.has(endpoint.hostname)
          ? "The endpoint is HTTPS but still points to a local host. Use the tunneled or hosted URL for external clients."
          : "The endpoint is HTTPS and suitable for remote MCP clients."
        : "The endpoint is not HTTPS. Remote AI clients should use HTTPS.",
  });

  const hasFailure = checks.some((check) => check.status === "fail");
  const hasWarning = checks.some((check) => check.status === "warn");

  return {
    status: hasFailure ? "error" : hasWarning ? "warning" : "ready",
    canConnect: !hasFailure,
    checks,
  } satisfies AiConnectionHealth;
}

function buildConnectionHealth(input: {
  client: AiConnectionClient;
  authType: AiConnectionAuthType;
  lifecycleStatus: ReturnType<typeof toConnectionStatus>;
  endpoint: string;
}) {
  const client = toClientValue(input.client);
  const availableAuthMethods = listAiConnectionCatalog().clients.find((entry) => entry.id === client)?.availableAuthMethods;

  return evaluateAiConnectionHealth({
    endpointUrl: input.endpoint,
    lifecycleStatus: input.lifecycleStatus,
    authType: input.authType.toLowerCase() as "pat",
    ...(availableAuthMethods ? { availableAuthMethods } : {}),
  });
}

function toSummary(connection: {
  id: string;
  label: string;
  client: AiConnectionClient;
  authType: AiConnectionAuthType;
  status: AiConnectionStatus;
  scopes: unknown;
  createdAt: Date;
  lastUsedAt: Date | null;
  lastVerifiedAt: Date | null;
  lastVerificationStatus: AiConnectionVerificationStatus | null;
  lastVerificationMessage: string | null;
  lastVerificationChecks: unknown;
  rotatedAt: Date | null;
  requestCount: number;
  toolCallCount: number;
  apiKey: {
    id: string;
    keyPrefix: string;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    createdBy: { id: string; name: string; email: string };
  } | null;
}) {
  const endpoint = resolveMcpBaseUrl();
  const status = toConnectionStatus({
    status: connection.status,
    apiKeyExpiresAt: connection.apiKey?.expiresAt ?? null,
    apiKeyId: connection.apiKey?.id ?? null,
  });
  const health = buildConnectionHealth({
    client: connection.client,
    authType: connection.authType,
    lifecycleStatus: status,
    endpoint,
  });

  return {
    id: connection.id,
    name: connection.label,
    client: toClientValue(connection.client),
    authType: connection.authType.toLowerCase() as "pat",
    status,
    scopes: Array.isArray(connection.scopes) ? connection.scopes : AI_CONNECTION_SCOPES,
    keyPrefix: connection.apiKey?.keyPrefix ?? null,
    createdAt: connection.createdAt,
    lastUsedAt: connection.lastUsedAt ?? connection.apiKey?.lastUsedAt ?? null,
    expiresAt: connection.apiKey?.expiresAt ?? null,
    isExpired: status === "expired",
    createdBy: connection.apiKey?.createdBy ?? null,
    endpoint,
    rotatedAt: connection.rotatedAt,
    requestCount: connection.requestCount,
    toolCallCount: connection.toolCallCount,
    verification: {
      lastVerifiedAt: connection.lastVerifiedAt,
      status: toVerificationStatusValue(connection.lastVerificationStatus),
      message: connection.lastVerificationMessage,
      checks: Array.isArray(connection.lastVerificationChecks)
        ? connection.lastVerificationChecks
        : [],
    },
    health,
  };
}

function toSessionSummary(session: {
  id: string;
  client: AiConnectionClient;
  authType: AiConnectionAuthType;
  transport: string;
  status: AiConnectionSessionStatus;
  requestCount: number;
  toolCallCount: number;
  startedAt: Date;
  lastActivityAt: Date;
  completedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  user: { id: string; name: string; email: string };
  steps: Array<{
    id: string;
    toolName: string;
    status: string;
    errorMessage: string | null;
    startedAt: Date;
    completedAt: Date | null;
  }>;
}) {
  return {
    id: session.id,
    client: toClientValue(session.client),
    authType: session.authType.toLowerCase() as "pat",
    transport: session.transport,
    status: toSessionStatusValue(session.status),
    requestCount: session.requestCount,
    toolCallCount: session.toolCallCount,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    completedAt: session.completedAt,
    lastErrorCode: session.lastErrorCode,
    lastErrorMessage: session.lastErrorMessage,
    user: session.user,
    steps: session.steps,
  };
}

function buildVerificationMessage(health: AiConnectionHealth) {
  return health.checks.find((check) => check.status !== "pass")?.message
    ?? "Connection is ready for remote MCP clients.";
}

function toNullableTrimmedString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanLogicalSessionHint(input?: AiConnectionLogicalSessionHint | null) {
  const sessionKey = toNullableTrimmedString(input?.sessionKey);
  const providerSessionId = toNullableTrimmedString(input?.providerSessionId);
  const clientName = toNullableTrimmedString(input?.clientName);
  const clientVersion = toNullableTrimmedString(input?.clientVersion);

  return {
    ...(sessionKey ? { sessionKey } : {}),
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(clientName ? { clientName } : {}),
    ...(clientVersion ? { clientVersion } : {}),
  };
}

async function persistVerification(connectionId: string, health: AiConnectionHealth) {
  await prisma.aiConnection.update({
    where: { id: connectionId },
    data: {
      lastVerifiedAt: new Date(),
      lastVerificationStatus: toVerificationStatusEnum(health.status),
      lastVerificationMessage: buildVerificationMessage(health),
      lastVerificationChecks: health.checks,
    },
  });
}

async function rejectActiveSessions(input: {
  connectionId: string;
  apiKeyId?: string | null;
  message: string;
}) {
  const now = new Date();
  await prisma.aiConnectionSession.updateMany({
    where: {
      aiConnectionId: input.connectionId,
      status: AiConnectionSessionStatus.ACTIVE,
      ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
    },
    data: {
      status: AiConnectionSessionStatus.REJECTED,
      completedAt: now,
      lastActivityAt: now,
      lastErrorCode: ERROR_CODES.AI_CONNECTION_REVOKED,
      lastErrorMessage: input.message,
    },
  });
}

async function closeStaleHttpSessions(connectionId: string) {
  const cutoff = new Date(Date.now() - HTTP_LOGICAL_SESSION_TTL_MS);
  await prisma.aiConnectionSession.updateMany({
    where: {
      aiConnectionId: connectionId,
      transport: "http",
      status: AiConnectionSessionStatus.ACTIVE,
      lastActivityAt: {
        lt: cutoff,
      },
    },
    data: {
      status: AiConnectionSessionStatus.SUCCEEDED,
      completedAt: cutoff,
    },
  });
}

async function touchConnectionUsage(input: {
  connectionId: string;
  incrementLogicalSessionCount?: boolean;
}) {
  await prisma.aiConnection.update({
    where: { id: input.connectionId },
    data: {
      lastUsedAt: new Date(),
      ...(input.incrementLogicalSessionCount
        ? { requestCount: { increment: 1 } }
        : {}),
    },
  });
}

async function getAiConnectionRecord(workspaceId: string, id: string) {
  const connection = await prisma.aiConnection.findFirst({
    where: { id, workspaceId },
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

  if (!connection) {
    throw new AppError(404, ERROR_CODES.AI_CONNECTION_NOT_FOUND, "AI connection not found");
  }

  return connection;
}

async function getActiveAiConnectionRecord(workspaceId: string, id: string) {
  const connection = await getAiConnectionRecord(workspaceId, id);
  // `status` is the sole source of truth for "revoked" — OAuth connections have
  // no apiKeyId by design, so checking it here would wrongly flag them as revoked.
  if (connection.status === AiConnectionStatus.REVOKED) {
    throw new AppError(409, ERROR_CODES.AI_CONNECTION_REVOKED, "This AI connection has already been revoked.");
  }
  return connection;
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

export function buildClaudeCodeConfig(token: string) {
  return `claude mcp add --transport http trussen ${resolveMcpBaseUrl()} --header "Authorization: Bearer ${token}"`;
}

export function buildChatGptSetup(token: string) {
  return {
    endpoint: resolveMcpBaseUrl(),
    authHeaderName: "Authorization",
    authHeaderValue: `Bearer ${token}`,
    steps: [
      "In ChatGPT, go to Settings > Connectors > Advanced settings and turn on Developer mode.",
      "Back in Connectors, click Create, name it Trussen, and paste the MCP server URL shown below.",
      "Set Authentication to Custom Headers and add the header exactly as shown below.",
      "Save, then enable the Trussen connector in a chat's tools/connectors menu.",
    ],
  };
}

export function buildGeminiCliConfig(token: string) {
  return JSON.stringify(
    {
      mcpServers: {
        trussen: {
          httpUrl: resolveMcpBaseUrl(),
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

export function buildWindsurfConfig(token: string) {
  return JSON.stringify(
    {
      mcpServers: {
        trussen: {
          serverUrl: resolveMcpBaseUrl(),
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

export function buildVsCodeConfig(token: string) {
  return JSON.stringify(
    {
      servers: {
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
    claudeCode: {
      client: "claude_code",
      format: "shell",
      title: "Claude Code Setup",
      config: buildClaudeCodeConfig(token),
    },
    chatgpt: {
      client: "chatgpt",
      format: "guide",
      title: "ChatGPT Setup",
      ...buildChatGptSetup(token),
    },
    geminiCli: {
      client: "gemini_cli",
      format: "json",
      title: "Gemini CLI Setup",
      config: buildGeminiCliConfig(token),
    },
    windsurf: {
      client: "windsurf",
      format: "json",
      title: "Windsurf Setup",
      config: buildWindsurfConfig(token),
    },
    vscode: {
      client: "vscode",
      format: "json",
      title: "VS Code Setup",
      config: buildVsCodeConfig(token),
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

export async function getAiConnectionHealth(workspaceId: string, id: string) {
  const connection = await getAiConnectionRecord(workspaceId, id);
  const summary = toSummary(connection);
  await persistVerification(connection.id, summary.health);

  const refreshed = toSummary(await getAiConnectionRecord(workspaceId, id));
  return {
    connection: refreshed,
    diagnostics: {
      endpoint: refreshed.endpoint,
      canConnect: refreshed.health.canConnect,
      status: refreshed.health.status,
      checks: refreshed.health.checks,
      verificationPrompt: "List my Trussen projects",
    },
  };
}

export async function listAiConnectionSessions(workspaceId: string, id: string, limit = DEFAULT_SESSION_LIST_LIMIT) {
  await getAiConnectionRecord(workspaceId, id);

  const sessions = await prisma.aiConnectionSession.findMany({
    where: {
      aiConnectionId: id,
      workspaceId,
    },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: {
      id: true,
      client: true,
      authType: true,
      transport: true,
      status: true,
      requestCount: true,
      toolCallCount: true,
      startedAt: true,
      lastActivityAt: true,
      completedAt: true,
      lastErrorCode: true,
      lastErrorMessage: true,
      user: {
        select: { id: true, name: true, email: true },
      },
      steps: {
        orderBy: { startedAt: "asc" },
        take: 25,
        select: {
          id: true,
          toolName: true,
          status: true,
          errorMessage: true,
          startedAt: true,
          completedAt: true,
        },
      },
    },
  });

  return sessions.map((session) => toSessionSummary(session));
}

export async function createAiConnection(
  workspaceId: string,
  userId: string,
  input: CreateAiConnectionInput,
) {
  const primaryClient = input.primaryClient ?? "generic_mcp";
  const authType = input.authType ?? "pat";
  const scopes = input.scopes?.length ? input.scopes : ["admin"];

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
        scopes,
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

    const summary = toSummary(connection);
    await persistVerification(connection.id, summary.health);

    return {
      connection: toSummary(await getAiConnectionRecord(workspaceId, connection.id)),
      token: created.key,
      primaryClient,
      setup: buildSetupArtifacts(created.key),
    };
  } catch (error) {
    await prisma.apiKey.delete({ where: { id: created.id } }).catch(() => undefined);
    throw error;
  }
}

export async function rotateAiConnection(workspaceId: string, id: string, actorId: string) {
  const connection = await getActiveAiConnectionRecord(workspaceId, id);
  const previousApiKeyId = connection.apiKeyId;
  if (!previousApiKeyId) {
    throw new AppError(409, ERROR_CODES.AI_CONNECTION_REVOKED, "This AI connection has no active token to rotate.");
  }

  const previousKey = await getApiKeyById(workspaceId, previousApiKeyId);
  const expiresAt =
    previousKey.expiresAt && previousKey.expiresAt > new Date()
      ? previousKey.expiresAt.toISOString()
      : undefined;

  const created = await createApiKey(
    workspaceId,
    actorId,
    {
      name: connection.label,
      ...(expiresAt ? { expiresAt } : {}),
    },
    { skipLimitCheck: true },
  );

  try {
    await prisma.$transaction(async (tx) => {
      const now = new Date();

      await tx.aiConnectionSession.updateMany({
        where: {
          aiConnectionId: connection.id,
          apiKeyId: previousApiKeyId,
          status: AiConnectionSessionStatus.ACTIVE,
        },
        data: {
          status: AiConnectionSessionStatus.REJECTED,
          completedAt: now,
          lastActivityAt: now,
          lastErrorCode: ERROR_CODES.AI_CONNECTION_REVOKED,
          lastErrorMessage: "This AI connection token was rotated and the previous session is no longer valid.",
        },
      });

      await tx.aiConnection.update({
        where: { id: connection.id },
        data: {
          apiKeyId: created.id,
          status: AiConnectionStatus.ACTIVE,
          rotatedAt: now,
          lastUsedAt: null,
        },
      });

      await tx.apiKey.delete({
        where: { id: previousApiKeyId },
      });
    });
  } catch (error) {
    await revokeApiKey(workspaceId, created.id, actorId).catch(() => undefined);
    throw error;
  }

  const refreshed = await getAiConnectionRecord(workspaceId, id);
  const summary = toSummary(refreshed);
  await persistVerification(id, summary.health);

  return {
    connection: toSummary(await getAiConnectionRecord(workspaceId, id)),
    token: created.key,
    primaryClient: toClientValue(refreshed.client),
    setup: buildSetupArtifacts(created.key),
  };
}

/**
 * Resolves an OAuth-authenticated MCP session to its Trussen connection.
 * Returns null only when no connection exists yet for this (userId, clientId)
 * pair — the caller turns that into a "finish setup" prompt. Throws for every
 * other non-usable state, mirroring authenticateWithApiKey's defensive checks.
 */
export async function resolveOAuthConnection(userId: string, clientId: string) {
  const connection = await prisma.aiConnection.findFirst({
    where: { userId, oauthClientId: clientId },
    select: {
      id: true,
      workspaceId: true,
      userId: true,
      client: true,
      status: true,
      scopes: true,
      label: true,
    },
  });

  if (!connection) {
    return null;
  }

  if (connection.status === AiConnectionStatus.REVOKED) {
    throw new AppError(401, ERROR_CODES.AI_CONNECTION_REVOKED, "This Trussen AI connection has been revoked.");
  }

  const membership = await prisma.workspaceMembership.findUnique({
    where: {
      userId_workspaceId: {
        userId: connection.userId,
        workspaceId: connection.workspaceId,
      },
    },
    select: { role: true },
  });

  if (!membership) {
    throw new AppError(
      401,
      ERROR_CODES.AI_CONNECTION_REVOKED,
      "This AI connection's owner is no longer a member of the workspace.",
    );
  }

  return {
    id: connection.id,
    workspaceId: connection.workspaceId,
    userId: connection.userId,
    userRole: membership.role,
    client: connection.client,
    scopes: connection.scopes,
    label: connection.label,
  };
}

/**
 * Creates or reactivates the AiConnection an OAuth (Clerk) session resolves
 * to, keyed by (userId, clientId). Upsert on the compound unique index keeps
 * a reconnect idempotent — no duplicate rows, session/usage history intact.
 */
export async function completeOAuthSetup(
  workspaceId: string,
  userId: string,
  input: {
    clientId: string;
    name: string;
    primaryClient?: AiConnectionClientInput;
    scopes: string[];
  },
) {
  const primaryClient = input.primaryClient ?? "generic_mcp";
  const scopes = input.scopes.length ? input.scopes : ["admin"];

  const connection = await prisma.aiConnection.upsert({
    where: { userId_oauthClientId: { userId, oauthClientId: input.clientId } },
    create: {
      workspaceId,
      userId,
      oauthClientId: input.clientId,
      label: input.name,
      client: toClientEnum(primaryClient),
      authType: AiConnectionAuthType.OAUTH,
      status: AiConnectionStatus.ACTIVE,
      scopes,
    },
    update: {
      workspaceId,
      label: input.name,
      client: toClientEnum(primaryClient),
      status: AiConnectionStatus.ACTIVE,
      scopes,
    },
  });

  const summary = toSummary(await getAiConnectionRecord(workspaceId, connection.id));
  await persistVerification(connection.id, summary.health);

  return toSummary(await getAiConnectionRecord(workspaceId, connection.id));
}

export async function getAiConnectionByApiKeyId(apiKeyId: string) {
  return prisma.aiConnection.findFirst({
    where: { apiKeyId },
    select: {
      id: true,
      workspaceId: true,
      userId: true,
      apiKeyId: true,
      client: true,
      authType: true,
      status: true,
      scopes: true,
      label: true,
    },
  });
}

export type AiConnectionSessionIdentity =
  | { type: "pat"; apiKeyId: string }
  | { type: "oauth"; oauthClientId: string };

export function connectionMatchesIdentity(
  connection: { apiKeyId: string | null; oauthClientId: string | null },
  identity: AiConnectionSessionIdentity,
) {
  return identity.type === "pat"
    ? connection.apiKeyId === identity.apiKeyId
    : connection.oauthClientId === identity.oauthClientId;
}

export async function startAiConnectionSession(input: {
  connectionId: string;
  workspaceId: string;
  userId: string;
  identity: AiConnectionSessionIdentity;
  client: AiConnectionClientInput;
  transport: "http" | "stdio";
  scopes?: string[];
}) {
  const connection = await prisma.aiConnection.findFirst({
    where: {
      id: input.connectionId,
      workspaceId: input.workspaceId,
    },
    select: {
      id: true,
      apiKeyId: true,
      oauthClientId: true,
      status: true,
    },
  });

  if (!connection || connection.status === AiConnectionStatus.REVOKED || !connectionMatchesIdentity(connection, input.identity)) {
    throw new AppError(401, ERROR_CODES.AI_CONNECTION_REVOKED, "This Trussen AI connection is no longer active.");
  }

  const session = await prisma.aiConnectionSession.create({
    data: {
      aiConnectionId: input.connectionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      apiKeyId: input.identity.type === "pat" ? input.identity.apiKeyId : null,
      client: toClientEnum(input.client),
      authType: input.identity.type === "pat" ? AiConnectionAuthType.PAT : AiConnectionAuthType.OAUTH,
      transport: input.transport,
      scopeSnapshot: input.scopes ?? AI_CONNECTION_SCOPES,
    },
    select: { id: true },
  });

  await touchConnectionUsage({
    connectionId: input.connectionId,
    incrementLogicalSessionCount: true,
  });

  return session;
}

export async function resolveAiConnectionHttpSession(input: {
  connectionId: string;
  workspaceId: string;
  userId: string;
  identity: AiConnectionSessionIdentity;
  client: AiConnectionClientInput;
  scopes?: string[];
  hint?: AiConnectionLogicalSessionHint | null;
}) {
  const connection = await prisma.aiConnection.findFirst({
    where: {
      id: input.connectionId,
      workspaceId: input.workspaceId,
    },
    select: {
      id: true,
      apiKeyId: true,
      oauthClientId: true,
      status: true,
    },
  });

  if (!connection || connection.status === AiConnectionStatus.REVOKED || !connectionMatchesIdentity(connection, input.identity)) {
    throw new AppError(401, ERROR_CODES.AI_CONNECTION_REVOKED, "This Trussen AI connection is no longer active.");
  }

  await closeStaleHttpSessions(connection.id);

  const now = new Date();
  const hint = cleanLogicalSessionHint(input.hint);
  const bootstrapCutoff = new Date(Date.now() - HTTP_BOOTSTRAP_SESSION_TTL_MS);
  const sessionApiKeyId = input.identity.type === "pat" ? input.identity.apiKeyId : null;
  const commonWhere = {
    aiConnectionId: connection.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    apiKeyId: sessionApiKeyId,
    client: toClientEnum(input.client),
    transport: "http",
    status: AiConnectionSessionStatus.ACTIVE,
  } as const;

  let session:
    | {
        id: string;
        toolCallCount: number;
      }
    | null = null;

  if (hint.sessionKey) {
    session = await prisma.aiConnectionSession.findFirst({
      where: {
        ...commonWhere,
        sessionKey: hint.sessionKey,
      },
      select: {
        id: true,
        toolCallCount: true,
      },
      orderBy: { lastActivityAt: "desc" },
    });

    if (!session) {
      session = await prisma.aiConnectionSession.findFirst({
        where: {
          ...commonWhere,
          sessionKey: null,
          toolCallCount: 0,
          lastActivityAt: {
            gte: bootstrapCutoff,
          },
        },
        select: {
          id: true,
          toolCallCount: true,
        },
        orderBy: { lastActivityAt: "desc" },
      });
    }
  } else {
    session = await prisma.aiConnectionSession.findFirst({
      where: {
        ...commonWhere,
        sessionKey: null,
        lastActivityAt: {
          gte: bootstrapCutoff,
        },
      },
      select: {
        id: true,
        toolCallCount: true,
      },
      orderBy: { lastActivityAt: "desc" },
    });
  }

  if (session) {
    await prisma.aiConnectionSession.update({
      where: { id: session.id },
      data: {
        lastActivityAt: now,
        requestCount: {
          increment: 1,
        },
        ...(hint.sessionKey ? { sessionKey: hint.sessionKey } : {}),
        ...(hint.providerSessionId ? { providerSessionId: hint.providerSessionId } : {}),
        ...(hint.clientName ? { clientName: hint.clientName } : {}),
        ...(hint.clientVersion ? { clientVersion: hint.clientVersion } : {}),
      },
    });

    await touchConnectionUsage({
      connectionId: connection.id,
      incrementLogicalSessionCount: false,
    });

    return { id: session.id };
  }

  const created = await prisma.aiConnectionSession.create({
    data: {
      aiConnectionId: input.connectionId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      apiKeyId: sessionApiKeyId,
      client: toClientEnum(input.client),
      authType: input.identity.type === "pat" ? AiConnectionAuthType.PAT : AiConnectionAuthType.OAUTH,
      transport: "http",
      scopeSnapshot: input.scopes ?? AI_CONNECTION_SCOPES,
      ...(hint.sessionKey ? { sessionKey: hint.sessionKey } : {}),
      ...(hint.providerSessionId ? { providerSessionId: hint.providerSessionId } : {}),
      ...(hint.clientName ? { clientName: hint.clientName } : {}),
      ...(hint.clientVersion ? { clientVersion: hint.clientVersion } : {}),
    },
    select: { id: true },
  });

  await touchConnectionUsage({
    connectionId: connection.id,
    incrementLogicalSessionCount: true,
  });

  return created;
}

export async function recordAiConnectionSessionStep(input: {
  sessionId: string;
  toolName: string;
  success: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const now = new Date();
  const session = await prisma.aiConnectionSession.findUnique({
    where: { id: input.sessionId },
    select: {
      aiConnectionId: true,
      status: true,
    },
  });
  if (!session || session.status !== AiConnectionSessionStatus.ACTIVE) {
    return;
  }

  await prisma.$transaction([
    prisma.aiConnectionSessionStep.create({
      data: {
        sessionId: input.sessionId,
        toolName: input.toolName,
        status: input.success ? "SUCCEEDED" : "FAILED",
        errorMessage: input.errorMessage ?? null,
        startedAt: now,
        completedAt: now,
      },
    }),
    prisma.aiConnectionSession.update({
      where: { id: input.sessionId },
      data: {
        toolCallCount: { increment: 1 },
        lastActivityAt: now,
        ...(input.success
          ? {}
          : {
              lastErrorCode: input.errorCode ?? ERROR_CODES.INTERNAL_ERROR,
              lastErrorMessage: input.errorMessage ?? "Tool execution failed",
            }),
      },
    }),
    prisma.aiConnection.update({
      where: { id: session.aiConnectionId },
      data: {
        lastUsedAt: now,
        toolCallCount: { increment: 1 },
      },
    }),
  ]);
}

export async function completeAiConnectionSession(input: {
  sessionId: string;
  status: "succeeded" | "failed" | "rejected";
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const now = new Date();
  const status =
    input.status === "succeeded"
      ? AiConnectionSessionStatus.SUCCEEDED
      : input.status === "rejected"
        ? AiConnectionSessionStatus.REJECTED
        : AiConnectionSessionStatus.FAILED;

  await prisma.aiConnectionSession.update({
    where: { id: input.sessionId },
    data: {
      status,
      completedAt: now,
      lastActivityAt: now,
      ...(input.errorCode ? { lastErrorCode: input.errorCode } : {}),
      ...(input.errorMessage ? { lastErrorMessage: input.errorMessage } : {}),
    },
  }).catch(() => undefined);
}

export async function updateAiConnectionScopes(workspaceId: string, id: string, scopes: string[]) {
  await getActiveAiConnectionRecord(workspaceId, id);

  await prisma.aiConnection.update({
    where: { id },
    data: { scopes },
  });

  return toSummary(await getAiConnectionRecord(workspaceId, id));
}

export async function revokeAiConnection(workspaceId: string, id: string, actorId: string) {
  const connection = await prisma.aiConnection.findFirst({
    where: { id, workspaceId },
    select: { id: true, apiKeyId: true },
  });

  if (!connection) {
    throw new AppError(404, ERROR_CODES.AI_CONNECTION_NOT_FOUND, "AI connection not found");
  }

  await prisma.aiConnection.update({
    where: { id: connection.id },
    data: {
      status: AiConnectionStatus.REVOKED,
      apiKeyId: null,
    },
  });

  await rejectActiveSessions({
    connectionId: connection.id,
    apiKeyId: connection.apiKeyId,
    message: "This AI connection was revoked and its active sessions were closed.",
  });

  if (connection.apiKeyId) {
    const key = await getApiKeyById(workspaceId, connection.apiKeyId);
    await revokeApiKey(workspaceId, key.id, actorId);
  }
}
