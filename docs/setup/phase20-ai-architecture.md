# Phase 20 — AI Architecture (Complete Vision)

> Trussen is not a normal project management tool — it's a **100x productivity multiplier**.
> AI is not a bolt-on feature. It's woven into every surface of the product.

---

## The Three AI Systems

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TRUSSEN AI LAYER                            │
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
│  │  Claude Desktop · Custom agents · API key auth               │   │
│  │  Exposes all workspace tools as MCP protocol                 │   │
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

**Backend endpoint:**
```
POST /ai/generate-issue
Body: { prompt: string, attachments?: string[], workspaceId: string }

Response: {
  title: string,
  type: "task" | "bug" | "issue",
  priority: "low" | "medium" | "high" | "urgent",
  description: string,          // Rich text / markdown
  suggestedLabels: string[],    // Label names (may not exist yet)
  suggestedAssigneeId?: string, // Resolved from @mention
  suggestedProjectId?: string,  // Best guess from context
  subtasks?: { title: string }[],
  // Bug-specific (when type = bug)
  stepsToReproduce?: string,
  expectedBehavior?: string,
  actualBehavior?: string,
  severity?: "low" | "medium" | "high",
}
```

**How it works internally:**
```
User prompt
  → Backend receives prompt + attachments + workspace context
  → Backend fetches workspace context (projects, members, labels, recent issues)
  → Sends to Claude API with system prompt:
      "You are a project management assistant. Given the user's description,
       generate a structured issue. The workspace has these projects: [...],
       these members: [...], these labels: [...]"
  → Claude returns structured JSON
  → Backend validates + resolves @mentions to user IDs
  → Returns pre-filled issue data to frontend
  → Frontend populates the Create Issue form
  → User reviews and submits
```

---

## 20B — Trussen AI (MCP Panel — Full Workspace Control)

