# Phase 20H — Trussen AI Semantic Entity Resolution and Embedding Plan

## 1. Problem

Trussen AI currently has two related weaknesses:

1. scoped entity resolution is too deterministic and too brittle
2. business-question routing is too phrase-coupled

That is not sufficient for production because users will:

- misspell entity names
- use partial names
- use shorthand or nicknames
- mention entities in natural language instead of strict `project: X` syntax
- switch languages
- ask for an entity that does not exist
- ask broad questions in many different phrasings without using expected keywords

Current failures are unsafe because unresolved project-scoped prompts can fall into the wrong entity path and still produce an answer.

Examples of bad behavior:

- user asks for a project report, but AI answers with a member report
- user misspells `USingle2 App`, but the system silently binds to a different entity
- user asks for a non-existent project, but the system still returns some report
- user asks `is ridely in bad shape?` and routing depends on whether the phrase happened to contain `on track`
- user asks `what is my rle` and the system misses a role/access question because the exact word was misspelled

This phase defines the production-grade semantic orchestration contract around entity resolution, with entity resolution itself as the core subsystem.

---

## 2. Goals

The orchestration and resolver stack must:

1. resolve projects, teams, departments, members, and cycles safely
2. classify broad workspace/business questions semantically, not by brittle phrase triggers
3. support exact names, aliases, typos, partial names, and natural-language mentions
4. support multilingual prompts better than raw string matching
5. never fall through to the wrong entity type
6. ask for confirmation when confidence is not high enough
7. return explicit `not found` responses when no credible entity exists
8. be reusable across analytics, CRUD, membership actions, assignment, navigation, and future AI workflows

---

## 3. System Framing

This document should be read as the design for one large production-grade Trussen AI system, not a narrow patch or a temporary phase-specific workaround.

The intended product outcome is:

- a built-in ChatGPT-like assistant for the PM app
- but with deterministic execution, strict permissions, and operational safety

It should feel like a universal workspace operator, not a fragile chatbot.

The goal is to make Trussen AI a universal workspace assistant across the whole app:

- issues
- projects
- teams
- departments
- members
- cycles
- analytics
- activity
- app help
- navigation
- access questions
- operational mutations allowed by policy

The system may still evolve after delivery, but the architecture must be designed as a coherent end-state production system now.

This means:

- no phrase-coupled shortcuts as the primary design
- no isolated per-feature AI hacks
- no separate resolution logic per module
- no assumption that users will use correct spelling, exact syntax, or one language

---

## 4. Non-Goals

This phase does not require:

- a separate vector database
- deletion capabilities
- attachment/entity OCR resolution
- cross-workspace search
- free-form AI guessing without guardrails
- replacing all deterministic routing with a large-model call
- allowing unresolved questions to continue into arbitrary tools

PostgreSQL + pgvector remains sufficient for this production architecture.

---

## 5. Top-Level Architecture

The correct backend design is:

```txt
User message
→ language/input normalization
→ semantic intent classification
→ conversation memory
→ context resolver
→ entity extraction
→ entity resolver
→ required-slot extraction and validation
→ permission and policy check
→ risk policy
→ capability registry
→ execution planner
→ deterministic query loader or mutation executor
→ observe result / continue loop if needed
→ AI explanation layer
```

The system must **not** behave like this:

```txt
contains "on track" → roadmap tool
contains "report" → analytics tool
contains "role" → members tool
```

Keywords may still be used as weak features, but they must not be the final router.

### 5.0 Action Model

The architecture must support the full Trussen AI action surface across the app, not just project health or analytics.

This includes:

- read actions
- safe write actions
- restricted actions
- blocked actions

Examples of read actions:

- project report
- individual report
- team workload
- my tasks
- overdue tasks
- blocked tasks
- role/access info
- activity summary
- app navigation help

Examples of safe write actions:

- create project
- create issue
- create cycle
- assign task
- update priority/status
- add comment
- generate description
- create checklist

Examples of restricted or high-risk actions:

- remove member from team/project/department/workspace
- bulk assignment or bulk status changes
- schedule changes with broad project/cycle impact
- role changes

Examples of blocked actions:

- delete project
- delete issue
- billing changes if not explicitly supported
- any forbidden destructive operation

The exact enum names in implementation may differ, but the architecture must be capable of covering all allowed Trussen AI actions across the app.

### 5.1 Intent Before Entity

