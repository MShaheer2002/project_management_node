---
id: ai-connections
title: AI Connections and API keys
category: AI
route: /ai-connections
primary: true
roles: OWNER, ADMIN, MEMBER, GUEST
plans: FREE, STANDARD, PREMIUM
keywords: mcp, claude, chatgpt, cursor, connect ai, api key, personal access token, pat, scopes, ai connection, generate token, rotate token, revoke, expired token
---

Use Trussen from your own AI app, like Claude, ChatGPT, Cursor or VS Code, through **MCP**. Works on **every plan**. Your AI app uses its own model, so it doesn't count toward Trussen's AI limits.

There are two ways to connect: sign in from the AI app, or a token.

## Connect by signing in (anyone)

1. In your AI app, add Trussen as an MCP server and start the sign in.
2. Trussen opens **Connect your AI client**. Pick the **Workspace**, give it a **Connection name** (like "My Claude Desktop") and say which client it is.
3. Choose what the app may access (scopes). It starts as read only: issues and projects.
4. Confirm. You see **Connected**. Go back to your AI app and try again.

Setup links expire after **30 minutes**. If one has expired, start again from the AI app.

## What an app can access (scopes)

| Area | Read | Write |
|---|---|---|
| Issues | View issues, comments and search | Create, edit, assign and comment |
| Projects | View projects and summaries | Create and edit projects |
| Teams | View teams and workload | Create and edit teams |
| Departments | View departments | Create and edit departments |
| Cycles | View cycles | Create and edit cycles |
| Members | View workspace members | |
| Analytics | View analytics | |

**Admin** gives full access. Only owners and admins can give it.

An app can never do more than **your role** allows, whatever scopes it has.

## Personal access tokens (owners and admins)

For tools and scripts, owners and admins open **Settings › Personal Access Tokens** and click **Generate Token**:

1. **Connection name** and **Primary client** (Claude Desktop, Claude Code, ChatGPT, Cursor, VS Code, Codex, Gemini CLI, Windsurf or Generic MCP).
2. **Auth method:** Personal Access Token. OAuth is the sign in way above and starts from your AI app.
3. **Access scopes** and **Expiration**: Never, 30 days, 60 days, 90 days or 1 year.
4. Copy the token and the setup for your client, then click **I've copied the token**.

The token is shown **only once**. Anyone who has it can act as you, so keep it secret.

## Manage connections

In **Settings › Personal Access Tokens**, each connection has:

- **Check:** tests that it's ready for MCP clients.
- **Scopes:** change what it can access.
- **Rotate:** makes a new token and stops the old one. Copy the new one before closing.
- **Revoke:** turns it off for good. Reconnecting from the app won't bring it back.
- **Recent MCP sessions:** when it was used.

Expired tokens are marked **Expired**.
