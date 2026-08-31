import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import type { AiConnectionClientInput } from "./ai-connection.schemas.js";

export type AiConnectionRequestedAuthType = "pat" | "oauth";

type ClientCapabilityRecord = {
  id: AiConnectionClientInput;
  label: string;
  availableAuthMethods: AiConnectionRequestedAuthType[];
  supportsPAT: boolean;
  supportsOAuth: boolean;
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
    supportsPAT: true,
    supportsOAuth: false,
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
    supportsPAT: true,
    supportsOAuth: false,
    supportsStreaming: false,
    supportsResources: false,
    supportsPrompts: false,
    supportsSampling: false,
    supportsNotifications: false,
    setupMode: "copy_config",
  },
  {
    id: "claude_code",
    label: "Claude Code",
    availableAuthMethods: ["pat"],
    supportsPAT: true,
    supportsOAuth: false,
    supportsStreaming: false,
    supportsResources: false,
    supportsPrompts: false,
    supportsSampling: false,
    supportsNotifications: false,
    setupMode: "copy_config",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    availableAuthMethods: ["pat"],
    supportsPAT: true,
    supportsOAuth: false,
    supportsStreaming: false,
    supportsResources: false,
    supportsPrompts: false,
    supportsSampling: false,
    supportsNotifications: false,
    setupMode: "copy_config",
  },
  {
    id: "gemini_cli",
    label: "Gemini CLI",
    availableAuthMethods: ["pat"],
    supportsPAT: true,
    supportsOAuth: false,
    supportsStreaming: false,
    supportsResources: false,
    supportsPrompts: false,
    supportsSampling: false,
    supportsNotifications: false,
    setupMode: "copy_config",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    availableAuthMethods: ["pat"],
    supportsPAT: true,
    supportsOAuth: false,
    supportsStreaming: false,
    supportsResources: false,
    supportsPrompts: false,
    supportsSampling: false,
    supportsNotifications: false,
    setupMode: "copy_config",
  },
  {
    id: "vscode",
    label: "VS Code",
    availableAuthMethods: ["pat"],
    supportsPAT: true,
    supportsOAuth: false,
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
    supportsPAT: true,
    supportsOAuth: false,
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
    supportsPAT: true,
    supportsOAuth: false,
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
    summary: "Works today for Codex, Claude Desktop, Claude Code, ChatGPT, Gemini CLI, Windsurf, VS Code, Cursor, and any other generic MCP client.",
    requirements: [
      "Generate a Trussen AI connection token.",
      "Paste the generated config into the target AI client.",
      "Store the token securely because it acts as the creating user.",
    ],
  },
  {
    type: "oauth" as const,
    label: "OAuth",
    status: "available" as const,
    implemented: true,
    summary: "Sign-in-based connection, no token to copy. Start it from your AI client, not from this form — it will open a Trussen login/consent screen for you.",
    requirements: [
      "The AI client must support OAuth for remote MCP servers (Claude, Codex, ChatGPT, Cursor, and others documented in the setup guides all do).",
      "You'll pick a workspace and access scopes the first time you connect, at connect-ai.",
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
        400,
        ERROR_CODES.AI_CONNECTION_AUTH_UNSUPPORTED,
        "OAuth connections aren't created through this form — start the connection from your AI client instead. It will open a Trussen sign-in and consent screen.",
      );
    }

    throw new AppError(
      400,
      ERROR_CODES.AI_CONNECTION_AUTH_UNSUPPORTED,
      `This AI client does not support ${authType.toUpperCase()} connections in Trussen.`,
    );
  }
}