The caller must determine what kind of question is being asked before trying to finalize which entity to bind.

Examples:

- `is Ridely on track?`
- `I think Ridely is in bad shape`
- `tell me current shape of Ridely`
- `how is Ridely doing?`
- `is Ridely at risk?`
- `what's going on with Ridely?`

These should converge to the same broad intent family, not be split by phrase choice.

### 5.2 Entity Resolution After Intent

After intent is known, the resolver gets the expected entity type set and resolves safely inside that boundary.

Example:

- intent says `PROJECT_HEALTH`
- resolver expects `project`
- candidate search must not silently return member/team data as the final answer

### 5.3 Context Resolver

Before final entity binding, the system should resolve contextual signals such as:

- current page
- selected issue/project/team/cycle
- previous conversation turn
- current workspace scope

Context is a ranking signal, not a hard override.

If explicit user text conflicts with ambient page context, explicit user text wins unless policy says otherwise.

### 5.3.1 Conversation Memory

The orchestration layer must not rely only on the current user message.

It needs persistent conversational working memory for operational continuity.

Minimum memory shape:

```ts
type ConversationMemory = {
  language?: string;
  currentProjectId?: string;
  currentIssueId?: string;
  currentTeamId?: string;
  currentDepartmentId?: string;
  currentCycleId?: string;
  lastResolvedEntities: Array<{
    entityType: "project" | "issue" | "team" | "department" | "member" | "cycle";
    entityId: string;
    name: string;
  }>;
  pendingSlots?: Record<string, unknown>;
  pendingConfirmation?: {
    pendingActionId: string;
    intent: string;
    previewText: string;
    expiresAt: string;
  };
  recentReferences?: Array<"it" | "that" | "them" | string>;
};
```

This memory is required for turns like:

- `assign it to Ali`
- `move that to review`
- `compare it with USingle2`
- `yes confirm it`

Without memory, the system cannot safely resolve follow-up references.

### 5.4 Required Slot Validation

After intent and entities are known, the system must validate missing required slots before execution.

Examples:

- `CREATE_PROJECT` requires at least a project name
- `CREATE_ISSUE` requires title plus required scope per product rules
- `ASSIGN_ISSUE` requires issue and assignee
- `UPDATE_ISSUE` requires a target issue and at least one update field

The system must ask only for the missing slots, not restart the whole flow.

### 5.5 Risk Policy

Before executing mutations, the system must classify risk:

- low risk
- medium risk
- high risk
- blocked

This decides whether the action:

- executes directly
- requires preview
- requires explicit confirmation
- is blocked entirely

### 5.6 Execution Planner

Not every request maps to one tool call.

Some requests require multiple reads, ranking, comparison, or aggregation before an answer can be formed.

Examples:

- `what should I work on next?`
- `compare Ridely and USingle2`
- `who is blocked and why?`
- `is this project healthy?`

For these, the planner must:

1. choose required loaders
2. fetch deterministic data
3. assemble computed facts
4. pass only grounded facts to the response layer

### 5.6.1 Execution Plan Contract

The planner must produce a concrete typed plan, not only an informal intention.

Example shape:

```ts
type ExecutionPlanStep = {
  id: string;
  capability: string;
  executor: string;
  args: Record<string, unknown>;
  dependsOn: string[];
};

type ExecutionPlan = {
  intent: string;
  steps: ExecutionPlanStep[];
  requiresUserInput: boolean;
  requiresConfirmation: boolean;
};
```

This makes orchestration:

- debuggable
- replayable
- auditable
- easier to test

### 5.6.2 Multi-Step Planning

The planner must support chained operations, not assume one request equals one step.

Examples:

- `Compare Ridely with USingle2.`
- `Create issues for every missing milestone in Ridely.`
- `Assign them to Ali.`
- `Set due date next Friday.`

This may require:

1. compare two projects
2. derive missing milestones
3. create multiple issues
4. resolve assignee
5. update due dates

The planner must be capable of composing such multi-step flows safely.

### 5.7 Query Loader vs Mutation Executor

The execution layer must clearly separate:

- read/query loaders
- mutation executors

These two paths have different safety rules, confirmation requirements, and failure handling.

### 5.8 Stateful Agent Loop

The system should operate as a bounded stateful agent loop, not only a single-pass pipeline.

Conceptually:

