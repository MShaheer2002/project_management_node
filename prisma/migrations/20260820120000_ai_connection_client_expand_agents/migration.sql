-- AiConnectionClient enum expansion: cover the main AI agents/clients
ALTER TYPE "AiConnectionClient" ADD VALUE IF NOT EXISTS 'CLAUDE_CODE';
ALTER TYPE "AiConnectionClient" ADD VALUE IF NOT EXISTS 'CHATGPT';
ALTER TYPE "AiConnectionClient" ADD VALUE IF NOT EXISTS 'GEMINI_CLI';
ALTER TYPE "AiConnectionClient" ADD VALUE IF NOT EXISTS 'WINDSURF';
ALTER TYPE "AiConnectionClient" ADD VALUE IF NOT EXISTS 'VSCODE';
