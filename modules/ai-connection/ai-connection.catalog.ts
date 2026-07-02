import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import type { AiConnectionClientInput } from "./ai-connection.schemas.js";

export type AiConnectionRequestedAuthType = "pat" | "oauth";

type ClientCapabilityRecord = {
  id: AiConnectionClientInput;
  label: string;
  availableAuthMethods: AiConnectionRequestedAuthType[];
  supportsStreaming: boolean;
  supportsResources: boolean;
  supportsPrompts: boolean;
  supportsSampling: boolean;
  supportsNotifications: boolean;
  setupMode: "copy_config";
};

const CLIENT_CAPABILITIES: ClientCapabilityRecord[] = [
  {
    id: "codex",
    label: "Codex",
    availableAuthMethods: ["pat"],
    supportsStreaming: false,
    supportsResources: false,
    supportsPrompts: false,
    supportsSampling: false,
    supportsNotifications: false,
    setupMode: "copy_config",
  },
  {
    id: "claude_desktop",
    label: "Claude Desktop",
    availableAuthMethods: ["pat"],
    supportsStreaming: false,
    supportsResources: false,
    supportsPrompts: false,
    supportsSampling: false,
    supportsNotifications: false,
    setupMode: "copy_config",
  },
  {
    id: "cursor",
    label: "Cursor",
    availableAuthMethods: ["pat"],
    supportsStreaming: false,
    supportsResources: false,
    supportsPrompts: false,
    supportsSampling: false,
    supportsNotifications: false,
    setupMode: "copy_config",
  },
  {
    id: "generic_mcp",
    label: "Generic MCP",
    availableAuthMethods: ["pat"],
    supportsStreaming: false,
    supportsResources: false,
    supportsPrompts: false,
    supportsSampling: false,
    supportsNotifications: false,
    setupMode: "copy_config",
  },
];

const PLATFORM_AUTH_METHODS = [
  {
    type: "pat" as const,
    label: "Personal Access Token",
    status: "available" as const,
    implemented: true,
    summary: "Works today for Codex, Claude Desktop, Cursor, and generic MCP clients.",
    requirements: [
      "Generate a Trussen AI connection token.",
      "Paste the generated config into the target AI client.",
      "Store the token securely because it acts as the creating user.",
    ],
  },
  {
    type: "oauth" as const,
    label: "OAuth",
    status: "planned" as const,
    implemented: false,
    summary: "Planned for clients that support remote user-authorized Trussen connections.",
    requirements: [
      "Hosted MCP or AI Gateway endpoint reachable from the client.",
      "OAuth client registration, redirect URIs, and consent flow design.",
      "Per-user identity binding so each employee acts as themselves.",
    ],
  },
];

export function listAiConnectionCatalog() {
  return {
    clients: CLIENT_CAPABILITIES,
    authMethods: PLATFORM_AUTH_METHODS,
  };
}

export function assertAiConnectionAuthMethodSupported(
  client: AiConnectionClientInput,
  authType: AiConnectionRequestedAuthType,
) {
  const clientConfig = CLIENT_CAPABILITIES.find((entry) => entry.id === client);

  if (!clientConfig) {
    throw new AppError(400, ERROR_CODES.AI_CONNECTION_CLIENT_UNSUPPORTED, "Unsupported AI client");
  }

  if (!PLATFORM_AUTH_METHODS.some((entry) => entry.type === authType)) {
    throw new AppError(400, ERROR_CODES.AI_CONNECTION_AUTH_UNSUPPORTED, "Unsupported AI connection auth method");
  }

  if (!clientConfig.availableAuthMethods.includes(authType)) {
    if (authType === "oauth") {
      throw new AppError(
        501,
        ERROR_CODES.AI_CONNECTION_AUTH_NOT_IMPLEMENTED,
        "OAuth AI connections are planned but not available in this version.",
      );
    }

    throw new AppError(
      400,
      ERROR_CODES.AI_CONNECTION_AUTH_UNSUPPORTED,
      `This AI client does not support ${authType.toUpperCase()} connections in Trussen.`,
    );
  }
}
