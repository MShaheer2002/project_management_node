# Trussen AI Panel (Phase 20B) — Integration Guide

> Full conversational AI with tool calling, conversation history, and workspace control.

---

## 1. What Was Built

### Backend (4 files + tool system)

```
modules/ai/
├── ai.chat.ts                    — Chat service: conversations, SSE streaming, tool loop
├── ai.controller.ts              — Chat + conversation CRUD endpoints (added to existing)
├── ai.routes.ts                  — POST /ai/chat, GET/DELETE /ai/conversations (added to existing)
├── tools/
│   ├── tool-definitions.ts       — 20 tool definitions (query, action, admin tools)
│   └── tool-executor.ts          — Executes tools against real DB with permission checks
└── docs/
    └── phase20b-integration.md   — This file
```

### Frontend (4 new files + 2 modified)

```
features/ai/
├── components/
│   ├── TrussenAiPanel.tsx        — Right-side panel with chat UI, @ mentions, history
│   ├── AiMarkdown.tsx            — Markdown renderer (tables→cards, bold, code, links)
│   └── MentionDropdown.tsx       — Shared @ mention dropdown component
├── hooks/
│   └── useMentionAutocomplete.ts — Shared @ mention logic (used by 20A + 20B)
└── services/
    └── aiService.ts              — Added conversation CRUD API calls

Modified:
├── app/layouts/MainLayout.tsx    — Added TrussenAiPanel to layout (pushes content)
├── app/stores/useUIStore.ts      — Added isAiPanelOpen, activeConversationId
└── shared/components/layout/TopNavbar.tsx — Added "Ask Trussen" button
```

### Database

```prisma
model AiConversation {
  id, userId, workspaceId, title, createdAt, updatedAt
  → messages: AiMessage[]
}

model AiMessage {
  id, conversationId, role (USER/ASSISTANT/TOOL_CALL/TOOL_RESULT),
  content, toolCalls (JSON), toolResults (JSON), tokenCount, createdAt
}
```

---

## 2. Architecture

```
User types message
    ↓
Frontend sends POST /ai/chat (SSE stream)
    ↓
Backend:
    1. Verify conversation ownership (userId + workspaceId)
    2. Save user message to DB
    3. Load conversation history (last 20 messages)
    4. Build system prompt with workspace lookup tables
       (projects, members, teams, departments, labels — all with IDs)
    5. Send to OpenRouter (DeepSeek V4 Flash) with 20 tool definitions
    ↓
AI Model decides:
    Option A: Respond with text → stream back to frontend
    Option B: Call tools → backend executes → feed results back → AI responds
    ↓
Backend:
    6. Execute tool calls (max 5 per turn, max 10K tokens)
       - Validate tool name against whitelist
       - Check user permissions (GUEST/MEMBER/ADMIN/OWNER)
       - Check private project/team visibility
       - Truncate large results (5K max)
    7. Save all messages (assistant, tool calls, tool results)
    8. Stream final response via SSE
    ↓
Frontend:
    - Renders messages with AiMarkdown (bold, tables→cards, code, links)
    - Issue IDs are clickable (navigate to issue detail)
    - Shows tool activity indicators ("Using list_issues...")
    - Conversation saved for history
```

---

## 3. API Endpoints

### POST /ai/chat (SSE Streaming)

**Auth:** `authenticate` + `requireWorkspace` + `strictRateLimiter`

**Request:**
```json
{
  "conversationId": "uuid (optional — null for new conversation)",
  "message": "Show my urgent issues"
}
```

**Response (Server-Sent Events):**
```
event: tool_call
data: {"tool": "list_issues", "args": {"assigneeId": "me", "priority": "urgent"}}

event: tool_result
data: {"tool": "list_issues", "success": true}

event: message
data: {"content": "You have 2 urgent issues...", "model": "deepseek/deepseek-v4-flash", "tokensUsed": 847}

event: done
data: {"conversationId": "uuid", "tokensUsed": 847}
```