```txt
User
→ Understand
→ Conversation Memory
→ Planner
→ Capability Registry
→ Tool Execution
→ Observe Result
→ Need More Steps?
→ Repeat if needed
→ Final Response
```

This loop must remain:

- policy-aware
- bounded
- interruption-safe
- deterministic at execution boundaries

It must not become an unbounded autonomous agent.

---

## 6. What This System Delivers

If implemented correctly, this architecture gives Trussen AI the following production benefits:

### 6.1 Natural User Interaction

Users can speak naturally instead of learning Trussen-specific phrasing.

The assistant can handle:

- typos
- vague requests
- shorthand
- partial names
- mixed language prompts
- incomplete grammar
- conversational requests

### 6.2 Universal App Coverage

One orchestration layer can serve the whole app instead of building separate brittle AI paths for:

- issues
- project operations
- team operations
- member operations
- analytics
- roadmap/cycle questions
- app help
- future external integrations treated as capabilities

### 6.3 Higher Correctness

By separating:

- intent understanding
- entity resolution
- permission checks
- deterministic execution
- AI explanation

the system becomes much less likely to:

- answer with the wrong entity
- choose the wrong tool
- perform the wrong mutation
- confuse unrelated requests

### 6.4 Better User Trust

Users stop feeling like they are dealing with a regex bot and start feeling like they are using a real workspace operator.

### 6.5 Stronger Safety

The architecture enforces:

- no cross-entity fallback
- permission-aware execution
- high-impact confirmation rules
- blocked delete behavior
- no invented targets
- no fabricated analytics

### 6.6 Lower Long-Term Maintenance Cost

Without this architecture, every new AI capability adds more:

- phrase rules
- exceptions
- regressions
- hidden coupling

With this architecture, new capabilities plug into:

- intent layer
- entity resolver
- slot validation
- deterministic executors
- response synthesis

### 6.7 Better Token Efficiency

The system resolves intent and entity first, fetches only necessary data, and uses AI mainly for interpretation and wording.

That produces better answers with less wasted model context.

### 6.8 Product Differentiation

Trussen AI stops being a chat add-on and becomes a real workspace operating layer for the app.

That is a materially stronger product than a sidebar bot that only works for narrow phrase patterns.

---

## 7. Semantic Intent Layer

This phase is primarily about entity resolution, but entity resolution must sit behind a semantic intent layer.

Recommended starting intent families:

- `PROJECT_HEALTH`
- `PROJECT_PROGRESS`
- `PROJECT_RISK`
- `TEAM_HEALTH`
- `WORKLOAD_SUMMARY`
- `ROLE_OR_ACCESS_QUESTION`
- `ISSUE_CRUD`
- `CYCLE_OR_SPRINT_STATUS`
- `ANALYTICS_SUMMARY`
- `UNKNOWN`

These are orchestration intents, not tool names.

### 7.0 Full Intent Enum Requirement

The implementation must define a concrete app-level intent enum rather than leaving intent as informal categories only.

The exact enum may evolve with the app, but it must cover the full Trussen AI action surface.

Minimum production intent set should include action-level intents like:

#### Project Intents

- `CREATE_PROJECT`
- `UPDATE_PROJECT`
- `PROJECT_HEALTH`
- `PROJECT_PROGRESS`
- `PROJECT_RISK`
- `PROJECT_SUMMARY`
- `PROJECT_REPORT`
- `COMPARE_PROJECTS`
- `LIST_PROJECTS`

#### Issue / Task Intents

- `CREATE_ISSUE`
- `UPDATE_ISSUE`
- `UPDATE_ISSUE_STATUS`
- `ASSIGN_ISSUE`
- `SEARCH_ISSUES`
- `MY_TASKS`
- `USER_TASKS`
- `OVERDUE_TASKS`
- `BLOCKED_TASKS`
- `PRIORITIZE_TASKS`
- `ADD_COMMENT`
- `CREATE_CHECKLIST`

#### Team / Member Intents

- `TEAM_WORKLOAD`
- `USER_WORKLOAD`
- `INDIVIDUAL_REPORT`
- `TEAM_REPORT`
- `WHO_IS_OVERLOADED`
- `WHO_IS_BLOCKED`
- `ROLE_OR_ACCESS_QUESTION`
- `INVITE_MEMBER`
- `REMOVE_MEMBER`

#### Cycle / Sprint Intents

