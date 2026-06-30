---
name: trussen-phase20h-fix
description: Use when fixing Trussen AI routing, entity resolution, conversation memory, planner, capability-registry, safety-policy, or executor fallback issues. Always align the fix to Phase 20H architecture in docs/setup/phase20h-entity-resolution-and-embedding-plan.md instead of adding one-off phrase-coupled or intent-specific patches.
---

# Trussen Phase 20H Fix

Use this skill when working on Trussen AI behavior in `modules/ai`.

Before editing code, read:
- `../../docs/setup/phase20h-entity-resolution-and-embedding-plan.md`

## Goal

Fix the issue in a way that moves the system toward the Phase 20H target architecture:

`normalization -> semantic intent -> memory -> entity extraction -> entity resolution -> slot validation -> capability registry -> planner -> deterministic execution -> AI explanation`

Do not ship narrow fixes that bypass this flow unless the user explicitly asks for a temporary patch.

## Required Fix Rules

1. Do not add phrase-coupled routing as the primary fix.
2. Do not add language-specific keyword lists as the primary fix.
3. Do not hardwire behavior in `ai.chat.ts` if it belongs in classifier, memory, resolver, capability registry, planner, or preflight slot handling.
4. Do not let unresolved requests fall through to unrelated tools or entity types.
5. Do not expose or execute destructive delete behavior.
6. Prefer generic slot clarification over capability-specific fallback text.

## Fix Order

When investigating an issue, determine which layer is actually wrong:

1. `ai.text-normalization.ts`
2. `ai.intent.ts`
3. `ai.memory.ts`
4. `ai.action-state.ts`
5. `ai.entity-resolution.ts`
6. `ai.capabilities.ts`
7. `ai.planner.ts`
8. `tools/tool-executor.ts`
9. `ai.chat.ts`

Only patch `ai.chat.ts` when the issue is truly presentation/synthesis or final loop control. If a fix in `ai.chat.ts` starts encoding business logic, stop and move that logic to the correct upstream layer.

## Expected Patterns

### If the bug is about user wording

- Fix semantic classification or entity extraction/resolution.
- Do not add more brittle phrase branches unless they are low-risk deterministic shortcuts for obvious CRUD/navigation.

### If the bug is about `it/that/this/confirm`

- Fix conversation memory or preflight continuation handling.
- Reuse `currentProjectId`, `currentIssueId`, `currentTeamId`, `currentCycleId`, `lastResolvedEntities`, and `recentReferences`.

### If the bug is about wrong clarification

- Fix required-slot validation or ambiguity handling in `ai.action-state.ts`.
- Clarification should ask only for the missing slot.

### If the bug is about wrong tool or wrong execution shape

- Fix `ai.capabilities.ts`, `ai.planner.ts`, or `tools/tool-executor.ts`.
- Keep executor outputs aligned to the shared `ExecutorResult` contract.

### If the bug is about fallback text showing internal behavior

- Fix final reply synthesis.
- Never show internal tool names, planning steps, or execution narration to the user.
- But keep the fallback generic and capability-driven, not a one-off branch for a single intent.

## Validation

For every fix:

1. Add or update a regression test near the broken layer.
2. Prefer tests that prove the generic behavior, not only the exact reported sentence.
3. Run relevant tests.
4. Run `npm run build` in `project_management_node`.

## Done Criteria

A fix is aligned only if:

- it solves the reported issue
- it reduces architectural drift from Phase 20H
- it does not introduce new phrase-coupling or special-case hacks
- it preserves deterministic safety and permission boundaries