### GET /ai/conversations

Returns user's conversation list (last 50, sorted by updatedAt).

### GET /ai/conversations/:id/messages

Returns all messages in a conversation. Verifies ownership.

### DELETE /ai/conversations/:id

Deletes conversation + all messages (cascade). Verifies ownership.

---

## 4. Tool System (20 Tools)

### Query Tools (all users)

| Tool | What | Permission |
|---|---|---|
| `list_issues` | List/filter issues | Workspace-scoped |
| `get_issue` | Issue details | Workspace-scoped |
| `list_projects` | List projects | Private projects hidden |
| `get_project_summary` | Project stats | Private check |
| `list_teams` | List teams | Private teams hidden |
| `list_team_members` | Team members | Private check |
| `list_members` | Workspace members | All |
| `get_team_workload` | Workload analysis | Private team check |
| `list_cycles` | Sprints/cycles | All |
| `get_cycle_progress` | Sprint progress | All |
| `list_labels` | Label list | All |
| `get_analytics` | Issue stats | All |
| `search_issues` | Full-text search | Workspace-scoped |

### Action Tools (MEMBER+)

| Tool | What | Permission |
|---|---|---|
| `create_issue` | Create issue | Private project → members only |
| `update_issue` | Update fields + due date | Own issues only (unless admin) |
| `assign_issue` | Assign/reassign | Own issues only (unless admin) |
| `add_comment` | Comment on issue | MEMBER+ |
| `add_label_to_issue` | Add label | MEMBER+ |

### Admin Tools (ADMIN/OWNER)

| Tool | What | Permission |
|---|---|---|
| `create_project` | Create project | ADMIN/OWNER only |
| `update_project` | Update project | ADMIN/OWNER or project lead |
| `invite_member` | Send invitation | ADMIN/OWNER only |

### Forbidden (not exposed)

- Delete anything — **never**
- Change roles — **never**
- Workspace settings — **never**
- Billing/payment — **never**

---

## 5. Security Layers

| Layer | What | How |
|---|---|---|
| **Auth** | Clerk JWT | `authenticate` middleware on all routes |
| **Workspace** | Scoping | `requireWorkspace` middleware, workspaceId on every query |
| **Rate limit** | 20 req/min | `strictRateLimiter` |
| **Token budget** | 10K tokens/turn | Counter enforced in tool loop |
| **Tool call limit** | 5 calls/turn | Counter enforced in tool loop |
| **Tool whitelist** | Only known tools | Tool name validated against definitions |
| **Result truncation** | 5K chars max | Large tool results truncated |
| **Private visibility** | Projects + teams | Membership checked for PRIVATE entities |
| **Ownership check** | Issues | MEMBER can only update own/created issues |
| **Input sanitization** | User messages | Control chars + HTML tags stripped |
| **Prompt injection** | System prompt | AI instructed to use IDs from lookup tables, not user input |
| **XSS prevention** | AI output | HTML stripped in AiMarkdown renderer |
| **Issue link validation** | Navigation | Issue ID format validated before `navigate()` |
| **No deletes** | All entities | Delete operations not exposed as tools |

---

## 6. Frontend Components

### TrussenAiPanel

- **Location:** Right side of layout, pushes main content (not overlay)
- **Width:** 360px default, resizable 300-600px via drag handle on left edge
- **Trigger:** "Ask Trussen" button in TopNavbar (between bell + profile)
- **Features:**
  - Chat with streaming AI responses
  - @ mention autocomplete (members, projects, teams, departments, issues)
  - Conversation history (clock icon)
  - New conversation (+ icon)
  - Delete conversation
  - Quick suggestion chips on empty state
  - Tool activity indicators ("Using list_issues...")
  - Tool usage labels under AI messages

### AiMarkdown