- `CREATE_CYCLE`
- `UPDATE_CYCLE`
- `CYCLE_STATUS`
- `SPRINT_PROGRESS`
- `UPCOMING_DEADLINES`

#### Analytics / Workspace Intents

- `WORKSPACE_SUMMARY`
- `ACTIVITY_SUMMARY`
- `PERFORMANCE_REPORT`
- `TEAM_PERFORMANCE`
- `PRODUCTIVITY_TRENDS`

#### App / Help Intents

- `GENERAL_APP_HELP`
- `HOW_TO_USE_FEATURE`
- `APP_NAVIGATION_HELP`
- `UNKNOWN`

#### Blocked / Policy Intents

- `DELETE_REQUEST_BLOCKED`
- `IRREVERSIBLE_ACTION_BLOCKED`

These intent names are examples of the production intent granularity expected. The final enum should remain explicit and typed.

### 7.1 Intent Handling Rules

1. the intent layer may use deterministic features plus optional cheap-model classification
2. it must not rely on one phrase pattern
3. it must define the expected entity type set for the resolver
4. if the user intent remains unclear, the system should clarify instead of guessing

### 7.2 Hybrid Intent Classification

The classifier should be hybrid, not fully LLM-dependent for every turn.

Preferred order:

1. deterministic features and known patterns
2. normalized typo-tolerant matching for common product/help intents
3. small-model classification only when needed

This keeps cost and latency controlled while improving semantic handling.

### 7.3 Model-Primary Intent Clusters

Not all intents should use the same classification strategy.

For semantically overlapping business-question clusters, the cheap-model classifier should be the primary path, not only the fallback.

Examples:

- `PROJECT_HEALTH`
- `PROJECT_PROGRESS`
- `PROJECT_RISK`
- `TEAM_HEALTH`
- `WORKLOAD_SUMMARY`
- `ANALYTICS_SUMMARY`

These categories are too semantically close for deterministic phrase logic to remain reliable under typos, paraphrasing, or multilingual prompts.

Deterministic-first classification remains appropriate for narrower intent families such as:

- app navigation
- role/access help
- obvious CRUD requests
- explicit assignment or status-change requests

Deterministic features should still be used as priors, but they must not be the primary classifier for semantically overlapping business-intelligence questions.

---

## 8. Why Embeddings Are Needed

Deterministic matching is still required, but it is not enough.

Embeddings help when:

- the user writes `usingle2`, `usinlge2`, `isinhle2`
- the user refers to an entity loosely
- the user uses another language for descriptive phrasing
- the user omits exact formatting

Embeddings do **not** replace strict resolution rules.

Embeddings must be used as one scoring signal inside a guarded resolver, not as the final authority by themselves.

---

## 9. Current State

The codebase already has:

- `AiEmbedding` table in Prisma
- `text-embedding-3-small`
- pgvector storage
- background embedding jobs

But current embedding usage is limited to `ISSUE` duplicate detection and issue similarity.

It does **not** currently provide embedding-backed resolution for:

- `PROJECT`
- `TEAM`
- `DEPARTMENT`
- `MEMBER`
- `CYCLE`

So the infrastructure exists, but the entity-resolution capability does not.

---

## 10. Required Architecture

### 10.1 Shared Resolver Service

Add a dedicated module:

```txt
modules/ai/
├── ai.entity-resolution.ts
├── ai.entity-resolution.schemas.ts
└── ai.entity-resolution.test.ts
```

This module must be shared by:

- analytics resolution
- invite flows
- project/team/department membership actions
- assignment flows
- project/team/cycle CRUD
- future document scoping

Do not duplicate resolution logic inside `ai.action-state.ts` or tool routing code.

### 10.2 Strict Entity-Type Boundaries

If the user asks for a `project` report:

- only project candidates may be considered final candidates
- member/team/department/cycle candidates must not be used as fallback answers

If the requested entity type is unresolved:

- ask for clarification, or
- return not found

Never silently switch entity type.

### 10.3 Caller Contract

The resolver must not guess its own business purpose from raw text alone.

The caller should pass:

```ts
type EntityResolutionRequest = {
  workspaceId: string;
  userId: string;
  userRole: string;
  rawMessage: string;
  expectedEntityTypes: Array<"project" | "team" | "department" | "member" | "cycle">;
  accessMode: "read" | "mutation";
  actionRisk: "low" | "medium" | "high";
  currentContext?: {
    projectId?: string;
    teamId?: string;
    departmentId?: string;
    cycleId?: string;
  };
};
```

