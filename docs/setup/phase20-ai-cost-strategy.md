# Phase 20 — AI Cost Optimization Strategy

> Goal: Maximum AI power at minimum cost. Every token counts.

---

## 1. Tiered Model Strategy (Route to Cheapest Model That Works)

Not every AI task needs the same intelligence. Route by complexity:

```
┌─────────────────────────────────────────────────────────┐
│                   AI REQUEST ROUTER                      │
│                                                          │
│  User request comes in → classify complexity → route     │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  TIER 1      │  │  TIER 2      │  │  TIER 3      │  │
│  │  Haiku 3.5   │  │  Sonnet 4    │  │  Opus 4      │  │
│  │  $0.006/call │  │  $0.02/call  │  │  $0.10/call  │  │
│  │              │  │              │  │              │  │
│  │  80% of      │  │  18% of     │  │  2% of       │  │
│  │  requests    │  │  requests    │  │  requests    │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                          │
│  Weighted avg: ~$0.01/call instead of $0.02/call         │
│  = 50% cost reduction                                    │
└─────────────────────────────────────────────────────────┘
```

### What goes where:

| Tier | Model | Use Cases | Why |
|---|---|---|---|
| **Tier 1** (cheapest) | Haiku 3.5 | Label suggestions, priority detection, status queries, simple searches, navigation help, field extraction from short text | Fast, cheap, sufficient for structured extraction |
| **Tier 2** (balanced) | Sonnet 4 | Issue generation from description, brainstorming, bug reports, sprint summaries, duplicate detection reasoning, multi-step queries | Good reasoning, good cost |
| **Tier 3** (premium) | Opus 4 | Complex planning, architectural breakdown, cross-project analysis, weekly reports with insights, conflict resolution suggestions | Only when deep reasoning needed |

### Implementation:

```typescript
type AiTier = 'haiku' | 'sonnet' | 'opus';

const TIER_MODELS: Record<AiTier, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-20250514',
};

// Route based on task type — NOT user input
function selectTier(taskType: string): AiTier {
  switch (taskType) {
    // Tier 1 — structured extraction, simple queries
    case 'suggest_labels':
    case 'suggest_priority':
    case 'detect_type':
    case 'simple_query':
    case 'navigation_help':
    case 'extract_assignee':
      return 'haiku';

    // Tier 2 — generation, reasoning
    case 'generate_issue':
    case 'brainstorm':
    case 'bug_report':
    case 'sprint_summary':
    case 'chat_response':
    case 'duplicate_check':
      return 'sonnet';

    // Tier 3 — complex analysis (rare)
    case 'weekly_report':
    case 'architecture_breakdown':
    case 'cross_project_analysis':
      return 'opus';

    default:
      return 'sonnet'; // Safe default
  }
}
```

---

## 2. Prompt Engineering (Minimize Token Usage)

### 2a. Compact System Prompts

BAD (wasteful):
```
You are an AI assistant for a project management platform called Trussen.
Trussen is a SaaS application similar to Linear. It has workspaces, projects,
teams, issues, cycles, and more. Each workspace has members with different
roles. Issues can have types (task, bug, issue), priorities (low, medium,
high, urgent), statuses (backlog, todo, in_progress, review, done), and
labels. When creating an issue, you should generate a title, description,
type, priority, and suggest labels...
[500+ tokens of context]
```

GOOD (compact):
```
You are Trussen AI. Generate a structured issue from the user's description.

Workspace context:
- Projects: [{id,name}]
- Members: [{id,name}]  
- Labels: [name1, name2, ...]
- Statuses: backlog|todo|in_progress|review|done

Respond ONLY with JSON. No explanations.
```

**Savings: 60-70% fewer input tokens per call.**

### 2b. Context Pruning — Send ONLY What's Needed

DON'T send the entire workspace state to every AI call. Send the minimum context for the task:

| Task | Context needed | Context NOT needed |
|---|---|---|
| Generate issue | Project names, member names, label list | Issue history, analytics, cycles |
| Suggest labels | Issue title + description, existing labels | Members, projects, cycles |
| Query "my issues" | Nothing — just call the DB | All context |
| Suggest assignee | Team members + their recent workload | Labels, projects, full member profiles |
| Duplicate check | Issue title, top 20 recent issue titles | Everything else |

```typescript
// Build minimal context per task type
function buildContext(taskType: string, workspaceId: string) {
  switch (taskType) {
    case 'generate_issue':
      return {
        projects: await getProjectNames(workspaceId),     // [{id, name}] — ~200 tokens
        members: await getMemberNames(workspaceId),       // [{id, name}] — ~200 tokens
        labels: await getLabelNames(workspaceId),          // [name, ...] — ~100 tokens
      };                                                    // Total: ~500 tokens vs 2000+

    case 'suggest_labels':
      return {
        labels: await getLabelNames(workspaceId),          // [name, ...] — ~100 tokens
      };                                                    // Total: ~100 tokens

    case 'suggest_assignee':
      return {
        members: await getMemberWorkload(workspaceId),    // [{name, openIssues}] — ~300 tokens
      };

    default:
      return {};
  }
}
```

### 2c. Response Format — Force JSON, No Prose

```typescript
// System prompt enforces JSON-only responses
const SYSTEM_PROMPT = `Respond ONLY with valid JSON. No markdown, no explanations, no preamble.`;

// Use response_format for structured output (when available)
const response = await anthropic.messages.create({
  model: tier,
  max_tokens: 1024,  // Cap output tokens
  // ...
});
```

**Max tokens cap** prevents runaway responses. Issue generation needs ~500 tokens max, not 4096.

---

## 3. Caching Strategy (Avoid Duplicate AI Calls)

### 3a. Result Caching (Same Input = Same Output)

```typescript
// Cache AI responses for identical inputs
// Key = hash(taskType + prompt + contextHash)
// TTL = varies by task type

const AI_CACHE_TTL: Record<string, number> = {
  'suggest_labels': 60 * 60,        // 1 hour — labels don't change often
  'suggest_priority': 60 * 60,      // 1 hour
  'navigation_help': 24 * 60 * 60,  // 24 hours — app features don't change
  'generate_issue': 0,               // No cache — each prompt is unique
  'chat_response': 0,                // No cache — conversational
};
```

### 3b. Prompt Caching (Claude API Feature)

Claude API supports **prompt caching** — if you send the same system prompt repeatedly, you pay only once for caching it, then subsequent calls use the cached version at 90% discount.

```typescript
// Use cache_control to cache the system prompt
const response = await anthropic.messages.create({
  model: 'claude-sonnet-4-20250514',
  system: [
    {
      type: 'text',
      text: SYSTEM_PROMPT,  // Same across all calls of this type
      cache_control: { type: 'ephemeral' },  // Cache for 5 minutes
    },
  ],
  messages: [{ role: 'user', content: userPrompt }],
});

// Result: System prompt tokens charged at 10% of normal rate after first call
```

**Savings: 90% on system prompt tokens for repeated calls within 5-minute window.**

### 3c. Context Caching (Workspace State)

The workspace context (projects, members, labels) doesn't change every request. Cache it in memory:

```typescript
// Cache workspace context in memory with TTL
const contextCache = new Map<string, { data: any; expiresAt: number }>();

async function getCachedContext(workspaceId: string, taskType: string) {
  const key = `${workspaceId}:${taskType}`;
  const cached = contextCache.get(key);
  
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;  // No DB query needed
  }
  
  const context = await buildContext(taskType, workspaceId);
  contextCache.set(key, { data: context, expiresAt: Date.now() + 5 * 60 * 1000 });
  return context;
}
```

---

## 4. Do It Without AI When Possible

Many "AI" features don't actually need AI. Use rule-based logic first, fall back to AI only when needed:

| Feature | AI Approach (expensive) | Rule-Based Approach (free) |
|---|---|---|
| **Priority detection** | Send to Haiku for NLP | Keyword match: "crash/down/broken" = URGENT, "nice to have/enhancement" = LOW |
| **Type detection** | Send to Haiku for classification | Keyword match: "bug/crash/error/broken" = BUG, "add/create/build" = TASK |
| **Label suggestion** | Send to Haiku for NLP | TF-IDF or keyword matching against existing label names |
| **Duplicate detection** | Embed + vector search + AI reasoning | PostgreSQL full-text search (`ts_vector`) with trigram similarity |
| **Issue queries** | Parse NL with AI then query DB | Direct DB queries with filters (already built in your API) |
| **Navigation help** | AI generates navigation instructions | Static help content mapped to keywords |
| **Stale issue detection** | AI analyzes patterns | Simple SQL: `WHERE status = 'IN_PROGRESS' AND updatedAt < NOW() - INTERVAL '7 days'` |
| **Standup summary** | AI generates prose | Template: "Completed: X, In Progress: Y, Blocked: Z" from DB queries |

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

**This alone eliminates 30-40% of AI calls.**

---

## 5. Token Budget System (Per-Plan Limits)

Instead of request count limits (which penalize short queries), use **token budgets**:

```typescript
interface PlanTokenBudget {
  dailyInputTokens: number;
  dailyOutputTokens: number;
}

const PLAN_BUDGETS: Record<string, PlanTokenBudget> = {
  FREE: {
    dailyInputTokens: 10_000,       // ~5 issue generations
    dailyOutputTokens: 5_000,
  },
  STANDARD: {
    dailyInputTokens: 200_000,      // ~100 issue generations
    dailyOutputTokens: 100_000,
  },
  PREMIUM: {
    dailyInputTokens: 2_000_000,    // ~1000 issue generations
    dailyOutputTokens: 1_000_000,
  },
};
```

Track usage per workspace per day:

```typescript
// After each AI call, record token usage
await prisma.aiUsage.upsert({
  where: { workspaceId_date: { workspaceId, date: today } },
  create: { workspaceId, date: today, inputTokens: usage.input, outputTokens: usage.output },
  update: { inputTokens: { increment: usage.input }, outputTokens: { increment: usage.output } },
});

// Before each AI call, check budget
const usage = await getUsageToday(workspaceId);
const budget = PLAN_BUDGETS[plan];
if (usage.inputTokens >= budget.dailyInputTokens) {
  throw new AppError(429, 'AI_BUDGET_EXCEEDED', 'Daily AI usage limit reached. Upgrade your plan for more.');
}
```

---

## 6. Cost Projection

### Per-workspace monthly cost (assuming 5 active users, 50 AI calls/day):

| Strategy | Sonnet for all | Tiered models | Tiered + rule-based | Tiered + rule-based + caching |
|---|---|---|---|---|
| AI calls/day | 50 | 50 | 35 (30% saved) | 30 (40% saved) |
| Avg cost/call | $0.020 | $0.010 | $0.010 | $0.008 |
| Daily cost | $1.00 | $0.50 | $0.35 | $0.24 |
| **Monthly cost** | **$30** | **$15** | **$10.50** | **$7.20** |

### At scale (1000 workspaces):

| | Naive | Optimized |
|---|---|---|
| Monthly cost | $30,000 | $7,200 |
| Annual cost | $360,000 | $86,400 |
| **Savings** | — | **$273,600/year** |

---

## 7. Summary — The Cost Optimization Stack

```
Layer 1: Don't use AI when you don't need it (rules, templates, DB queries)
Layer 2: Use the cheapest model that works (Haiku for extraction, Sonnet for generation)
Layer 3: Send minimal context (only what the task needs, not the whole workspace)
Layer 4: Cache everything (prompt caching, result caching, context caching)
Layer 5: Cap output tokens (500 for issues, 1024 for chat, never 4096)
Layer 6: Budget per plan (token-based, not request-based)
```

**Combined effect: 70-80% cost reduction vs naive implementation.**
