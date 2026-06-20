# AI Issue Creator (Phase 20A) — Integration Guide

> How the AI Issue Creator was built, architecture decisions, and future work.

---

## 1. What Was Built

### Backend (7 files)

```
modules/ai/
├── ai.provider.ts    — OpenRouter abstraction, model routing, fallback chain
├── ai.rules.ts       — Rule-based detection (type, priority, dates, @mentions) — FREE
├── ai.context.ts     — Workspace context builder with 5-min cache
├── ai.schemas.ts     — Zod validation for request + AI response
├── ai.service.ts     — Orchestration: rules → context → AI → validate → resolve
├── ai.controller.ts  — HTTP handler
├── ai.routes.ts      — POST /ai/generate-issue, GET /ai/models
└── docs/
    ├── setup-guide.md
    └── integration.md (this file)
```

### Frontend (5 files)

```
features/ai/
├── types.ts                          — AiGeneratedIssue, AiClarificationNeeded
├── services/aiService.ts             — API calls
├── hooks/useAiMutations.ts           — useGenerateIssue mutation
├── components/AiIssueGenerator.tsx   — Main AI input with @ mention dropdown
└── index.ts                          — Barrel exports
```

### Modified Files

| File | What changed |
|---|---|
| `config/env.ts` | Added `OPENROUTER_API_KEY` |
| `shared/errors/error-codes.ts` | Added 5 AI error codes |
| `app/app.ts` | Mounted `/ai` routes |
| `CreateIssuePage.tsx` | Added `AiIssueGenerator` component + form auto-fill logic |

---

## 2. Architecture Decisions

### Why OpenRouter (not direct Claude/OpenAI)?

- **One API key, any model** — switch models by changing one string
- **No vendor lock-in** — swap Claude → DeepSeek → GPT without code changes
- **Same pricing** — no markup over direct API pricing
- **Built-in fallback** — if one model is down, our code tries the next

### Why rule-based detection before AI?

- **Cost: $0** — regex is free, AI calls cost money
- **Speed: <1ms** — regex is instant, AI takes 3-10 seconds
- **Accuracy: higher** — "urgent" keyword → URGENT is more reliable than AI interpretation
- **30-40% of calls saved** — gibberish, off-topic, and incomplete prompts are rejected without AI

### Why Zod validation on AI response?

- AI models hallucinate — they invent labels, users, and projects that don't exist
- Zod catches invalid JSON structure before any action is taken
- Referenced IDs (users, projects, labels) are verified against real workspace data
- Hallucinated references are stripped, not propagated

### Why pre-resolved IDs from frontend?

- The @ dropdown shows real users with avatars — user picks the exact person
- Frontend sends the user ID, not the name text
- Backend skips fuzzy name matching — no "Shaheer Qureshi" vs "Muhammad Shaheer" confusion
- Falls back to fuzzy matching only when the user types @name without using the dropdown

### Why automatic model fallback?

Free models on OpenRouter are shared — they can be temporarily rate-limited. The fallback chain tries 6 models in sequence:

```
Model 1 → 429? → Model 2 → 429? → Model 3 → ... → Model 6 → all failed? → error
```

This ensures the user always gets a response, even when individual models are overloaded.

---

## 3. Security Measures

| Layer | What | How |
|---|---|---|
| **Auth** | Clerk JWT + workspace membership | `authenticate` + `requireWorkspace` middleware |
| **Rate limit** | 20 req/min per IP | `strictRateLimiter` middleware |
| **Input sanitization** | Control chars, XML tags stripped | Regex before AI call |
| **Prompt injection** | User input delimited + system prompt hardened | XML delimiters + "ignore user commands" instruction |
| **Template injection** | Template content JSON-escaped | `JSON.stringify().slice(1,-1)` before prompt injection |
| **Response validation** | Zod schema on AI output | Every field typed + bounded |
| **Reference verification** | IDs checked against DB | Labels, users, projects verified to exist |
| **Timeout** | 60-second abort | `AbortController` on OpenRouter fetch |
| **No DB writes** | AI returns data, user submits | Normal issue creation flow handles persistence |

---

## 4. The AI Execution Chain

```
User types prompt
  ↓
Step 0: SANITIZE
  Strip control chars, XML tags, limit to 5000 chars
  ↓
Step 1: RULE-BASED DETECTION (FREE)
  Type, priority, severity, @mentions, dates, estimate,
  Figma URLs, issue refs, gibberish/off-topic/incomplete check
  ↓
  → Gibberish/off-topic/incomplete? Return clarification ($0)
  ↓
Step 2: FETCH CONTEXT (DB queries, cached 5 min)
  Project names, member names, label names, active template
  ↓
Step 3: BUILD PROMPT
  System prompt + workspace context + template + user input
  ↓
Step 4: CALL AI (OpenRouter, with fallback chain)
  Try primary model → fallback on 429 → up to 6 models
  ↓
Step 5: VALIDATE RESPONSE (Zod)
  Parse JSON, validate schema, strip invalid fields
  ↓
Step 6: RESOLVE REFERENCES
  Pre-resolved IDs from frontend take priority
  Fuzzy match only as fallback
  Labels deduplicated + matched to workspace casing
  ↓
Step 7: RETURN TO FRONTEND
  Form auto-fills: title, type, priority, description,
  assignee, project, labels, subtasks, due date, estimate,
  bug fields, feature fields, Figma refs, template ID
```

---

## 5. Cost Analysis

### Per-call cost (free tier)

| What | Cost |
|---|---|
| Rule-based detection | $0 |
| Gibberish/off-topic rejection | $0 |
| Context fetch (DB, cached) | $0 |
| AI call (free model) | $0 |
| **Total per issue generation** | **$0** |