This is required so that:

- analytics questions can stay read-only
- mutation flows can use stricter confirmation rules
- current page context can be used as a weak ranking signal, not a forced override
- the resolver never broadens entity type silently

### 10.3.1 Context-Only Resolution Rule

If the user provides no explicit entity text at all, context may be promoted from a weak ranking signal to a default candidate source.

Examples:

- user is on a project page and asks `how is it going?`
- user is on a team page and asks `is this healthy?`

Rules:

1. explicit user text always overrides ambient context
2. if there is no explicit entity mention, current page context may be used as the primary candidate source
3. context-only resolution must still respect expected entity type
4. for context-only resolution on non-trivial reads or any mutation, the system may require clarification or confirmation even if confidence is high
5. context must never justify cross-entity fallback

This prevents accidental binding when the user message is too vague to stand on its own.

### 10.4 No Cross-Entity Fallback

If the caller asks for a project:

- resolver may return `resolved`
- resolver may return `confirm`
- resolver may return `ambiguous`
- resolver may return `not_found`

It must not return a member or team as a substitute.

---

## 11. Resolution Pipeline

Each resolution attempt must follow this order:

### Step 1. Exact Match

Check:

- exact name
- normalized exact name
- exact alias

If one exact match exists, resolve immediately.

### Step 2. Deterministic Fuzzy Match

Use:

- normalized contains match
- token overlap
- trigram similarity
- edit distance or typo-tolerant scoring

This catches:

- missing spaces
- small spelling mistakes
- reordered words

### Step 3. Embedding Similarity Match

Generate an embedding for the user’s entity phrase and compare it only against candidate rows from the same workspace and entity type.

### Step 4. Combined Scoring

Compute a final score using:

- exact/alias score
- trigram/fuzzy score
- embedding cosine similarity
- optional popularity/context boosts

Before blending, each signal source must be calibrated independently.

Important:

- trigram similarity
- edit-distance style scores
- token overlap
- embedding cosine similarity

do not share the same raw scale or distribution.

Therefore:

1. each signal must be normalized independently
2. blended ranking must use calibrated values, not raw scores
3. production thresholds must be tuned using labeled evaluation data, not assumed directly from numeric intuition

Recommended approach:

- percentile-rank or z-score normalize each signal within the candidate set
- apply weighted blending afterward
- evaluate by entity type and by risk class

Do not treat raw embedding similarity as a direct confidence percentage.

### Step 5. Decision Gate

Based on confidence:

- high confidence: auto-resolve for read-only flows
- medium confidence: ask `Did you mean X?`
- low confidence: return `I couldn't find that project in this workspace.`

### Step 6. Confirmation for Mutations

For mutations, even a strong fuzzy/embedding match may still require confirmation when:

- the input was clearly misspelled
- there are close competing candidates
- the action has planning/access impact

Read-only analytics can be more permissive than mutations, but still must not cross entity type.

---

## 12. Confidence Policy

Recommended starting policy:

- `>= 0.92`
  - auto-resolve for read-only actions
- `0.80 - 0.9199`
  - ask for confirmation
- `< 0.80`
  - not found

Additional override rules:

- if top 2 candidates are very close, force clarification
- if candidate type does not match requested scope, reject
- if mutation is high impact, require stricter confirmation

These thresholds should be configuration-driven, not hardcoded in multiple files.

### 12.1 Different Policy By Flow

The thresholds above are a default baseline only.

Production behavior should vary by flow:

- navigation/help: most permissive
- read-only analytics: permissive but still typed
- low-risk mutation: stricter
- high-impact mutation: strictest

Suggested policy:

- read-only:
  - strong match may auto-resolve
- low-risk mutation:
  - typo/fuzzy/embedding match often requires confirmation
- high-impact mutation:
  - require confirmation unless exact/alias match is unambiguous

This prevents the read path from being as rigid as mutations while preserving safety.

### 12.2 Score Gap Rule

The “top 2 candidates are very close” rule must be implemented explicitly.

Recommended starting policy:

```ts
const relativeGap = (score1 - score2) / Math.max(score1, 0.0001);
```

If:

- `relativeGap < 0.05`

then force clarification, even if the top score would otherwise pass the normal confidence threshold.

