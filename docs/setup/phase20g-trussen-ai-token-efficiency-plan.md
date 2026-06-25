# Phase 20G - Trussen AI Token Efficiency and Quality Plan

> Purpose: reduce token usage in Trussen AI without degrading answer quality, action reliability, or permission safety.

---

## 1. Goal

The goal is **not** "use fewer tokens at any cost."

The goal is:

- maximize output quality
- minimize token usage
- never trade away correctness, permission safety, or operational reliability just to save tokens

This means Trussen AI should become:

- cheaper
- faster
- more deterministic
- more selective about what context it sends

It should **not** become:

- under-informed
- vague
- brittle
- dependent on the model guessing missing app state

---

## 2. Current Cost Problem

The current side-panel implementation is structurally expensive for normal requests.

Based on the current backend implementation in `modules/ai/ai.chat.ts`, token usage is being pushed up by three main patterns:

1. The system prompt is rebuilt with large lookup tables on every turn:
   - projects
   - members
   - teams
   - departments
   - labels
2. The conversation can include up to 30 recent messages before summarization pressure fully helps.
3. The full tool set is exposed every turn, even when the user intent is narrow.

For normal prompts like:

- create an issue
- assign a task
- invite a member
- show my issues

17k-25k tokens per turn is too high.

That level of usage should be reserved for:

- multi-step analytics
- broad workspace reporting
- complex planning synthesis
- document-heavy reasoning

---

## 3. What Sounds Correct in the Proposed Optimization Advice

Most of the advice is directionally correct.

### 3.1 Correct

- Do not send full workspace context every turn.
- Prefer tools over dumping database state into the prompt.
- Use intent-aware context loading.
- Send compact summaries instead of full records.
- Keep responses short by default.
- Use conversation summaries instead of long raw history.
- Route simple tasks to cheaper models.
- Put hard token budgets in code.

These are all good principles for Trussen AI.

### 3.2 Also correct, but with conditions

- Use RAG for docs/help content.
- Cache static prompt parts.
- Use a small classifier before the full agent.

These are valid, but only if implemented carefully. They are not automatic wins.

---

## 4. What Sounds Incomplete or Wrong

Some of the advice is right at a high level but too simplistic for Trussen.

### 4.1 "Use a tiny AI classifier first for every request"

Directionally useful, but not always the best first step.

What is right:

- routing by intent is valuable
- cheap classification can reduce downstream context

What is wrong:

- an extra model call on every request can itself become wasteful
- many requests can be routed deterministically without an LLM at all

Better rule:

1. Use deterministic routing first for obvious intents.
2. Use a cheap model only when intent is genuinely ambiguous.
3. Use the full agent only after routing and context shaping are done.

Examples of deterministic routes:

- `create issue`
- `assign`
- `invite`
- `show my issues`
- `mark done`

### 4.2 "Use RAG" as a general optimization

RAG is not a universal token fix.

Correct use:

- workspace docs
- project briefs
- SOPs
- policies
- historical decisions

Wrong use:

- replacing direct DB/tool queries for structured entities
- retrieving issue/task lists that should come from normal filters
- retrieving team/member/project basics that should come from the relational model

For Trussen:

- use tools for structured app state
- use RAG for unstructured knowledge

### 4.3 "Just cache the system prompt"

This is only partially correct.

Provider-side prompt caching can help, but:

- support varies by provider/model
- cache hits are not guaranteed
- dynamic lookup tables reduce cache effectiveness

Better approach:

- shrink the prompt first
- make the stable prefix actually stable
- cache only after prompt shape is disciplined

### 4.4 "Last 4 messages plus summary" as a universal rule

Too rigid.

Sometimes 4 messages are enough. Sometimes they are not.

Better rule:

- keep a compact rolling summary
- keep the pending action state explicitly
- keep only the most relevant recent turns, not an arbitrary number

The important thing is not "4 messages."

The important thing is:

- preserve action continuity
- preserve clarifications
- preserve unresolved confirmations
- drop irrelevant chatter

### 4.5 "Use smaller models for simple tasks"

Correct, but only if the output contract is narrow.

Good uses:

- field extraction
- issue title cleanup
- role/date/priority parsing
- short rewrites

Risky uses:

- permission-sensitive orchestration
- multi-step planning
- analytics synthesis with nuance
- ambiguous entity resolution across scopes

Model routing should follow task risk, not just task length.

---

## 5. Recommended Architecture for Trussen

The right architecture is:

User message
-> deterministic router
-> permission/access check
-> context loader by intent
-> small-model extraction only if needed
-> tool-calling agent with a trimmed tool set
-> short final response

Not:

User message
-> full workspace prompt
-> full history
-> full tool list
-> one large model does everything

---

## 6. The Highest-Impact Token Savings for the Current Implementation

These are the biggest wins for the codebase as it exists today.

### 6.1 Stop rebuilding full lookup tables for every turn

Current expensive pattern in `ai.chat.ts`:

- inject projects
- inject all visible members
- inject teams
- inject departments
- inject labels

This should be replaced with selective lookup context.

Examples:

- issue creation:
  - relevant projects
  - relevant labels
  - maybe relevant members if assignee is mentioned
- invite flow:
  - team list
  - allowed roles
- analytics:
  - no giant lookup table
  - resolve only the referenced scope

Do not send all visible members to the model for every task.

### 6.2 Expose only the tools relevant to the routed intent

Tool definitions themselves cost tokens.

If the request is:

- create issue

the model does not need:

- invite tools
- analytics tools
- cycle tools
- project creation tools

Trussen should define tool bundles by route:

- issue bundle
- membership bundle
- analytics bundle
- project bundle
- docs bundle

### 6.3 Reduce raw history aggressively

Current history depth is generous.

Instead:

- keep pending action state in code
- keep a rolling summary
- keep only recent relevant messages

The model should not need a long transcript to remember:

- who the user wanted to invite
- which project they meant
- whether confirmation is still pending

That state should live outside the prompt whenever possible.

### 6.4 Trim tool results before feeding them back

The current implementation already compacts tool results. That is correct and should be expanded further.

Rules:

- never return large arrays unless the user asked for them
- default list limits should stay low
- use summaries first, details on follow-up
- provide counts and top items before raw records

### 6.5 Default to compact final answers

The assistant should not narrate internal work.

Default response style:

- short confirmation
- key result
- next useful action if needed

Avoid:

- repeating the whole prompt
- repeating tool inputs
- verbose explanations for simple mutations

---

## 7. Routing Strategy

### 7.1 Deterministic router first

Build a first-pass router with rule-based detection for common operational intents:

- create issue
- update issue
- assign issue
- invite member
- create project
- create team
- get analytics
- show notifications

This router should output:

- `intent`
- `confidence`
- `requiredContext`
- `allowedToolBundle`

### 7.2 Cheap extractor second

Only if needed, run a cheap extraction model to pull:

- project/team/member references
- priority
- status
- due date
- role
- report date range

This is cheaper than using the main model for everything.

### 7.3 Full agent last

Only invoke the more capable agent when:

- multiple tools are needed
- ambiguity remains
- the user asked for analysis or synthesis
- analytics/reporting requires reasoning

---

## 8. Context Loading Rules

Context should be loaded by intent, not by habit.

### 8.1 Issue creation

Send:

- current workspace id
- user role
- likely project candidates
- label names if needed
- member candidates only if assignee language exists

Do not send:

- full analytics
- long issue lists
- all members by default

### 8.2 Analytics

Send:

- resolved scope
- date range
- aggregated metrics from tools
- trend summaries

Do not send:

- raw issue dumps unless the user explicitly drills in

### 8.3 Team and membership operations

Send:

- target team/department candidates
- allowed roles
- membership constraints

Do not send:

- unrelated project and issue context

### 8.4 Documents and uploads

Send:

- document scope
- existing folders if needed
- upload handoff state

Do not pretend attachment state exists in the prompt if there is no real file artifact.

---

## 9. Model Routing Policy

Use model tiers based on task complexity and risk.

### 9.1 Small / cheap model

Use for:

- intent classification when deterministic routing is insufficient
- field extraction
- title rewriting
- short description polishing
- short report phrasing from already-computed metrics

### 9.2 Main orchestration model

Use for:

- multi-tool workflows
- clarifications with ambiguity
- safe mutation orchestration
- analytics synthesis
- planning and progress reasoning

### 9.3 Hard rule

Do not use the main model for tasks that can be handled by:

- rules
- SQL
- direct tool output
- deterministic formatting

---

## 10. Prompt Design Rules

### 10.1 Make the stable prefix truly stable

The base system prompt should contain only:

- role
- safety rules
- style rules
- action boundaries

It should not contain:

- large dynamic lookup tables
- long per-workspace enumerations
- repeated examples that can live in code

### 10.2 Put dynamic state in structured slots

Instead of giant prose blocks, pass compact structured context such as:

```json
{
  "currentUser": { "id": "usr_123", "name": "Shaheer", "role": "ADMIN" },
  "workspace": { "id": "ws_123", "name": "Shaheer Project" },
  "pageContext": { "entityType": "project", "entityId": "proj_9", "entityName": "USingle2 App" },
  "intent": "create_issue"
}
```