**Where:** Left panel (like VS Code's AI panel) — persistent, conversational

**This is the power tool.** It's a conversational interface backed by an MCP server that can read and write everything in the workspace — within the user's permission level.

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
│            │  │  Today's conversation:                      ││
│            │  │                                             ││
│            │  │  You: List all urgent issues assigned to me ││
│            │  │                                             ││
│            │  │  AI: You have 3 urgent issues:              ││
│            │  │  1. VAT-42 — Login crash (REVIEW)           ││
│            │  │  2. VAT-55 — Payment timeout (IN_PROGRESS)  ││
│            │  │  3. VAT-61 — Data loss on save (TODO)       ││
│            │  │                                             ││
│            │  │  You: Create a bug "API returns 500 on       ││
│            │  │        /users endpoint when email has        ││
│            │  │        special chars" assign to @john         ││
│            │  │        priority urgent                        ││
│            │  │                                             ││
│            │  │  AI: Created VAT-78 — "API returns 500..."  ││
│            │  │  ✅ Assigned to John                        ││
│            │  │  ✅ Priority: Urgent                        ││
│            │  │  ✅ Type: Bug                               ││
│            │  │  [View Issue →]                              ││
│            │  │                                             ││
│            │  │  ┌─────────────────────────────────────┐    ││
│            │  │  │ Type a message...              [Send]│    ││
│            │  │  └─────────────────────────────────────┘    ││
│            │  └─────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

**Capabilities (what user can do via natural language):**

| Category | Example Prompts |
|---|---|
| **Query** | "Show my issues sorted by priority" |
| **Query** | "What's the status of VAT-42?" |
| **Query** | "How many bugs are open in the Mobile App project?" |
| **Query** | "Who has the most issues this sprint?" |
| **Create** | "Create a task: Add dark mode to settings page, assign to @sara, medium priority" |
| **Create** | "Create a bug: app crashes on login, attach this error log, urgent" |
| **Update** | "Move VAT-42 to done" |
| **Update** | "Change priority of VAT-55 to high" |
| **Update** | "Assign VAT-61 to @mike" |
| **Update** | "Add label 'backend' to VAT-78" |
| **Comment** | "Add a comment on VAT-42: Fixed in PR #123" |
| **Analytics** | "Show me the velocity of the Backend team over the last 3 sprints" |
| **Analytics** | "What's our bug rate this month vs last month?" |
| **Analytics** | "Who completed the most issues this week?" |
| **Planning** | "What should we put in the next sprint based on priority and backlog?" |
| **Planning** | "Are there any blockers in the current sprint?" |
| **Search** | "Find issues related to authentication" |
| **Search** | "Show all issues @john worked on last week" |
| **Report** | "Give me a standup summary for today" |
| **Report** | "Generate a weekly report for the Backend team" |

**Access control:**
- Every AI action runs through the same permission system as the REST API
- AI cannot do anything the user can't do themselves
- GUEST can only read, MEMBER can create/update their own, ADMIN/OWNER can do everything
- AI actions are logged in the Activity feed (actor = user, tool = AI)

**Conversation persistence:**
```prisma
model AiConversation {
  id          String   @id @default(uuid())
  userId      String
  workspaceId String
  title       String   // Auto-generated from first message or user-set
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  messages  AiMessage[]

  @@index([userId, workspaceId])
  @@index([updatedAt])
}

model AiMessage {
  id             String   @id @default(uuid())
  conversationId String
  role           AiMessageRole  // USER, ASSISTANT, TOOL_CALL, TOOL_RESULT
  content        String   @db.Text
  toolCalls      Json?    // For ASSISTANT messages that invoke tools
  toolResults    Json?    // For TOOL_RESULT messages
  createdAt      DateTime @default(now())

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

**Backend architecture:**
```
POST /ai/chat
Body: {
  conversationId?: string,    // null = new conversation
  message: string,
  mentions?: string[],        // @resolved user/project/team IDs
}

Response (streamed via SSE):
  event: message
  data: { role: "assistant", content: "chunk..." }

  event: tool_call
  data: { tool: "create_issue", args: {...}, result: {...} }

  event: done
  data: { conversationId: "..." }
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

**Key difference from Trussen AI:**

| | Trussen AI (20B) | AI Assistant (20C) |
|---|---|---|
| Location | Left panel (persistent) | Bottom-right bubble (ephemeral) |
| Purpose | Workspace control & execution | Help, guidance, brainstorming |
| Conversation history | Full history, resumable | Ephemeral (resets per session) |
| Can create/update data | Yes (full MCP tools) | Limited (mostly read, can suggest actions) |
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

| Feature | Trigger | What it does |
|---|---|---|
| **Auto-assign suggestion** | Issue created without assignee | Analyzes title/description + team expertise + current workload → suggests 1-3 assignees |
| **Duplicate detection** | Issue created | Embeds title → vector search against existing issues → flags top 3 matches if similarity > threshold |
| **Smart label suggestion** | Issue created/updated | NLP on title + description → suggests matching labels from workspace label set |
| **Sprint planning assist** | New cycle created | Analyzes backlog priority + team velocity + member workload → suggests issue set for sprint |
| **Priority suggestion** | Issue created with default priority | Analyzes language ("crash", "data loss", "nice to have") → suggests appropriate priority |
| **Stale issue detection** | Daily cron | Finds issues IN_PROGRESS for > X days with no activity → sends notification |
| **Weekly digest** | Weekly cron | Generates team/workspace summary → sends via notification or email |

---

## 20E — MCP Server (External AI Agents)

**For:** Claude Desktop, custom AI agents, automation pipelines

**Authenticates via:** API keys (Phase 18) or Clerk session

**Exposes the same tools as Trussen AI** — but as an MCP protocol server that any compatible AI client can connect to.

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
│   ├── search.ts             # full-text search
│   └── analytics.ts          # velocity, bug_rate, team_stats
└── resources/
    ├── workspace.ts           # Workspace summary
    ├── issue.ts               # Issue detail
    ├── project.ts             # Project summary
    └── cycle.ts               # Current sprint
```

---

## Shared AI Backend Infrastructure

All AI systems share common backend infrastructure:

```
modules/ai/
├── ai.routes.ts              # /ai/generate-issue, /ai/chat, /ai/assist, /ai/suggest
├── ai.controller.ts
├── ai.service.ts             # Core AI orchestration
├── ai.schemas.ts
├── ai.tools.ts               # Tool definitions (shared between MCP + in-app AI)
├── ai.context.ts             # Build workspace context for Claude
├── ai.permissions.ts         # Verify AI actions against user permissions
├── ai.streaming.ts           # SSE streaming for chat responses
└── ai.rate-limiter.ts        # AI-specific rate limiting (token budget per plan)

modules/ai/tools/
├── issue-tools.ts            # Issue CRUD tools
├── project-tools.ts          # Project query tools
├── cycle-tools.ts            # Sprint/cycle tools
├── member-tools.ts           # Member/workload tools
├── comment-tools.ts          # Comment tools
├── label-tools.ts            # Label tools
├── search-tools.ts           # Search tools
├── analytics-tools.ts        # Analytics/reporting tools
└── navigation-tools.ts       # App navigation suggestions
```

**Key design principle:** Tools are defined ONCE and shared across all AI systems. The MCP server, Trussen AI panel, AI Assistant, and Background AI all call the same tool functions. The only difference is:
- **Who triggers them** (user via chat, MCP client, or background job)
- **What permissions they run with** (user's own permissions)
- **How results are delivered** (JSON response, SSE stream, notification)

---

## Build Order

```
Phase 20A — AI Issue Creator          (simplest, standalone, high impact)
Phase 20E — MCP Server                (foundation for tools, shared infra)
Phase 20B — Trussen AI Panel          (uses MCP tools, adds chat UI)
Phase 20C — AI Assistant              (lightweight, uses subset of tools)
Phase 20D — Background AI             (cron jobs, queue workers, last)
```

**20A first** because it's self-contained (one endpoint, one Claude call, no conversation state) and delivers immediate value — users can create issues 10x faster.

**20E second** because it establishes the tool infrastructure that 20B and 20C both depend on.

---

## Tech Stack

| Component | Technology |
|---|---|
| LLM | Claude API (claude-sonnet-4-20250514 for speed, claude-opus-4-20250514 for complex reasoning) |
| MCP Server | `@modelcontextprotocol/sdk` |
| Streaming | Server-Sent Events (SSE) via Express |
| Vector search (duplicate detection) | pgvector extension on PostgreSQL (or external: Pinecone/Qdrant) |
| Embeddings | Claude API or OpenAI `text-embedding-3-small` |
| Rate limiting | Token-based budget per plan tier |
| Conversation storage | Prisma models (AiConversation, AiMessage) |

---

## Plan Gating

| Feature | Free | Standard | Premium |
|---|---|---|---|
| AI Issue Creator | 5/day | 50/day | Unlimited |
| Trussen AI Panel | - | 100 messages/day | Unlimited |
| AI Assistant | 10/day | 50/day | Unlimited |
| Background AI (suggestions) | - | Basic (labels only) | Full (all suggestions) |
| MCP Server access | - | Read-only | Full read/write |
| Conversation history | - | 7 days | 90 days |

---

## Security & Business Rules

1. **AI never acts autonomously** — every action requires user initiation (except background suggestions which are non-destructive)
2. **Permission-scoped** — AI runs with the authenticated user's permission level, never elevated
3. **Activity logging** — every AI-initiated action creates an Activity entry with `metadata.triggeredBy: "ai"`
4. **Rate limiting** — token budget per plan tier, not just request count
5. **No data training** — workspace data is NEVER used to train models (Claude API doesn't train on API inputs)
6. **Audit trail** — AI conversations are stored and queryable by workspace admins
7. **Kill switch** — workspace admins can disable AI features entirely via workspace settings
8. **Content filtering** — AI refuses to generate harmful, discriminatory, or inappropriate content
9. **Error handling** — if AI fails, the user can always fall back to manual issue creation
10. **Transparency** — AI-generated content is always labeled as such