This value is a starting point and must be tuned with labeled evaluation data, but the rule itself must be explicit and shared across callers.

---

## 13. Data Model Changes

### 9.1 Extend Embedding Coverage

Use the existing `AiEmbedding` table for:

- `ISSUE`
- `PROJECT`
- `TEAM`
- `DEPARTMENT`
- `MEMBER`
- `CYCLE`

No separate table is needed.

### 9.2 New Alias Storage

Entity resolution quality improves significantly with aliases.

Add alias support for:

- projects
- teams
- departments
- cycles
- optional member aliases/display variants

Recommended V1 shape:

```prisma
model EntityAlias {
  id          String   @id @default(uuid())
  workspaceId String
  entityType  EntityAliasType
  entityId    String
  alias       String
  normalized  String
  locale      String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

Alias policy must be explicit.

Recommended policy:

- duplicate normalized aliases may exist across entities in the same workspace and entity type
- such collisions must be treated as ambiguous-by-construction
- they must never auto-resolve silently

If stricter alias uniqueness is preferred later, it should be added deliberately by product policy rather than left undefined.

This allows:

- nicknames
- product short names
- localized names
- transliterations

### 13.3 Optional Resolver Snapshot Row

For later observability, we may store resolution decisions:

- requested text
- candidate list
- confidence
- chosen entity
- whether user confirmed

This is optional for V1 but useful for tuning.

---

## 14. What Gets Embedded

For each entity, embed a compact searchable text.

### Project

- project name
- aliases
- department name
- team names
- short description if present

### Team

- team name
- aliases
- department name
- project names

### Department

- department name
- aliases

### Member

- display name
- aliases
- team names
- department names

### Cycle

- cycle name
- aliases
- team name
- goal/summary if present

Do not embed large blobs unnecessarily.

Keep content compact and stable.

---

## 15. Multilingual Support

Embeddings can help with multilingual prompts, but only partially.

### 11.1 What Embeddings Help With

- translated descriptive phrases
- mixed-language prompts
- semantic closeness across languages

### 11.2 What Still Needs Aliases

- brand names
- phonetic variants
- local nicknames
- organization-specific shorthand

### 11.3 Recommendation

Multilingual entity support must use both:

- embeddings
- alias storage with optional locale

Do not rely on embeddings alone for multilingual production accuracy.

---

## 16. Safety Rules

These rules are mandatory:

1. never answer a scoped request using a different entity type
2. never fabricate an entity
3. never silently resolve a low-confidence candidate
4. never execute mutations against fuzzy matches without confirmation when risk is non-trivial
5. always keep workspace filtering on every candidate search and vector search
6. never search embeddings outside the current workspace
7. never allow unresolved broad business questions to continue into unrelated tools
8. never treat page context as a hard override over user text

### 16.0 Irreversible No-Delete Policy

This is a hard system rule:

Trussen AI must never delete or execute irreversible destructive operations for:

- project
- issue
- member
- team
- department
- workspace
- billing/subscription state
- API keys or credentials where policy forbids AI execution
- any other irreversible data removal path not explicitly approved at the product policy level

Delete-style user requests may still be recognized as intents, but they must resolve to blocked policy handling, manual guidance, or safe alternatives only when explicitly allowed.

### 16.1 Unresolved Intent Rule

If the intent layer cannot classify the question strongly enough:

- clarify, or
- fall back to general safe assistance

Do not force a business question into analytics/roadmap/members just because one keyword appeared.

---

## 17. Tooling Changes

### 17.0 Action Registry Requirement

The orchestration layer must not route ad hoc from intent to tools.

It must use a structured registry like:

```ts
type ActionRegistryEntry = {
  intent: string;
  requiredEntityTypes: Array<"project" | "team" | "department" | "member" | "cycle" | "issue" | "workspace">;
  requiredSlots: string[];
  riskLevel: "low" | "medium" | "high" | "blocked";
  executionMode: "query" | "mutation" | "blocked";
  executor: string;
};
```

Conceptually:

```txt
intent -> requiredEntities -> requiredSlots -> riskLevel -> executor
```

Examples:

- `CREATE_PROJECT` -> `project name` -> `mutation` -> `create_project`
- `ASSIGN_ISSUE` -> `issue`, `assignee` -> `mutation` -> `assign_issue`
- `INDIVIDUAL_REPORT` -> `member` -> `query` -> member analytics/report loader
- `PROJECT_REPORT` -> `project` -> `query` -> project analytics/report loader
- `APP_NAVIGATION_HELP` -> none or optional route context -> `query` -> app/help responder
- `DELETE_REQUEST_BLOCKED` -> varies -> `blocked` -> policy response only

Without this registry, orchestration will drift back into scattered conditional logic.

### 17.0.1 Capability Registry

As the product grows, orchestration should target a capability registry rather than hardwiring intent directly to one executor path.

Conceptually:

```txt
intent -> capability registry -> planner -> executors
```

Capabilities should be discoverable and composable.

Examples:

- `read_project`
- `create_issue`
- `assign_issue`
- `generate_report`
- `search_documents`
- `read_github_activity`
- `read_slack_context`
- `read_drive_file`
- `read_calendar_events`

This prevents the architecture from collapsing into one giant intent-to-tool switch statement as features increase.

### 17.1 New Internal Resolver API

Add internal resolver functions like:

```ts
resolveProjectEntity(input)
resolveTeamEntity(input)
resolveDepartmentEntity(input)
resolveMemberEntity(input)
resolveCycleEntity(input)
```

Each should return:

```ts
type EntityResolutionResult = {
  status: "resolved" | "confirm" | "ambiguous" | "not_found";
  entityType: "project" | "team" | "department" | "member" | "cycle";
  match?: { id: string; name: string };
  confidence?: number;
  candidates?: Array<{ id: string; name: string; confidence: number }>;
  reason: string;
};
```

### 17.2 AI Action-State Integration

`ai.action-state.ts` should stop performing entity matching itself and instead call the shared resolver.

This avoids:

- duplicate matching logic
- inconsistent behavior between flows
- regressions when one path is fixed but another is not

### 17.3 Semantic Orchestration Integration

The orchestration layer should:

1. classify semantic intent
2. resolve context
3. derive expected entity types
4. extract and validate required slots
5. call the resolver
6. perform permission and policy checks
7. apply risk policy
8. consult the capability registry
9. run the execution planner
10. pick deterministic query loaders or mutation executors
11. observe execution results
12. continue the loop if more steps or clarification are needed
13. pass fetched data to the answer synthesis layer

The resolver is one part of the orchestration system, not the whole system.

### 17.4 Confirmation-State Contract

Risky or preview-based actions require a persisted or durable temporary confirmation state.

Minimum contract:

```ts
type PendingActionState = {
  pendingActionId: string;
  intent: string;
  resolvedEntities: Record<string, string>;
  slots: Record<string, unknown>;
  riskLevel: "low" | "medium" | "high" | "blocked";
  previewText: string;
  expiresAt: string;
};
```

Recommended additional fields:

- `conversationId`
- `workspaceId`
- `userId`
- `confirmationRequired`
- `executor`
- `executorArgsHash`
- `createdAt`
- `updatedAt`

This state is required so prompts like:

- `yes`
- `confirm it`
- `go ahead`
- `cancel`

can be handled safely and deterministically.

The confirmation state must bind to the exact action previewed. The system must not reinterpret the action at confirmation time.

### 17.4.1 Confirmation-State Lifecycle

The system must explicitly define what happens if the user does not answer the confirmation immediately.

Rules:

1. confirmation state expires at `expiresAt`
2. `confirm`, `yes`, `go ahead`, or equivalent confirmation language applies only to the currently active pending action for that conversation/user/workspace
3. `cancel`, `stop`, or equivalent cancellation clears the pending action
4. if the user asks an unrelated new top-level request while confirmation is pending, the system must follow one consistent policy

Recommended policy:

- unrelated top-level requests invalidate the pending confirmation unless product UX explicitly requires sticky confirmations

This avoids stale confirmations attaching to the wrong later request.

### 17.5 Executor Result Contract

All deterministic executors should return a standardized result envelope.

Example:

```ts
type ExecutorResult = {
  success: boolean;
  payload: Record<string, unknown> | null;
  warnings: string[];
  nextSuggestions: string[];
};
```

This prevents every executor from inventing its own result shape and simplifies:

- planner continuation logic
- response synthesis
- observability
- retries and failure handling

---

## 18. Production Build Order

This architecture should be built as one coherent production system, but implementation still needs a logical execution order.

Recommended build order:

1. hard-stop unsafe fallback behavior
2. define semantic intent families and caller contract
3. extract shared entity resolution service
4. add alias support
5. add deterministic fuzzy matching
6. wire analytics and project-health callers first
7. wire invite/member/team/project/cycle operational flows
8. extend embeddings to non-issue entities
9. apply confidence thresholds by risk level
10. add observability and tuning loops

---

## 19. First Integration Order

The first callers to migrate should be:

1. project health and project analytics questions
2. invite/member resolution
3. project/team/department membership actions
4. project/team/cycle CRUD
5. document scoping

This order matches the highest user-facing correctness risk.

---

## 20. Testing Strategy

Coverage must include:

### Exact

- exact project name
- exact alias

### Typo / Fuzzy

- one-character typo
- swapped characters
- missing space
- partial mention

### Ambiguity

- two projects with close names
- team and project sharing similar labels

### Not Found

- entity does not exist
- unrelated text

### Multilingual / Alias

- localized alias
- transliterated alias

### Safety

- project prompt must not return a member report
- stale pending state must not contaminate later requests
- mutation must require confirmation where policy demands it
- context-only resolution must not silently mutate the wrong entity
- ambiguous aliases must not auto-resolve

### Intent Convergence

- `is Ridely on track?`
- `I think Ridely is in bad shape`
- `tell me current shape of Ridely`
- `how is Ridely doing?`
- `is Ridely at risk?`

These should converge to the same business intent family before entity resolution.

### Generic Question Robustness

- `what is my rle`
- `what is my role`
- `what access do I have`

These should converge to the same role/access intent family with typo tolerance.

### Planner / Loop

- one request producing multiple plan steps
- one request requiring clarification mid-plan
- one request continuing after confirmation
- unrelated interruption during pending confirmation

### Conversation Memory

- `assign it to Ali`
- `move that to review`
- `compare it with USingle2`
- long conversations where references still resolve correctly

### Adversarial

- random emojis
- broken grammar
- mixed languages
- empty prompts
- half-finished thoughts

### Recovery

- wrong entity guessed then corrected by user
- planner replans after clarification
- ambiguous alias then resolved explicitly

### Long Conversations

- after 40 to 60 turns, current context still behaves safely
- stale context does not override new explicit user intent

---

## 21. Observability

Log these fields on every resolution attempt:

- workspaceId
- requested entity type
- raw text fragment
- top candidates
- chosen candidate
- confidence
- resolution status
- whether confirmation was required
- triggering intent
- whether the resolution was context-only
- whether the resolution failed, was ambiguous, or returned not found

Add metrics for:

- exact-match rate
- confirmation rate
- not-found rate
- wrong-resolution correction rate
- per-intent fallback rate
- unresolved-intent clarification rate
- replanning rate
- confirmation-expiration rate
- context-only resolution rate
- executor warning rate

Observability must cover:

- successful resolutions
- ambiguous resolutions
- confirm-needed resolutions
- not-found resolutions
- blocked-policy resolutions
- plan creation and plan step execution
- multi-step continuation counts
- conversation-memory-assisted resolutions

This is necessary to tune thresholds safely.

---

## 22. Token Strategy

Entity resolution and orchestration should stay mostly non-chat and non-agentic.

Preferred order:

1. deterministic intent features
2. optional cheap-model intent classification when needed
3. deterministic exact/alias/fuzzy matching
4. embedding retrieval
5. AI only for final user phrasing when needed

Do not send the full workspace catalog to the model just to resolve one entity.

This keeps token usage low while improving resolution quality.

---

## 23. Recommended Immediate Next Step

Implement the orchestration-safe resolver in this order:

1. hard-stop unsafe fallback behavior
2. define semantic intent families and caller contract
3. extract shared project/team/member resolution service
4. add alias support
5. add fuzzy scoring
6. wire project-health and analytics callers first
7. extend `AiEmbedding` usage to non-issue entities
8. add confirmation thresholds by risk level
9. wire invite/membership/CRUD flows after analytics

This gives the largest correctness improvement fastest while staying production-safe.

---

## 24. Final Standard

Trussen AI must behave like this:

- If it knows the entity confidently, it proceeds.
- If it is fairly sure, it asks.
- If it does not know, it says so.
- It never invents the wrong target just to keep the conversation moving.
- It understands broad business questions semantically instead of depending on exact phrase triggers.

That is the required quality bar for analytics, CRUD, and operational AI inside the app.
