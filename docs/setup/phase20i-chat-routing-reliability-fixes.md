# Phase 20I — Trussen AI Chat: Reliability Fixes + Routing Architecture Status

> Companion to [phase20g-trussen-ai-token-efficiency-plan.md](./phase20g-trussen-ai-token-efficiency-plan.md) and [phase20f-trussen-ai-coverage-and-analytics-plan.md](./phase20f-trussen-ai-coverage-and-analytics-plan.md).
> This document records: (1) what was actually broken and got fixed in this pass, (2) in plain language what that means for the product, and (3) what is still outstanding from the "make it feel like ChatGPT" proposal — none of which has been implemented yet.

---

## 0. Why this document exists

A live trace of "tell me about my current issues" → "yes" surfaced several real, reproducible bugs in the Trussen AI chat pipeline (`modules/ai/ai.chat.ts`, `modules/ai/ai.intent.ts`, `modules/ai/tools/`). Six were fixed and verified in this pass. A separate, larger architectural change (shrinking the regex-first intent router) was proposed, discussed, but **not implemented** — this doc draws a hard line between the two so it's unambiguous what shipped and what didn't.

---

## Part 1 — Technical: What Was Implemented vs. What Was There Before

### 1.1 `get_team_workload` had no permission check in workspace-wide mode

**File:** `modules/ai/tools/tool-executor.ts:2190-2207`

| | Before | After |
|---|---|---|
| Behavior | `get_team_workload` called without a `teamId` ranked every workspace member by open-issue count, with **zero role check**. Any `MEMBER` (or `GUEST`, since AI is role-open at the route level) could get workspace-wide workload data. | Same call now checks `isAdmin(ctx)` when `teamId` is omitted and returns `403`-equivalent `{ success: false, error: "Workspace-wide workload data requires admin or owner access" }` for non-admins, matching the existing gate on `get_workspace_analytics`. |
| Root cause | The tool had a private-team visibility check for the *scoped* case but no check at all for the *unscoped* (workspace-wide) case — an asymmetric gap. | Team-scoped calls are unchanged; only the previously-ungated workspace-wide path is now gated. |

### 1.2 `create_issue` bypassed the real issue service

**File:** `modules/ai/tools/tool-executor.ts:811-880`, service: `modules/issue/issue.service.ts:733`

| | Before | After |
|---|---|---|
| Implementation | AI's `create_issue` did a raw `prisma.$transaction` reimplementing issue creation from scratch inside the AI module. | AI's `create_issue` now calls `issueService.createIssue(workspaceId, userId, input, role)` — the same function the normal `POST /issues` route uses. |
| Consequence of the bug | AI-created issues silently skipped: active-template application, per-project workflow status-entry validation, cycle-assignability checks, assignment notifications, Socket.IO realtime broadcast to other connected users, and integration (Slack/GitHub/Discord) event dispatch on high/urgent issues. | All of the above now happen automatically, because they live in the shared service, not duplicated AI-side logic. |
| Side fix | The AI tool also independently called `triggerIssueBackgroundJobs(...)` after creating the issue. | Removed — `issueService.createIssue()` already calls it internally (`issue.service.ts:1035`), so this was double-enqueuing embedding/label/priority-suggestion jobs on every AI-created issue. |

### 1.3 `activity_summary` referenced a field that doesn't exist

**File:** `modules/ai/tools/tool-executor.ts:3809-3833`

| | Before | After |
|---|---|---|
| Bug | `prisma.activity.findMany({ select: { message: true, ... } })` — the `Activity` Prisma model has no `message` field; the real column is `description` (`prisma/schema.prisma:1201`). | Select and mapping changed to `description: true` → `message: item.description`, matching the same `message`-param-to-`description`-column convention already used by `logActivity()` (`shared/utils/activity.ts:142`). |
| Impact | Calling this tool would have thrown a Prisma validation error at runtime — this was **not** related to the conversation bug being investigated; it was found independently via a stale IDE type-check diagnostic and confirmed against the live generated Prisma types. | Tool now works. |

### 1.4 The canned-plan reply path was fully stateless