- Renders **bold**, *italic*, `code`, code blocks, headings, lists
- Tables converted to **issue cards** (better for narrow panel)
- Issue IDs (FIS-5, VAT-42) rendered as **clickable links**
- Priority/status/type shown as **colored badges**
- Emojis stripped, HTML tags stripped
- No external dependencies

### MentionDropdown

- Shared between AI Issue Creator (20A) and Trussen AI Panel (20B)
- Supports: @name, @project:name, @team:name, @dept:name, @issue:ID
- Smart prefix detection: typing `@pro` suggests completing to `@project:`
- Dropdown appears above input (panel) or below input (issue creator)

---

## 7. Model Configuration

All models configurable via `.env` — zero code changes to switch:

```env
# Default model for Trussen AI Chat
AI_CHAT_MODEL_DEFAULT=deepseek/deepseek-v4-flash

# Fallback chain (tried in order if default fails)
AI_CHAT_MODEL_FALLBACK_1=meta-llama/llama-3.3-70b-instruct:free
AI_CHAT_MODEL_FALLBACK_2=qwen/qwen3-coder:free
AI_CHAT_MODEL_FALLBACK_3=google/gemma-4-31b-it:free
```

### Cost

| Model | Cost per message | 100 users × 10 msgs/day | Monthly |
|---|---|---|---|
| DeepSeek V4 Flash | $0.0006 | 1000 msgs/day | **$18** |
| Free models (fallback) | $0 | — | $0 |
| Claude Sonnet (premium) | $0.021 | — | $630 |

---

## 8. Future Work

### Immediate improvements

- [ ] Workspace AI model setting — admin picks model in Settings
- [ ] Token budget tracking — AiUsage table, per-workspace per-day limits
- [ ] Plan gating — Free: 10 msgs/day, Standard: 100, Premium: unlimited
- [ ] Conversation export — download as markdown/PDF
- [ ] Conversation pinning — star important conversations

### Phase 20C — AI Assistant

- Bottom-right help bubble (different from Trussen AI panel)
- Ephemeral (no conversation history)
- App navigation guidance + brainstorming
- Uses same tools, lighter system prompt

### Phase 20D — Embeddings + Semantic Search

- Enable pgvector in PostgreSQL
- Single `embeddings` table
- Async embedding generation via BullMQ
- New tool: `search_similar_issues` — semantic vector search
- Duplicate detection during issue creation

### Phase 20E — MCP Server (External Agents)

- Expose same tools via `@modelcontextprotocol/sdk`
- Claude Desktop, Cursor, custom agents can connect
- API key auth (Phase 18 keys)
- Same `tool-executor.ts`, different transport

---

## 9. Files Reference

### Backend

| File | Lines | Purpose |
|---|---|---|
| `ai.chat.ts` | ~450 | Chat service: conversations, SSE, tool loop, security |
| `ai.controller.ts` | ~140 | HTTP handlers for chat + conversations |
| `ai.routes.ts` | ~70 | Route definitions with auth + rate limiting |
| `tools/tool-definitions.ts` | ~390 | 20 tool definitions (OpenAI function format) |
| `tools/tool-executor.ts` | ~450 | Tool execution with permissions + workspace isolation |
| `ai.provider.ts` | ~310 | OpenRouter abstraction, model routing, fallback chain |

### Frontend

| File | Lines | Purpose |
|---|---|---|
| `TrussenAiPanel.tsx` | ~470 | Right panel: chat UI, streaming, history, @ mentions |
| `AiMarkdown.tsx` | ~300 | Markdown → React: tables→cards, links, badges, XSS safe |
| `MentionDropdown.tsx` | ~180 | Shared @ mention dropdown for all entity types |
| `useMentionAutocomplete.ts` | ~140 | Shared mention detection + insertion logic |
| `aiService.ts` | ~60 | API calls for chat + conversations |
| `MainLayout.tsx` | ~30 | Panel integration into app layout |
| `TopNavbar.tsx` | ~10 | "Ask Trussen" trigger button |