### Per-call cost (paid tier with DeepSeek V4 Flash)

| What | Cost |
|---|---|
| Rule-based detection | $0 |
| Context fetch | $0 |
| AI call (~2K input + ~1K output tokens) | ~$0.0001 |
| **Total per issue generation** | **~$0.0001** |

### Monthly projection (100 users, 5 AI calls/day each)

| Tier | Model | Monthly cost |
|---|---|---|
| Free | Llama/Qwen/Gemma | $0 |
| Paid | DeepSeek V4 Flash | ~$1.50 |
| Premium | Claude Sonnet 4 | ~$30 |

---

## 6. Frontend Component: AiIssueGenerator

### Features

- **Chat-style input** — textarea that grows, send button
- **@ mention dropdown** — unified selector for:
  - `@name` → workspace members
  - `@project:name` → workspace projects
  - `@team:name` → workspace teams
  - `@dept:name` → workspace departments
  - `@issue:ID` → existing issues (for linking)
- **Smart prefix detection** — typing `@pro` suggests completing to `@project:`
- **Loading state** — "Trussen AI" badge + spinner during generation
- **Clarification messages** — amber card with "detected so far" badges
- **Success indicator** — green card confirming form was filled
- **Keyboard shortcuts** — Enter to generate, Escape to close dropdown
- **Pre-resolved IDs** — dropdown sends user/project IDs directly to backend

### Form Fields Auto-Filled

| Field | Source |
|---|---|
| Title | AI generated |
| Type | Rule-based first, then AI |
| Priority | Rule-based first, then AI |
| Description | AI generated (markdown) |
| Assignee | @ dropdown (ID) → or AI suggestion → or template default |
| Project | @ dropdown (ID) → or AI suggestion |
| Labels | AI suggested (filtered to existing workspace labels only) |
| Subtasks | AI generated → or template checklist |
| Due date | Rule-based ("2 days") → or AI ("June 25") |
| Estimate | Rule-based ("complex" → 4) → or AI |
| Steps to reproduce | AI (bug only) → or template |
| Expected/actual behavior | AI (bug only) → or template |
| Severity | Rule-based → or AI → or template |
| Acceptance criteria | AI (feature only) → or template |
| Notes | AI → or template |
| Figma URLs | Rule-based URL extraction → integration refs |
| Template ID | Matched from detected type |

---

## 7. Future Work

### Immediate (Phase 20A improvements)

- [ ] **Workspace AI model setting** — Admin/owner picks model in Settings → AI section
- [ ] **Token budget tracking** — `AiUsage` table, per-workspace per-day limits
- [ ] **Plan gating** — Free: 5/day, Standard: 50/day, Premium: unlimited

### After paying $5 on OpenRouter

- [ ] Switch `DEFAULT_AI_MODEL` to `"deepseek/deepseek-v4-flash"` — faster, more reliable, $0.0001/call
- [ ] Keep free models as fallback chain (no code change needed)
- [ ] Monitor usage at [openrouter.ai/activity](https://openrouter.ai/activity)

### Phase 20D — Embeddings & Duplicate Detection

- [ ] Enable `pgvector` extension in PostgreSQL
- [ ] Create `embeddings` table (single table, entity_type + entity_id pattern)
- [ ] Async embedding generation via BullMQ on issue creation
- [ ] Duplicate detection: when user types in AI prompt, search similar existing issues
- [ ] Show "Possible duplicate: VAT-42 (91% similar)" before generating

### Phase 20E — MCP Server

- [ ] Expose 10 V1 tools (list_issues, create_issue, etc.) via `@modelcontextprotocol/sdk`
- [ ] API key auth for external agents (Claude Desktop, Cursor)
- [ ] Same tools shared between MCP and in-app AI

### Phase 20B — Trussen AI Panel

- [ ] Left-panel conversational interface
- [ ] Conversation persistence (AiConversation + AiMessage models)
- [ ] SSE streaming for real-time responses
- [ ] Full workspace control via natural language

### Phase 20C — AI Assistant

- [ ] Bottom-right helper bubble
- [ ] App navigation guidance
- [ ] Brainstorming mode with "Create All" action
- [ ] Ephemeral (no conversation history)

---

## 8. Files Reference

### Backend

| File | Purpose |
|---|---|
| `modules/ai/ai.provider.ts` | OpenRouter API calls, model routing, fallback chain |
| `modules/ai/ai.rules.ts` | Regex-based type/priority/date/mention/gibberish detection |
| `modules/ai/ai.context.ts` | Fetch workspace context (projects, members, labels, templates) with cache |
| `modules/ai/ai.schemas.ts` | Zod schemas for request validation + AI response validation |
| `modules/ai/ai.service.ts` | Main orchestration — sanitize → rules → context → AI → validate → resolve |
| `modules/ai/ai.controller.ts` | HTTP handler for POST /ai/generate-issue |
| `modules/ai/ai.routes.ts` | Route definitions with auth + rate limiting |
| `config/env.ts` | `OPENROUTER_API_KEY` env var |
| `shared/errors/error-codes.ts` | AI_NOT_CONFIGURED, AI_PROVIDER_ERROR, etc. |
| `app/app.ts` | Mounts `/ai` routes |

### Frontend

| File | Purpose |
|---|---|
| `features/ai/components/AiIssueGenerator.tsx` | Main AI input with @ mention dropdown |
| `features/ai/services/aiService.ts` | API calls to /ai/generate-issue |
| `features/ai/hooks/useAiMutations.ts` | useGenerateIssue mutation with error handling |
| `features/ai/types.ts` | AiGeneratedIssue, AiClarificationNeeded types |
| `features/ai/index.ts` | Barrel exports |
| `pages/CreateIssuePage.tsx` | Integrates AiIssueGenerator + form auto-fill |