**File:** `modules/ai/ai.chat.ts` — `executeDeterministicPlanTurn` (was line ~751, now ~830), `formatPlannedExecutionReply` (~720), `formatResolvedToolReply` (~1010)

| | Before | After |
|---|---|---|
| What ran | Any message that matched a hardcoded regex intent (e.g. `MY_TASKS`) and produced a multi-step plan was answered by `formatPlannedExecutionReply()`/`formatResolvedToolReply()` using **only** `system + current-turn tool results` — zero prior conversation turns, zero rolling summary. | Both functions now accept `history` (last `MAX_DETERMINISTIC_REPLY_HISTORY_TURNS = 10` user/assistant turns, `ai.chat.ts:35`) and `conversationSummary`, injected the same way the free-form loop already does it. `buildRecentConversationTurns()` (`ai.chat.ts:729`) filters/maps/caps the raw history for this purpose. |
| Why it mattered | Only messages that *failed* to match any of the ~21 obvious-intent regexes ever reached the free-form loop, which already had full history. Since most everyday phrasing *does* match one of those regexes, most turns were effectively "conversational amnesia" turns. | The canned-plan majority path now has the same continuity the free-form minority path always had. |
| Known remaining gap | — | The separate "resolved pending-action continuation" branch (`ai.chat.ts:1274`, used when a user answers a clarifying follow-up question mid-slot-filling) still doesn't get history threaded in — fixing it cleanly requires hoisting the history query earlier in the function. Documented, not fixed, deliberately scoped out to keep this change small. |

### 1.5 Empty tool results were reported as unqualified negatives

**File:** `modules/ai/ai.chat.ts:743-751` (`hasEmptyListPayload`, `EMPTY_RESULT_GUIDANCE`)

| | Before | After |
|---|---|---|
| Behavior | If a canned plan's tool call returned an empty array (e.g. `list_issues` with `assigneeId: "me"` legitimately finding nothing), the model summarized it as a flat "you have none" with no framing. | When the observed payload is an empty list, an extra system instruction is injected telling the model to name the specific scope it checked and suggest one relevant alternative (created-by-me, watching, a specific project) — without claiming to have already checked those alternatives. |

### 1.6 Deterministic tool-completion fallback showed content-free text

**File:** `modules/ai/ai.chat.ts:556-570` (`summarizeEntityPayload`), used in `buildDeterministicToolCompletionResponse` (`ai.chat.ts:576`)

| | Before | After |
|---|---|---|
| Bug | When the free-form loop's token budget was exhausted mid-turn (see 1.7 below) and the code fell back to a deterministic summary instead of asking the model to format one, tools like `get_issue` — which return the raw entity, not a `message`/`meta.report` field — produced the literal string `"Completed get issue."` with **zero actual content**, once per tool call. | Added an entity-shape fallback: if the payload has an `id` and a `title`/`name`, build a compact one-line summary (`TRU-1 — <title> (status, priority)`) instead of the content-free stub. |
| Real-world symptom this fixed | User's exact reported output: three lines of `"Completed get issue."` after asking to see 2 high-priority issue details. | Same scenario now shows actual issue identifiers/titles/status even in the fallback path. |

### 1.7 The free-form loop sent all ~100 tool schemas on every call

**Files:** `modules/ai/tools/tool-definitions.ts:1631-1719` (new), `modules/ai/ai.intent.ts:166-190` (new), `modules/ai/ai.chat.ts` (wiring)

This was the root cause behind 1.6 actually triggering in practice.

