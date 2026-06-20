# Phase 20 — AI Architecture (Complete Vision)

> Trussen is not a normal project management tool — it's a **100x productivity multiplier**.
> AI is not a bolt-on feature. It's woven into every surface of the product.

---

## Table of Contents

1. [The Five AI Systems](#the-five-ai-systems)
2. [20A — AI Issue Creator](#20a--ai-issue-creator)
3. [20B — Trussen AI (MCP Panel)](#20b--trussen-ai-mcp-panel)
4. [20C — AI Assistant](#20c--ai-assistant)
5. [20D — Background AI](#20d--background-ai)
6. [20E — MCP Server](#20e--mcp-server)
7. [Shared Backend Infrastructure](#shared-backend-infrastructure)
8. [AI Provider Layer (OpenRouter)](#ai-provider-layer-openrouter)
9. [Embeddings & Vector Search (pgvector)](#embeddings--vector-search-pgvector)
10. [Cost Optimization Strategy](#cost-optimization-strategy)
11. [Token Budget & Plan Gating](#token-budget--plan-gating)
12. [Scalability Roadmap](#scalability-roadmap)
13. [Tech Stack Summary](#tech-stack-summary)
14. [Trust & Accuracy Guarantees](#trust--accuracy-guarantees)
15. [Security & Business Rules](#security--business-rules)
16. [Build Order](#build-order)
17. [Done When](#done-when)

---

## The Five AI Systems

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TRUSSEN AI LAYER                             │
│                                                                     │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────────┐ │
│  │  20A          │  │  20B              │  │  20C                  │ │
│  │  AI Issue     │  │  Trussen AI       │  │  AI Assistant         │ │
│  │  Creator      │  │  (MCP Panel)      │  │  (Help & Navigate)    │ │
│  │              │  │                    │  │                       │ │
│  │  "Create in  │  │  Left panel chat   │  │  Bottom-right helper  │ │
│  │   1-2 lines" │  │  Full workspace    │  │  App guidance,        │ │
│  │              │  │  control via NL     │  │  brainstorming,       │ │
│  │  Issue form  │  │  Conversation      │  │  analytics,           │ │
│  │  auto-fill   │  │  history           │  │  status reports       │ │
│  └──────────────┘  └──────────────────┘  └───────────────────────┘ │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  20D — Background AI (Passive Intelligence)                  │   │
│  │  Auto-assign · Duplicate detection · Smart labels · Sprint   │   │
│  │  planning · Priority suggestions · Stale issue detection     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  20E — MCP Server (External AI Agents)                       │   │
│  │  Claude Desktop · ChatGPT Agents · Cursor · Custom bots     │   │
│  │  Exposes all workspace tools as MCP protocol                 │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Shared Infrastructure                                       │   │
│  │  OpenRouter (AI gateway) · pgvector (embeddings) ·           │   │
│  │  BullMQ (async jobs) · Token budgets · Prompt caching        │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 20A — AI Issue Creator ("Create in 1-2 lines")

**Where:** Create Issue page — a toggle or input at the top

**User flow:**
```
1. User navigates to Create Issue
2. Instead of filling out the form manually, they type:
   "Create an authentication bug — when I click login with Google the app crashes.
    Attach this screenshot. High priority, assign to @sarah"

3. AI processes the natural language input and auto-fills:
   ├── Title: "Google OAuth login crashes on click"
   ├── Type: BUG
   ├── Priority: HIGH
   ├── Assignee: Sarah (resolved from @mention)
   ├── Description: Structured bug report with:
   │   ├── Steps to reproduce
   │   ├── Expected behavior
   │   ├── Actual behavior
   │   └── Environment details (if inferrable)
   ├── Labels: ["authentication", "crash", "google-oauth"] (auto-suggested)
   ├── Attachments: Screenshot attached
   └── Project: Auto-detected from context or asked

4. User reviews the pre-filled form, makes any tweaks, hits Create
```

**What AI decides vs what user confirms:**

| Field | AI fills | User confirms |
|---|---|---|
| Title | Yes — concise, actionable | Can edit |
| Type | Yes — BUG/TASK/ISSUE from context | Can change |
| Priority | Yes — from language cues ("crashes" = HIGH) | Can change |
| Description | Yes — structured format based on type | Can edit |
| Assignee | Yes — from @mention or team context | Can change |
| Labels | Suggested — from title/description NLP | Can accept/reject |
| Project | Suggested — from context or last used | Can change |
| Status | Default (TODO) | Can change |
| Subtasks | Generated if task is complex | Can edit/remove |
| Attachments | Passed through from user input | Can add/remove |

**Template-aware generation:**

If the workspace has active templates (Phase 12), the AI uses them as the output structure instead of its own format. This ensures consistency across the workspace.

```
Flow:
1. AI detects issue type from user prompt (e.g., "bug" → type = BUG)
2. Backend checks: does workspace have an active template for BUG?
   → YES: fetch template structure (fields, sections, default values)
           pass template to AI as the output schema
           AI fills the template fields from the user's description
   → NO:  AI uses its default structured format
3. Result: AI output always matches what the team expects

Example:

User: "Google login crashes on Android when clicking sign in button"

Workspace has active BUG template with:
  - Title (required)
  - Steps to Reproduce (required)
  - Expected Behavior (required)  
  - Actual Behavior (required)
  - Severity (required)
  - Environment (optional)
  - Screenshots (optional)

AI generates using the template structure:
  Title: "Google OAuth login crashes on Android"
  Steps to Reproduce:
    1. Open app on Android device
    2. Navigate to login screen
    3. Tap "Sign in with Google" button
    4. App crashes immediately
  Expected Behavior: Google OAuth consent screen should appear
  Actual Behavior: App crashes with no error message
  Severity: HIGH
  Environment: Android (version unspecified)
```

Template lookup is a **single DB query** — no AI cost. The template structure is injected into the system prompt so the AI knows exactly what fields to fill.

**Backend endpoint:**
```
POST /ai/generate-issue
Body: { prompt: string, attachments?: string[], workspaceId: string }

Response: {
  title: string,
  type: "task" | "bug" | "issue",
  priority: "low" | "medium" | "high" | "urgent",
  description: string,
  suggestedLabels: string[],
  suggestedAssigneeId?: string,
  suggestedProjectId?: string,
  subtasks?: { title: string }[],
  // Template-specific fields (populated when active template exists)
  templateId?: string,           // ID of the matched template
  templateFields?: Record<string, string>,  // Filled template fields
  // Bug-specific (fallback when no template)
  stepsToReproduce?: string,
  expectedBehavior?: string,
  actualBehavior?: string,
  severity?: "low" | "medium" | "high",
}
```

**Internal flow:**
```
User prompt
  → Rule-based pre-processing (detect type/priority for free)
  → Backend fetches:
      - Minimal workspace context (project names, member names, labels)
      - Active template for detected type (if exists)
  → Build system prompt:
      - If template exists: "Fill these template fields: {fields}"
      - If no template: "Generate structured issue with title, description, etc."
  → OpenRouter → Claude Sonnet (with compact prompt + context + template)
  → Claude returns structured JSON (matching template or default format)
  → Backend validates + resolves @mentions to user IDs
  → Returns pre-filled issue data to frontend
  → Frontend populates the Create Issue form (with template fields pre-mapped)
  → User reviews and submits
```

---

## 20B — Trussen AI (MCP Panel — Full Workspace Control)

**Where:** Left panel (like VS Code's AI panel) — persistent, conversational

**This is the power tool.** It's a conversational interface backed by MCP tools that can read and write everything in the workspace — within the user's permission level.

**UI:**
```
┌──────────────────────────────────────────────────────────────┐
│ [Sidebar]  │ [Main Content]                                  │
│            │                                                  │
│ Dashboard  │  ┌─────────────────────────────────────────────┐│
│ Issues     │  │         TRUSSEN AI                          ││
│ Projects   │  │                                             ││
│ Teams      │  │  ┌─────────────────────────────────────┐    ││
│ ...        │  │  │ Previous conversations               │    ││
│            │  │  │  • Sprint planning (2h ago)          │    ││
│            │  │  │  • Bug triage (yesterday)            │    ││
│            │  │  │  • Team workload review (3 days ago) │    ││
│            │  │  └─────────────────────────────────────┘    ││
│            │  │                                             ││
│            │  │  You: List all urgent issues assigned to me ││
│            │  │                                             ││
│            │  │  AI: You have 3 urgent issues:              ││
│            │  │  1. VAT-42 — Login crash (REVIEW)           ││
│            │  │  2. VAT-55 — Payment timeout (IN_PROGRESS)  ││
│            │  │  3. VAT-61 — Data loss on save (TODO)       ││
│            │  │                                             ││
│            │  │  You: Create a bug "API returns 500 on       ││
│            │  │        /users endpoint" assign to @john       ││
│            │  │        priority urgent                        ││
│            │  │                                             ││
│            │  │  AI: Created VAT-78 — "API returns 500..."  ││
│            │  │  ✅ Assigned to John · Priority: Urgent     ││
│            │  │  [View Issue →]                              ││
│            │  │                                             ││
│            │  │  ┌─────────────────────────────────────┐    ││
│            │  │  │ Type a message...              [Send]│    ││
│            │  │  └─────────────────────────────────────┘    ││
│            │  └─────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

**Capabilities:**

| Category | Example Prompts |
|---|---|
| **Query** | "Show my issues sorted by priority" |
| **Query** | "How many bugs are open in the Mobile App project?" |
| **Query** | "Who has the most issues this sprint?" |
| **Create** | "Create a task: Add dark mode to settings, assign to @sara, medium priority" |
| **Create** | "Create a bug: app crashes on login, urgent" |
| **Update** | "Move VAT-42 to done" |
| **Update** | "Change priority of VAT-55 to high" |
| **Update** | "Assign VAT-61 to @mike" |
| **Comment** | "Add a comment on VAT-42: Fixed in PR #123" |
| **Analytics** | "Show velocity of the Backend team over last 3 sprints" |
| **Analytics** | "What's our bug rate this month vs last month?" |
| **Planning** | "What should we put in the next sprint?" |
| **Planning** | "Are there any blockers in the current sprint?" |
| **Search** | "Find issues related to authentication" |
| **Report** | "Give me a standup summary for today" |
| **Report** | "Generate a weekly report for the Backend team" |

**Conversation persistence:**
```prisma
model AiConversation {
  id          String   @id @default(uuid())
  userId      String
  workspaceId String
  title       String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  messages  AiMessage[]

  @@index([userId, workspaceId])
  @@index([updatedAt])
}

model AiMessage {
  id             String        @id @default(uuid())
  conversationId String
  role           AiMessageRole
  content        String        @db.Text
  toolCalls      Json?
  toolResults    Json?
  createdAt      DateTime      @default(now())

  conversation AiConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId, createdAt])
}

enum AiMessageRole {
  USER
  ASSISTANT
  TOOL_CALL
  TOOL_RESULT
}
```

**Backend endpoint (streamed via SSE):**
```
POST /ai/chat
Body: {
  conversationId?: string,
  message: string,
  mentions?: string[],
}

Response (Server-Sent Events):
  event: message     → { role: "assistant", content: "chunk..." }
  event: tool_call   → { tool: "create_issue", args: {...}, result: {...} }
  event: done        → { conversationId: "..." }
```

---

## 20C — AI Assistant (Help & Navigate)

**Where:** Bottom-right floating button — context-aware helper

**This is NOT the MCP panel.** This is a lightweight assistant for:
- **App guidance** — "How do I create a project?" "Where are my notifications?"
- **Brainstorming** — "Help me break down this feature into tasks"
- **Status reports** — "What did my team accomplish this week?"
- **@ mentions** — "What's @john working on?" "Show @backend-team workload"
- **Analytics on demand** — "What's our velocity?" "How many bugs did we ship?"
- **Navigation** — "Take me to project settings" → navigates the app

| | Trussen AI (20B) | AI Assistant (20C) |
|---|---|---|
| Location | Left panel (persistent) | Bottom-right bubble (ephemeral) |
| Purpose | Workspace control & execution | Help, guidance, brainstorming |
| Conversation history | Full history, resumable | Ephemeral (resets per session) |
| Can create/update data | Yes (full MCP tools) | Limited (mostly read, can suggest) |
| When to use | "Do this for me" | "Help me understand / plan" |

**Brainstorming mode:**
```
User: Help me break down the "User Authentication" feature

AI: Here's a breakdown:

📋 Epic: User Authentication
├── Task: Set up Clerk integration
│   └── Subtask: Configure OAuth providers (Google, GitHub)
├── Task: Build login page
│   ├── Subtask: Design login form
│   ├── Subtask: Add social login buttons
│   └── Subtask: Handle error states
├── Task: Build signup flow
│   ├── Subtask: Email verification
│   └── Subtask: Workspace creation after signup
├── Task: Session management
│   └── Subtask: JWT refresh handling
└── Bug buffer: Reserve 20% capacity for auth-related bugs

Want me to create these as issues in your workspace?
[Create All] [Edit First] [Cancel]
```

---

## 20D — Background AI (Passive Intelligence)

These features run automatically — no user interaction needed.

| Feature | Trigger | What it does | AI or Rule-Based? |
|---|---|---|---|
| **Auto-assign suggestion** | Issue created without assignee | Suggests 1-3 assignees based on expertise + workload | Rule-based first → AI if ambiguous |
| **Duplicate detection** | Issue created | Vector search against existing issues → flags top 3 if similarity > 85% | pgvector (no AI call) |
| **Smart label suggestion** | Issue created/updated | Suggests labels from title/description | Rule-based keyword match first → Haiku if no match |
| **Priority suggestion** | Issue created with default priority | Detects urgency from language cues | Rule-based regex (free) |
| **Stale issue detection** | Daily cron | Issues IN_PROGRESS for > 7 days with no activity → notification | SQL query (free) |
| **Weekly digest** | Weekly cron | Team/workspace summary | Template-based from DB aggregates (free) |
| **Sprint planning assist** | New cycle created | Suggests issues for sprint based on priority + velocity | Sonnet (paid) |

**Cost impact:** 5 of 7 background features are **free** (rule-based or SQL). Only sprint planning uses AI.

---

## 20E — MCP Server (External AI Agents)

**For:** Claude Desktop, ChatGPT Agents, Cursor, Windsurf, custom AI bots

**How MCP works:**
```
Without MCP:
  User → Claude Desktop → "Create a bug" → Claude: "I can't access your database"

With MCP:
  User → Claude Desktop → MCP Server → Trussen Backend → Database
  Claude can actually perform actions.
```

**Authenticates via:** API keys (Phase 18) or Clerk session

**MCP is free** — just `npm install @modelcontextprotocol/sdk`. No license, no subscription.

**V1 Tools (start small — 10 tools):**

| Tool | Action | Parameters |
|---|---|---|
| `list_issues` | Query issues with filters | status, assignee, project, priority, limit |
| `get_issue` | Get full issue detail | issueId |
| `create_issue` | Create a new issue | title, type, project, priority, assignee, description |
| `update_issue_status` | Move issue through workflow | issueId, status |
| `assign_issue` | Assign issue to a user | issueId, userId |
| `add_comment` | Post a comment on an issue | issueId, body |
| `list_projects` | List projects with status | teamId?, status? |
| `list_cycles` | List sprints/cycles | teamId?, status? |
| `list_members` | List workspace members | — |
| `search_issues` | Full-text + semantic search | query, scope? |

**Module structure:**
```
mcp/
├── server.ts                 # MCP server setup (stdio or SSE transport)
├── auth.ts                   # API key / session auth
├── tools/
│   ├── issues.ts             # list, get, create, update, assign, change_status
│   ├── projects.ts           # list, get_status
│   ├── cycles.ts             # get_current, get_progress
│   ├── members.ts            # list, get_workload
│   ├── comments.ts           # add, list
│   ├── labels.ts             # list, suggest
│   ├── search.ts             # full-text + semantic search
│   └── analytics.ts          # velocity, bug_rate, team_stats
└── resources/
    ├── workspace.ts           # Workspace summary
    ├── issue.ts               # Issue detail
    ├── project.ts             # Project summary
    └── cycle.ts               # Current sprint
```

**Who can connect:**
- Claude Desktop
- ChatGPT Agents (OpenAI)
- Cursor / Windsurf
- Custom AI agents
- Internal company bots
- Automation pipelines

You build the tools **once**. Every MCP-compatible client can use them.

---

## Shared Backend Infrastructure

All five AI systems share common backend infrastructure:

```
modules/ai/
├── ai.routes.ts              # /ai/generate-issue, /ai/chat, /ai/assist
├── ai.controller.ts
├── ai.service.ts             # Core AI orchestration
├── ai.schemas.ts
├── ai.provider.ts            # OpenRouter abstraction layer
├── ai.context.ts             # Build minimal workspace context per task
├── ai.permissions.ts         # Verify AI actions against user permissions
├── ai.streaming.ts           # SSE streaming for chat responses
├── ai.budget.ts              # Token budget tracking + enforcement
├── ai.rules.ts               # Rule-based detection (priority, type, labels) — free
└── ai.cache.ts               # Result caching + context caching

modules/ai/tools/              # Shared tool definitions (used by MCP + in-app AI)
├── issue-tools.ts
├── project-tools.ts
├── cycle-tools.ts
├── member-tools.ts
├── comment-tools.ts
├── label-tools.ts
├── search-tools.ts
├── analytics-tools.ts
└── navigation-tools.ts
```

**Key principle:** Tools are defined **ONCE** and shared. MCP server, Trussen AI panel, AI Assistant, and Background AI all call the same tool functions. The only difference is:
- **Who triggers them** (user chat, MCP client, background job)
- **What permissions they run with** (user's own permissions)
- **How results are delivered** (JSON, SSE stream, notification)

---

## AI Provider Layer (OpenRouter)

**Why OpenRouter:** One API, any model, no vendor lock-in, same price as going direct.

```
Your Backend
    ↓
OpenRouter API (one endpoint, one API key)
    ↓
┌─────────────┬──────────────┬──────────────┬──────────────┐
│ Claude       │ GPT-4o       │ Gemini       │ DeepSeek     │
│ Sonnet/Haiku │ Mini/o1      │ Flash/Pro    │ V3/R1        │
│ (Anthropic)  │ (OpenAI)     │ (Google)     │ (DeepSeek)   │
└─────────────┴──────────────┴──────────────┴──────────────┘
```

**Provider abstraction:**

```typescript
// ai.provider.ts — one file, all AI calls go through here

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// Model routing per task type — cheapest model that works
const TASK_MODELS: Record<string, string> = {
  // Tier 1 — Haiku ($0.006/call) — structured extraction, simple queries
  suggest_labels:    'anthropic/claude-haiku-3.5',
  suggest_priority:  'anthropic/claude-haiku-3.5',
  detect_type:       'anthropic/claude-haiku-3.5',
  simple_query:      'anthropic/claude-haiku-3.5',
  navigation_help:   'anthropic/claude-haiku-3.5',
  extract_assignee:  'anthropic/claude-haiku-3.5',

  // Tier 2 — Sonnet ($0.02/call) — generation, reasoning
  generate_issue:    'anthropic/claude-sonnet-4',
  brainstorm:        'anthropic/claude-sonnet-4',
  chat_response:     'anthropic/claude-sonnet-4',
  sprint_summary:    'anthropic/claude-sonnet-4',
  duplicate_check:   'anthropic/claude-sonnet-4',

  // Tier 3 — Gemini Flash ($0.001/call) — bulk reports
  weekly_report:     'google/gemini-2.5-flash',
  standup_summary:   'google/gemini-2.5-flash',

  // Embeddings
  embeddings:        'openai/text-embedding-3-small',
};

async function callAI(taskType: string, messages: Message[], maxTokens = 1024) {
  const model = TASK_MODELS[taskType] ?? 'anthropic/claude-sonnet-4';

  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://trussen.app',
      'X-Title': 'Trussen',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });

  return response.json();
}
```

**Pricing (via OpenRouter — same as direct):**

| Model | Input / 1M tokens | Output / 1M tokens | Cost per typical call | Use for |
|---|---|---|---|---|
| Claude Haiku 3.5 | $0.80 | $4.00 | ~$0.006 | Labels, priority, type detection |
| Claude Sonnet 4 | $3.00 | $15.00 | ~$0.020 | Issue generation, chat, brainstorming |
| Gemini 2.5 Flash | $0.15 | $0.60 | ~$0.001 | Reports, summaries |
| GPT-4o Mini | $0.15 | $0.60 | ~$0.001 | Alternative for reports |
| text-embedding-3-small | $0.02 | — | ~$0.0001 | Vector embeddings |

---

## Embeddings & Vector Search (pgvector)

**No separate vector database needed.** pgvector runs inside existing PostgreSQL.

### How it works

```
Issue created: "Google login crashes on Android"
    ↓
Background job (BullMQ)
    ↓
OpenRouter → text-embedding-3-small → [0.12, -0.44, 0.88, ...] (1536 dimensions)
    ↓
Saved to embeddings table in PostgreSQL
```

### Single shared embeddings table (not one per entity)

```sql
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- One table for all entities — issues, comments, docs, etc.
CREATE TABLE embeddings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  entity_type  TEXT NOT NULL,    -- 'issue', 'comment', 'document'
  entity_id    UUID NOT NULL,
  content      TEXT NOT NULL,    -- The text that was embedded
  embedding    vector(1536),     -- OpenAI text-embedding-3-small dimension
  created_at   TIMESTAMP DEFAULT now(),
  updated_at   TIMESTAMP DEFAULT now()
);

-- Vector similarity index
CREATE INDEX embeddings_vector_idx
  ON embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Lookup indexes
CREATE INDEX embeddings_workspace_entity_idx
  ON embeddings (workspace_id, entity_type);

CREATE UNIQUE INDEX embeddings_entity_unique_idx
  ON embeddings (entity_type, entity_id);
```

### Duplicate detection flow

```
User starts creating: "Google auth crashes after clicking login"
    ↓
Backend generates embedding for new text
    ↓
Search embeddings table for similar vectors in same workspace
    ↓
SQL:
  SELECT entity_id, content,
         1 - (embedding <=> $1::vector) AS similarity
  FROM embeddings
  WHERE workspace_id = $2 AND entity_type = 'issue'
  ORDER BY embedding <=> $1::vector
  LIMIT 5
    ↓
Result: "TRS-42 — Google login crashes on Android" (91% similar)
    ↓
Show to user: "Possible duplicate detected"
```

### What gets embedded (V1 → V3)

| Version | Entities | Why |
|---|---|---|
| **V1** | Issues (title + description) | Duplicate detection, semantic search |
| **V2** | + Comments, Documents | Cross-entity search ("find everything about auth") |
| **V3** | + GitHub PRs, Slack messages | Full workspace knowledge graph |

### Async embedding generation (BullMQ)

```
Issue created → save issue immediately → queue embedding job → worker generates embedding → save
```

User never waits for embeddings. The queue processes them in the background.

---

## Cost Optimization Strategy

### Layer 1: Don't use AI when you don't need it (FREE)

```typescript
// Priority detection — free, no AI call needed
function detectPriority(text: string): string | null {
  const lower = text.toLowerCase();
  if (/crash|down|data.?loss|security|production|urgent|asap|critical/i.test(lower)) return 'urgent';
  if (/broken|fail|error|bug|doesn.?t work|can.?t/i.test(lower)) return 'high';
  if (/nice.?to.?have|enhancement|improvement|would be|eventually/i.test(lower)) return 'low';
  return null; // Only call AI if rule-based fails
}

// Type detection — free, no AI call needed
function detectType(text: string): string | null {
  const lower = text.toLowerCase();
  if (/bug|crash|error|broken|fix|doesn.?t work|regression/i.test(lower)) return 'bug';
  if (/add|create|build|implement|feature|new/i.test(lower)) return 'task';
  return null; // Only call AI if ambiguous
}
```

**This eliminates 30-40% of AI calls.**

| Feature | AI Approach (paid) | Rule-Based (free) |
|---|---|---|
| Priority detection | Haiku NLP | Regex keyword match |
| Type detection | Haiku classification | Regex keyword match |
| Label suggestion | Haiku NLP | TF-IDF / keyword matching |
| Duplicate detection | AI reasoning | pgvector similarity (no AI call) |
| Issue queries | Parse NL with AI | Direct DB queries (already built) |
| Stale issue detection | AI pattern analysis | SQL: `WHERE updatedAt < 7 days ago` |
| Standup summary | AI prose generation | Template from DB aggregates |

### Layer 2: Route to cheapest model (50% savings)

```
Tier 1: Haiku 3.5   → $0.006/call  → 30% of requests (simple extraction)
Tier 2: Sonnet 4    → $0.020/call  → 55% of requests (generation/reasoning)
Tier 3: Gemini Flash → $0.001/call  → 10% of requests (reports/summaries)
Rule-based           → $0.000/call  →  5% of requests (regex/SQL)

Weighted average: ~$0.01/call (vs $0.02 for Sonnet-only)
```

### Layer 3: Minimize context tokens (60-70% savings)

Send ONLY what the task needs:

| Task | Context sent | Tokens |
|---|---|---|
| Generate issue | Project names + member names + labels | ~500 |
| Suggest labels | Existing label names only | ~100 |
| Suggest assignee | Team members + open issue counts | ~300 |
| Chat query | Conversation history (last 10 messages) | ~2,000 |

**NOT the full workspace state (~5,000+ tokens) every time.**

### Layer 4: Cache everything (20-30% savings)

```typescript
// Prompt caching — 90% discount on repeated system prompts (Claude API feature)
cache_control: { type: 'ephemeral' }  // Cache for 5 minutes

// Result caching — same input = cached output
const AI_CACHE_TTL = {
  suggest_labels: 3600,        // 1 hour
  navigation_help: 86400,      // 24 hours
  generate_issue: 0,           // No cache (unique prompts)
};

// Context caching — workspace state doesn't change every request
const contextCache = new Map();  // In-memory, 5-minute TTL
```

### Layer 5: Cap output tokens

| Task | Max output tokens | Why |
|---|---|---|
| Issue generation | 500 | Title + description + fields = ~300-500 tokens |
| Label suggestion | 100 | Just a JSON array of strings |
| Chat response | 1024 | Conversational but bounded |
| Weekly report | 2048 | Longer but capped |

Never use the default 4096.

### Layer 6: Token budget per plan

```typescript
const PLAN_BUDGETS = {
  FREE:     { dailyInput: 10_000,    dailyOutput: 5_000 },     // ~5 generations
  STANDARD: { dailyInput: 200_000,   dailyOutput: 100_000 },   // ~100 generations
  PREMIUM:  { dailyInput: 2_000_000, dailyOutput: 1_000_000 }, // ~1000 generations
};
```

Track per workspace per day. Enforce before each AI call.

### Combined effect: 70-80% cost reduction

| | Naive (Sonnet for all) | Optimized (all 6 layers) |
|---|---|---|
| Cost per 5-user workspace/month | $30 | **$7.20** |
| 100 users | $600/month AI cost | **$77/month** |
| 1,000 workspaces/year | $360,000 | **$86,400** |

---

## Token Budget & Plan Gating

| Feature | Free | Standard ($6/user) | Premium ($12/user) |
|---|---|---|---|
| AI Issue Creator | 5/day | 50/day | Unlimited |
| Trussen AI Panel | — | 100 messages/day | Unlimited |
| AI Assistant | 10/day | 50/day | Unlimited |
| Background AI | — | Basic (labels only) | Full |
| MCP Server access | — | Read-only | Full read/write |
| Conversation history | — | 7 days | 90 days |
| Duplicate detection | — | Basic (text match) | Semantic (vector) |

**Schema for tracking:**
```prisma
model AiUsage {
  id           String   @id @default(uuid())
  workspaceId  String
  date         DateTime @db.Date
  inputTokens  Int      @default(0)
  outputTokens Int      @default(0)
  requestCount Int      @default(0)

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, date])
  @@index([workspaceId])
}
```

---

## Scalability Roadmap

### Stage 1: Launch (0-100 users)

```
PostgreSQL + pgvector (embeddings in same DB)
OpenRouter → Claude Sonnet/Haiku
BullMQ + Redis (async embedding jobs)
Single server (DigitalOcean $24/month)

Total: ~$50-110/month
```

### Stage 2: Growth (100-1,000 users)

```
Split AI workloads across models:
  Claude → issue generation, chat
  Gemini Flash → reports, summaries
  Haiku → all simple extraction

Add Redis caching for AI results
Add connection pooling (PgBouncer)
Upgrade server ($48/month)

Total: ~$200-500/month
```

### Stage 3: Scale (1,000-10,000 users)

```
Move embeddings to dedicated vector DB (Qdrant/Pinecone)
  — Only the embeddings table moves, everything else stays in Postgres
  — Same API, just different storage backend

Add dedicated BullMQ worker server
Add CDN for static assets
Horizontal scaling (multiple API servers behind load balancer)

Total: ~$1,000-3,000/month
```

### Stage 4: Enterprise (10,000+ users)

```
Multi-region deployment
Dedicated GPU for self-hosted models (reports/summaries only)
Custom fine-tuned models for domain-specific tasks
Enterprise SSO for MCP connections
Audit logging for all AI actions

Total: negotiated enterprise contracts
```

**Key principle:** The architecture never needs a rewrite. Each stage adds capacity without changing the codebase:
- pgvector → Qdrant is a storage swap, not a code rewrite
- Single server → multiple servers is infrastructure, not code
- Adding a new model is changing one string in the task routing map

---

## Tech Stack Summary

| Component | Technology | Cost | When |
|---|---|---|---|
| **AI Gateway** | OpenRouter | Per-token (same as direct) | Day 1 |
| **Primary LLM** | Claude Sonnet 4 (via OpenRouter) | $3/$15 per 1M tokens | Day 1 |
| **Cheap LLM** | Claude Haiku 3.5 (via OpenRouter) | $0.80/$4 per 1M tokens | Day 1 |
| **Report LLM** | Gemini 2.5 Flash (via OpenRouter) | $0.15/$0.60 per 1M tokens | Stage 2 |
| **Embeddings** | OpenAI text-embedding-3-small (via OpenRouter) | $0.02 per 1M tokens | 20D |
| **Vector DB** | pgvector (PostgreSQL extension) | Free (in existing DB) | 20D |
| **MCP Server** | @modelcontextprotocol/sdk | Free (open source) | 20E |
| **Async Jobs** | BullMQ + Redis | Redis: $0-15/month | 20D |
| **Streaming** | Server-Sent Events (Express) | Free (built-in) | 20B |
| **Conversation DB** | Prisma (AiConversation, AiMessage) | Free (in existing DB) | 20B |

**Total new infrastructure cost: $0-15/month** (Redis for BullMQ). Everything else runs on existing PostgreSQL and server.

---

## Trust & Accuracy Guarantees

> The AI must be **trustable, not generic**. Users rely on its output for real work.

### Core Principle: RAG Over Hallucination

AI never guesses. It always works from **real workspace data** (Retrieval-Augmented Generation):

```
User: "Who has the most issues this sprint?"

BAD (hallucination):
  "Sarah probably has the most since she's the team lead."

GOOD (RAG — real data):
  AI calls get_team_workload() tool
  → DB returns: Sarah: 22, John: 5, Mike: 8
  → AI responds: "Sarah has 22 active issues. John has 5. Mike has 8."
```

**If AI doesn't have data, it says so:**
```
"I don't have enough workspace data to answer that. 
Try specifying a team or project."
```

### The AI Execution Chain (How Every Request Flows)

```
User Input
    ↓
┌─────────────────────────────────────────┐
│ Step 1: RULE-BASED PRE-PROCESSING      │  ← FREE, no AI call
│                                         │
│ • Detect type via regex (bug/task)      │
│ • Detect priority via keywords          │
│ • Resolve @mentions to user IDs         │
│ • Parse known patterns (issue IDs)      │
│                                         │
│ If fully resolved → skip AI, return     │
└─────────────────────────────────────────┘
    ↓ (only if rule-based isn't enough)
┌─────────────────────────────────────────┐
│ Step 2: CONTEXT RETRIEVAL (RAG)         │  ← DB queries, cheap
│                                         │
│ • Fetch minimal workspace context       │
│   (project names, member names, labels) │
│ • pgvector search for related issues    │
│ • Recent activity for relevant entities │
│                                         │
│ Only fetch what THIS task needs         │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ Step 3: AI CALL (OpenRouter)            │  ← Paid, minimized
│                                         │
│ • Route to cheapest model for task type │
│ • Compact system prompt (no bloat)      │
│ • Real context from Step 2 (not guesses)│
│ • Force JSON output (no prose)          │
│ • Cap max_tokens per task type          │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ Step 4: VALIDATION & SAFETY             │  ← FREE
│                                         │
│ • Parse AI response as JSON             │
│ • Validate with Zod schema              │
│ • Verify referenced IDs exist in DB     │
│   (user IDs, project IDs, label names)  │
│ • Strip any hallucinated references     │
│ • Check permissions for any actions     │
│ • Reject if validation fails            │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ Step 5: EXECUTE & LOG                   │  ← Via existing services
│                                         │
│ • AI NEVER writes to DB directly        │
│ • AI calls existing backend services:   │
│   issueService.create()                 │
│   issueService.update()                 │
│   commentService.create()               │
│ • Log Activity with triggeredBy: "ai"   │
│ • Track token usage in AiUsage table    │
│ • Return result to user                 │
└─────────────────────────────────────────┘
```

### Trust Rules (Non-Negotiable)

| Rule | Why |
|---|---|
| **AI never writes to DB directly** | Must call existing services (issueService, commentService, etc.) which enforce all business rules |
| **AI output validated with Zod** | Every AI response is parsed and validated before any action is taken. Invalid = rejected |
| **All referenced IDs verified** | If AI says "assign to user X", verify X exists in the workspace before executing |
| **Hallucinated references stripped** | If AI suggests a label that doesn't exist, flag it as "new suggestion" not "existing label" |
| **Permissions checked per action** | AI calling create_issue checks if user has MEMBER+ role. AI calling delete_issue checks ADMIN+ |
| **User confirms destructive actions** | AI can suggest "delete issue VAT-42" but never executes without explicit user confirmation |
| **RAG-grounded responses** | AI always works from fetched workspace data, never from its training data about "how project management usually works" |
| **Uncertainty disclosed** | If AI is <80% confident, it says "I'm not sure — here's what I found: ..." |

### Validation Schema Example

```typescript
// Every AI response is validated before acting on it
const generateIssueResponseSchema = z.object({
  title: z.string().min(1).max(500),
  type: z.enum(['task', 'bug', 'issue']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  description: z.string().max(50000),
  suggestedLabels: z.array(z.string().max(80)).max(10),
  suggestedAssigneeId: z.string().optional(),
  suggestedProjectId: z.string().optional(),
  subtasks: z.array(z.object({ title: z.string().min(1).max(500) })).max(20).optional(),
  stepsToReproduce: z.string().optional(),
  expectedBehavior: z.string().optional(),
  actualBehavior: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high']).optional(),
});

// After AI returns, validate
const parsed = generateIssueResponseSchema.safeParse(aiResponse);
if (!parsed.success) {
  throw new AppError(502, 'AI_RESPONSE_INVALID', 'AI returned an invalid response. Please try again.');
}

// Verify referenced IDs exist
if (parsed.data.suggestedAssigneeId) {
  const member = await prisma.workspaceMembership.findFirst({
    where: { userId: parsed.data.suggestedAssigneeId, workspaceId },
  });
  if (!member) parsed.data.suggestedAssigneeId = undefined; // Strip hallucinated reference
}
```

---

## Security & Business Rules

1. **AI never acts autonomously** — every action requires user initiation (except background suggestions which are non-destructive read-only)
2. **AI never writes to DB directly** — must call existing backend services which enforce all business rules, validation, and middleware
3. **Permission-scoped** — AI runs with the authenticated user's permission level, never elevated
4. **Activity logging** — every AI-initiated action creates an Activity entry with `metadata.triggeredBy: "ai"`
5. **Rate limiting** — token budget per plan tier, not just request count
6. **No data training** — workspace data is NEVER used to train models (OpenRouter/Claude API don't train on inputs)
7. **Audit trail** — AI conversations are stored and queryable by workspace admins
8. **Kill switch** — workspace admins can disable AI features entirely via workspace settings
9. **Content filtering** — AI refuses to generate harmful, discriminatory, or inappropriate content
10. **Error handling** — if AI fails, the user can always fall back to manual operation
11. **Transparency** — AI-generated content is always labeled as such
12. **MCP permissions** — MCP server enforces the same permission matrix as REST API. AI agents cannot do anything the authenticated user can't do themselves
13. **Token isolation** — workspace A's token budget never affects workspace B
14. **Zod validation** — every AI response is validated with a Zod schema before any action is taken. Invalid responses are rejected, not silently accepted
15. **Reference verification** — all user IDs, project IDs, and label names returned by AI are verified against the database. Hallucinated references are stripped
16. **User confirmation for destructive actions** — AI can suggest delete/bulk-update but never executes without explicit "Confirm" from the user

---

## Build Order

```
Phase 1: AI Issue Creator (20A)          — standalone, 1 endpoint, high impact
    ↓
Phase 2: pgvector + Embeddings (20D)     — duplicate detection for issue creation
    ↓
Phase 3: Token Budget + Plan Gating      — enforce limits before scaling
    ↓
Phase 4: Shared AI Tools Layer           — tool definitions used by MCP + chat
    ↓
Phase 5: MCP Server (20E)               — external agents (Claude Desktop, etc.)
    ↓
Phase 6: Trussen AI Panel (20B)          — conversational UI with SSE streaming
    ↓
Phase 7: AI Assistant (20C)              — lightweight help + brainstorming
    ↓
Phase 8: Background AI (20D remaining)   — cron jobs, async workers
```

**Why this order:**
- 20A first → immediate user value, validates the OpenRouter integration
- Embeddings before MCP → duplicate detection works for issue creation
- Token budget before MCP → cost controls in place before agents can burn budget
- Tools before Panel → Panel uses tools; building panel without tools = empty shell
- MCP before Panel → MCP tools ARE the Panel's backend; Panel is just UI on top
- Assistant after Panel → reuses same tools, lighter scope
- Background last → non-interactive, can ship anytime

---

## Done When

- [ ] OpenRouter integration working with model routing
- [ ] Rule-based priority/type detection (free, no AI call)
- [ ] AI Issue Creator generates structured issues from 1-2 line descriptions
- [ ] Token budget tracking and enforcement per workspace per day
- [ ] Plan-based gating works (Free vs Standard vs Premium)
- [ ] pgvector enabled, embeddings table created
- [ ] Async embedding generation via BullMQ
- [ ] Duplicate detection flags similar issues on creation
- [ ] MCP server starts and exposes 10 V1 tools
- [ ] Claude Desktop can connect and manage issues via MCP
- [ ] API key authentication works for MCP sessions
- [ ] All MCP tools respect workspace scoping and permissions
- [ ] Trussen AI panel: conversational chat with SSE streaming
- [ ] Trussen AI panel: conversation history (create, resume, list)
- [ ] Trussen AI panel: can create, query, update issues via natural language
- [ ] AI Assistant: app navigation help
- [ ] AI Assistant: brainstorming mode with "Create All" action
- [ ] AI actions appear in the activity feed with `triggeredBy: "ai"`
- [ ] Workspace admins can disable AI features (kill switch)
- [ ] Background: stale issue detection (SQL cron, free)
- [ ] Background: weekly digest (template-based, free)
- [ ] Background: sprint planning assist (Sonnet, paid)