### 10.3 Keep tool instructions short

Do not over-explain every tool in the prompt.

The schema should be enough for the model to act.

---

## 11. Conversation Memory Strategy

Trussen should use three memory layers:

1. Pending action state
2. Rolling conversation summary
3. Minimal recent messages

### 11.1 Pending action state

This should store:

- unresolved slots
- ambiguity candidates
- confirmation-required actions
- current target entities

This is more important than raw transcript length.

### 11.2 Rolling summary

Store:

- what the user is trying to do
- confirmed preferences
- current scope
- important resolved references

Do not store:

- wordy paraphrases
- full tool logs
- full assistant prose

### 11.3 Recent messages

Keep only what is still relevant to the active task.

The retention rule should be semantic, not fixed-length only.

---

## 12. Output Control Rules

### 12.1 Default response caps

Use explicit max output tokens by task class.

Suggested defaults:

- create/update confirmation: 120-250
- short query answer: 200-400
- issue summary: 300-500
- analytics summary: 500-900
- detailed report: 1200-1800

### 12.2 Output style

Default:

- concise
- structured
- no reasoning dump
- no internal tool names
- no provider/model names

### 12.3 Expand only on demand

If the user wants more detail, then grow the answer.

Do not spend output tokens eagerly.

---

## 13. Caching Strategy

### 13.1 Safe to cache

- system prompt prefix
- tool bundle definitions
- team/project/member lookup summaries with short TTL
- analytics aggregates for a short reporting window
- navigation/help responses

### 13.2 Unsafe or limited cache

- mutation outputs
- permission-sensitive stale state
- anything tied to fresh membership or role changes

### 13.3 Important rule

Caching is a multiplier, not a substitute.

If the prompt is bloated, caching just hides the symptom temporarily.

---

## 14. Token Budgets for Trussen

These targets are more realistic for the product.

### 14.1 Target total token ranges

- create issue: 1k-4k
- assign/update issue: 1k-3k
- invite member: 1.5k-4k
- simple query: 1k-3k
- project/team creation: 2k-5k
- analytics summary: 4k-8k
- complex multi-step analysis: 8k-15k

Normal operational prompts should not live in the 17k-25k range.

### 14.2 Budget enforcement

Each routed intent should define:

- max prompt tokens
- max output tokens
- max tool calls

If the context builder exceeds the budget:

1. trim optional context
2. reduce candidate lists
3. convert raw records to summaries
4. ask a narrow clarification instead of sending more data

---

## 15. Immediate Implementation Priorities

This should be the order of work after Phase 20F.

### Phase 20G.1 - Prompt and context trimming

- remove large lookup tables from the default system prompt
- replace them with intent-specific compact context
- reduce default history payload
- keep pending action state outside the prompt

### Phase 20G.2 - Tool bundling and routing

- create intent-based tool bundles
- add deterministic first-pass router
- add cheap extractor for ambiguous field parsing

### Phase 20G.3 - Output and budget controls

- define per-intent token budgets
- define per-intent output caps
- tighten default list sizes and result summaries

### Phase 20G.4 - Caching and model routing

- cache stable prompt prefix
- cache short-lived lookup summaries
- route cheap tasks to cheap models
- reserve the main model for orchestration and analysis

### Phase 20G.5 - Measurement and regression control

- log prompt-token and completion-token usage by intent
- log context builder size by component
- log tool bundle size
- alert on budget regressions

---

## 16. Quality Guardrails

Token reduction must not break:

- permissions
- visibility rules
- pending action continuity
- confirmation flow
- auditability
- background suggestion relevance

If a token-saving technique makes the assistant more likely to:

- guess
- skip a clarification
- lose context
- choose the wrong entity
- execute the wrong mutation

then it is not a valid optimization.

---

## 17. Acceptance Criteria

This phase should be considered successful only when:

- normal side-panel CRUD requests no longer consume extreme token ranges
- quality remains stable or improves
- prompt context is loaded by intent, not by full workspace habit
- relevant tool bundles are smaller than the global tool set
- history payload is reduced without losing task continuity
- high-risk tasks still route through safe orchestration
- metrics prove lower token use by intent class over time

---

## 18. Bottom Line

The proposed advice is mostly correct in direction.

What was missing is the discipline to turn it into Trussen-specific engineering rules:

- deterministic routing before LLM routing when possible
- structured context instead of giant prose prompts
- tool bundles instead of all tools every turn
- pending-action state instead of long transcripts
- model routing by risk and complexity, not just by task type

That is how Trussen reduces token usage **without** paying for it through lower quality.