| | Before | After |
|---|---|---|
| Payload | `callAIWithTools(messages, model, getToolDefinitions())` — always all 100 tool definitions, regardless of what the message needed. Measured: a single follow-up message ("yes") cost **13,063 input tokens** on the first model call alone — before any tool executed. | New `getScopedToolDefinitions(domains)` filters the 100 tools down to an always-included 8-tool core set plus only the domains detected as relevant (`detectToolDomains()`, `ai.intent.ts:187`). Domain detection scans the current message **plus the last 6 conversation turns**, so a bare "yes" still inherits the domain of what it's confirming from the prior assistant reply's text. |
| Budget consequence | `MAX_TOKENS_PER_TURN = 10,000` (`ai.chat.ts:35`) was frequently exhausted by the *first* call's prompt overhead alone, before a second call could run to actually synthesize an answer from tool results — code at `ai.chat.ts:1963-1970` (line numbers approximate post-edit) silently substitutes the deterministic fallback (see 1.6) instead of erroring. | With ~8-19 tools sent instead of 100 for a typical single-domain request, the first call's cost drops enough that a real synthesis follow-up call fits inside the budget. |
| Safety | — | Tool-call validation (`ai.chat.ts`, the "Validate tool name against whitelist" check) now checks the model's tool call against the **same scoped list** that was actually offered, not the full 100 — making scoping a real boundary instead of a cosmetic prompt-size optimization. If domain detection finds zero signal, it falls back to the full 100-tool list rather than risk under-provisioning a legitimately cross-domain request. |
| Verification | — | All 12 domain-detection regex patterns were unit-verified against representative phrasing in isolation (including catching and fixing two real bugs: `priorit`/`analytic` word-stems used with a trailing `\b`, which never matched "prioritize" or "analytics" at all). All 100 tool-name-to-domain mappings were cross-checked programmatically against the live `AI_TOOLS` array — zero typos, zero omissions, zero duplicates. |

### 1.8 A conversational follow-up ("tell me about them detail") got hijacked into an unrelated analytics-report clarification

**Files:** `modules/ai/ai.intent.ts:29-33` (new), `modules/ai/ai.intent.ts:317-336` (fixed), `modules/ai/ai.memory.ts:39` (export only)

This was the "it starts giving me project analytics I never asked for" bug, root-caused against a live trace rather than guessed at.

| | Before | After |
|---|---|---|
| Trace evidence | Log showed the model classifier correctly return `intent: "UNKNOWN", confidence: 0.3` for "tell me about them detail" (`intent_classifier_model_used`) — an honest "I don't know." But the final result still carried `capabilityCandidates` for `PROJECT_REPORT`/`PROJECT_HEALTH`, which then triggered `resolveAiPreflight` to open a `pendingAction: "analytics_report"` and ask "Which report should I prepare?" | Same message now resolves to `UNKNOWN` with **zero** capability candidates, so the analytics-clarification gate in `ai.action-state.ts:648` never fires and the message correctly falls through to the free-form tool-calling loop, which already has full history (including the specific issue IDs from two turns earlier) to answer from. |
| Root cause | Two compounding bugs in `ai.intent.ts`: (1) `looksLikeEntityBriefingRequest()` treats **any** "tell me about ___" phrasing as a scoped business-report request, with no check for whether "___" is a bare pronoun (`them`/`it`/`that`) referring to something already discussed vs. an actual new named topic. (2) `classifyAiIntentHybrid` (`ai.intent.ts:448`, pre-fix) unconditionally re-attached the **deterministic** classifier's `capabilityCandidates` onto the final result regardless of what the model itself concluded — silently overriding the model's own "UNKNOWN, no good guess" with a premature report-type guess. | Added `BACK_REFERENCE_PATTERN` (`ai.intent.ts:29-33`) and an `isBareBackReference` check: when the message contains a back-reference pronoun **and** has no explicit scope keyword (workspace/project/team/member/cycle) **and** no report-ish wording, `looksLikeEntityBriefingRequest`'s branch is skipped entirely, so no spurious candidates are generated for bug (2) to carry forward. Bug (2) itself was not changed — fixing bug (1) removes the bad input at the source, which is the more precise, lower-risk fix (broadly suppressing candidate-carry-over at (2) risked breaking legitimate cases where the deterministic guess should stand even when the model says UNKNOWN). |
| Verified NOT to break | "tell me about Ridely" (named project), "tell me about the project" (explicit scope word), "give me a report on them" (explicit report word) — all three still correctly trigger the report-scope clarification, confirmed via a standalone test script covering 6 cases before this was considered done, plus the existing `ai.intent.test.ts` suite (10/10 pass, unchanged). |
| Scope note | This is not limited to "tell me about them detail" specifically — it fixes the general class: any "tell me more about it/them/that/those/these" follow-up with no other topic signal now defers to full-context reasoning instead of guessing it's a report. |

### 1.9 Canned-plan replies stayed vague (counts only) even when the underlying data already had specifics

**File:** `modules/ai/ai.chat.ts` (`hasNamedEntityListPayload`, `LIST_RESULT_SPECIFICITY_GUIDANCE`, wired into both `formatPlannedExecutionReply` and `formatResolvedToolReply`)

| | Before | After |
|---|---|---|
| Symptom | Asking "give me the issues that are not completed" (routes to the `MY_TASKS` canned plan) returned "there are 2 tasks that are not yet completed" — never which ones — even though `list_issues`/`prioritize_tasks` already returned the full issue objects (ID, title, status, priority) to the synthesis call. Users had to rephrase repeatedly (sometimes accidentally escaping into the free-form loop, e.g. by using singular "issue" instead of plural "issues") to get an answer with actual content. | When the observed tool payload is a non-empty list of entity-shaped objects (has `id`/`title`/`name`), an added system instruction (`LIST_RESULT_SPECIFICITY_GUIDANCE`) tells the model to name the specific items instead of only stating a count. |
| Root cause | Not missing data — the full payload was always passed to the synthesis call. Purely a missing instruction: nothing ever told the model that counts alone were an insufficient answer for a list-shaped result. |
| Relationship to 1.5 | Symmetrical to the empty-result fix — 1.5 handles the zero-results case, 1.9 handles the "results exist but got summarized into nothing useful" case. Both are prompt-level fixes to the same two synthesis functions, not new code paths. |

### 1.10 The model fallback chain was two-thirds dead

**File:** `.env` (config only, no code change)

Not a code bug — a live production trace showed it directly:
```
[AI Provider] meta-llama/llama-3.3-70b-instruct:free error (HTTP 404): "This model is unavailable for free..."
[AI Provider] qwen/qwen3-coder:free error (HTTP 404): "This model is unavailable for free..."
[AI Provider] google/gemma-4-31b-it:free rate-limited. Retry after 10s.
```

| | Before | After |
|---|---|---|
| Config | `AI_CHAT_MODEL_FALLBACK_1/2` pointed at two free-tier OpenRouter slugs that had been silently discontinued (confirmed via a live fetch against OpenRouter's `/api/v1/models` on 2026-08-05 — neither exists anymore under those ids). `FALLBACK_3` was a free-tier model that was rate-limited at the time. | All three replaced with verified-live, cheap **paid** models across two providers: `google/gemini-3.5-flash-lite-20260721`, `google/gemini-3.5-flash-20260519`, `deepseek/deepseek-v4-flash-0731`. Cost is sub-cent per fallback invocation (fallback only fires when the primary already failed), and cross-provider redundancy means a DeepSeek-side outage doesn't take out the whole chain. |
| Consequence of the bug | Any primary-model hiccup triggered a chain that wasted ~10-18s retrying two guaranteed-dead endpoints plus a rate-limited one, and if the whole chain exhausted, `formatPlannedExecutionReply`'s `callAI()` threw, hit its catch block, and returned the bare deterministic fallback text (see 1.11) instead of a real answer. | Fallback attempts now hit models that actually exist, so both the latency tax and the total-failure fallback case become far rarer. |
| Why this matters beyond tonight | Free-tier model availability on OpenRouter is volatile by nature (providers can pull free access without notice, as evidenced by the two dead slugs here) — pinning production fallback behavior to free-tier slugs means this exact failure mode will recur periodically as the free catalog churns, regardless of anything else fixed in this pass. |

### 1.11 The deterministic fallback text had no case for list-shaped tool results

**File:** `modules/ai/ai.chat.ts` (`summarizeListPayload`, wired into `buildDeterministicToolCompletionResponse`)

Same failure family as 1.6 (`summarizeEntityPayload` for single-entity payloads like `get_issue`), but that fix didn't cover `list_issues`/`prioritize_tasks`-style tools, which return an **array**. `typeof [] === "object"` in JS, so the array was silently passed through the single-entity code path as if it were a plain object — `.id`/`.title` lookups on an array are always `undefined`, so it always fell through to the content-free `"Completed list issues."` stub. This is what 1.10's dead fallback chain was actually surfacing.

| | Before | After |
|---|---|---|
| Fallback text for a list result | `"Completed list issues.\nCompleted prioritize tasks."` — zero content. | `summarizeListPayload()` detects the array case explicitly, reuses the same per-item logic as `summarizeEntityPayload` for each entry (up to 10, with a "+N more" suffix beyond that), and renders a real bullet list of issue IDs/titles/status/priority. |
| When this path is actually hit | Only when the full model fallback chain (1.10) is exhausted — with 1.10 fixed, this should now be rare, but a production-ready system needs a real answer here regardless of how reliable the retry chain is in practice. |

### 1.12 Test status

All changes type-check clean (`tsc --noEmit` exit 0). Relevant suites (`ai.intent.test.ts`, `ai.planner.test.ts`, `mcp.tools.test.ts`, `ai.memory.test.ts`, `ai.action-state.test.ts`) pass — 24/24 on the fast suites plus the live-model suite. Three pre-existing flaky failures in `ai.action-state.test.ts` (live-model entity-extraction assertions, e.g. `"SulitCheck"` vs `"SulitCheck app"`) were confirmed present **before** any of this work started, unrelated to the files touched, and vary run-to-run (1-3 failures across separate runs) — consistent with live-model non-determinism, not regressions.

---

## Part 2 — In Plain Words

Think of the AI panel as having two brains:

- **Brain A (fast, free, rigid):** a big list of "if the message contains these words, do exactly this" rules. About 21 of them. Handles things like "create a bug," "my issues," "assign this to Sara."
- **Brain B (slower, costs money, flexible):** an actual AI model that reads the conversation and decides what to do, with access to every tool in the app.

Almost every message you type matches one of Brain A's rules, so Brain B rarely gets used — which is by design, for cost reasons.

**What was actually broken, in order of how bad it was:**

1. **The "who's overloaded workspace-wide" check had a hole.** Regular members could ask for company-wide workload rankings, which was supposed to be owner/admin-only. Fixed.
2. **AI-created issues were second-class.** When the AI created an issue for you, it skipped features that regular issue creation gets for free — like notifying the person you assigned it to, showing up live for teammates without a refresh, and applying your issue templates. Now AI-created issues go through the exact same path as issues you create by hand.
3. **One specific AI feature (activity summary) was just broken** — it referenced a database field that got renamed at some point and nobody updated this one spot. Found by accident while investigating something else, fixed.
4. **Brain A had no memory.** Even though the AI panel shows a running conversation, any message handled by Brain A (which is most messages) was answered as if it just woke up with no memory of anything you said before. Now it gets the last 10 messages of context, same as Brain B always had.
5. **"You have zero issues" used to be presented as a flat, final answer** even when it just meant "zero issues matched this one narrow definition of 'yours.'" Now it explains what it checked and offers to check somewhere else.
6. **The literal bug you hit** ("Completed get issue." three times, no actual content): when you said "yes" to seeing issue details, the AI had to send its full toolbox (100 tools) to the model just to figure out what to do — and that alone used up almost the entire budget it's allowed to spend per message. There was nothing left to actually describe the issues, so it fell back to a generic "done" message that, for this particular tool, had no useful text to fall back to at all. Two things fixed this: (a) that generic fallback message is now actually informative instead of empty, and (b) the AI now only sends the ~10-20 tools relevant to what you're asking instead of all 100, which frees up enough budget for it to actually answer.
7. **The "random project analytics" bug.** When you said "tell me about them detail" (referring to two issues from a couple messages back), the system's own model correctly said "I'm not sure what this means" — but then a separate piece of code overrode that honest answer and substituted its own premature guess that you must be asking for a project report, and started collecting information for that instead. Root cause: the phrase-matcher treats *any* "tell me about ___" as a report request, with no check for whether "___" is a real new topic or just a pronoun pointing at something you already said. Fixed — "tell me about it/them/that" with nothing else in the message now correctly defers to the part of the system that actually has your conversation history, instead of guessing "report."
8. **Why Brain A kept giving you a count instead of a list.** Even when Brain A had the full list of issues (IDs, titles, everything) sitting right there, nothing ever told it "don't just say how many — say which ones." It's fixed now: whenever a result is a list of named things, it's instructed to actually name them instead of summarizing down to a bare number.

None of this changed *when* Brain A vs. Brain B gets used — that's the "Large" item you're asking about next.

---

## Part 3 — What Remains: The "Large" ChatGPT-Style Change

1.8 and 1.9 fixed the two specific, most damaging instances of "rigid pattern-matching with no conversational context" that surfaced in live testing — but they were deliberately surgical (a targeted regex-exclusion, a targeted prompt instruction), not a change to the underlying architecture. The architecture that made both bugs possible in the first place — a large deterministic tier that pattern-matches on the current message in isolation — is still fully in place, and will keep producing new instances of this same failure class on phrasings not yet tested. The "Large" change below is what actually closes off the failure class instead of patching individual symptoms of it.

### 3.1 The three-part proposal, restated

1. **Shrink or remove Brain A** (the 21-rule regex tier in `classifyDeterministicObvious`, `ai.intent.ts:216-256`) so most messages reach Brain B by default instead of by exception.
2. **Make Brain B (the free-form tool-calling loop) the default path**, not the fallback — keep Brain A only for a small number of truly unambiguous cases (greetings, explicit delete-blocking, explicit navigation help).
3. **Accept the cost increase this causes** — more real model calls instead of free regex matches, which directly contradicts the cost-control rationale in `phase20g-trussen-ai-token-efficiency-plan.md`.

### 3.2 Current status: not started

Nothing in this pass touched `classifyDeterministicObvious()`. Every one of these still short-circuits straight to a hardcoded plan without ever consulting a model:

```
DELETE_REQUEST_BLOCKED, IRREVERSIBLE_ACTION_BLOCKED, REMOVE_MEMBER, INVITE_MEMBER,
CREATE_ISSUE, ASSIGN_ISSUE, UPDATE_PROJECT, ADD_COMMENT, UPDATE_ISSUE_STATUS,
CREATE_PROJECT, CREATE_TEAM, CREATE_DEPARTMENT, CREATE_CYCLE, LIST_PROJECTS,
MY_TASKS, SEARCH_ISSUES, OVERDUE_TASKS, BLOCKED_TASKS, APP_NAVIGATION_HELP,
ROLE_OR_ACCESS_QUESTION, GENERAL_APP_HELP
```
(`ai.intent.ts:216-256`, 23 `return capability(...)` sites total including the empty-input case.)

The tool-subsetting work in 1.7 is a **prerequisite** for this change (it makes Brain B affordable per-call), not the change itself.

### 3.3 What this would actually achieve

- **Right now:** the AI's behavior is only as smart as whichever of the 21 regex patterns your exact phrasing happens to match. Slightly unusual phrasing, compound requests ("show my overdue bugs in the mobile project and tell me if any are blocked"), or anything that doesn't map cleanly to one hardcoded plan either gets force-fit into the wrong plan or falls through to Brain B by accident rather than by design.
- **After this change:** the model itself decides which tool(s) to call and in what sequence for the large majority of messages, the way ChatGPT's tool-calling actually works — genuine reasoning about intent instead of pattern-matching, real handling of compound/ambiguous requests, and no more "the regex claimed this and now the fixed plan doesn't fit what I actually meant" failure mode (the exact class of bug that caused this whole investigation).
- **What it costs:** every one of those ~21 previously-free intents becomes a paid model call. With tool-subsetting already in place (1.7), each call is materially cheaper than it would have been a week ago, but it's still a real per-message cost increase — the phase20g doc's entire cost-optimization argument was built around *not* doing this by default.

### 3.4 Recommended next step (proposed, not started)

Move only the 3 task-summary intents (`MY_TASKS`, `OVERDUE_TASKS`, `BLOCKED_TASKS`) off the regex tier first, behind a routing-mode flag, and measure real cost/quality before deciding whether to extend it to the other ~18 rules. This was proposed in the prior discussion and remains the recommendation — smallest slice that validates the tradeoff before committing further.
