# Phase 20J — The AI Side Panel: What It's Supposed To Be, In Simple Words

> This is not a plan and not a fix. This is a plain-language write-up of what I understand the AI side panel to actually be — the vision behind it, how it's built today, and where that construction is fragile — written as the shared starting point before we redesign it.

---

## 1. The one-sentence idea

Trussen AI is meant to be a coworker who already knows your whole workspace, sits in a panel next to your work, and can either **tell you things** ("who's overloaded") or **do things** ("move this to done") — just by you typing normal sentences, the way you'd ask a teammate.

It is explicitly not meant to be "a search bar with AI branding." The whole point is that it can act, not just answer.

---

## 2. Three different AI surfaces, one shared brain

The app actually has three separate places AI shows up, and it's easy to conflate them:

1. **The Issue Creator** — a small helper on the "create issue" form. You type 1-2 sentences, it fills out the form for you. Narrow, one job.
2. **The Side Panel (Trussen AI)** — this is the one this document is about. A persistent chat panel, like having a colleague permanently sitting next to your work, with memory of past conversations. This is the "power tool" — it can query, create, update, and analyze, not just answer questions.
3. **The Assistant Bubble** — a lighter, bottom-corner helper for "how do I do X in this app," brainstorming, and navigation. It's meant to be more like a help desk than an operator — it can suggest things but shouldn't be doing heavy workspace mutations.

All three (plus a fourth thing — an MCP server that lets *external* tools like Claude Desktop or Cursor connect to your workspace) are supposed to share **one underlying toolbox** of actions: "list issues," "create a project," "change a cycle," "get team analytics," and so on. The idea is you build each capability once, and every surface — chat panel, issue creator, assistant bubble, external AI clients — gets it for free. This part of the vision is real and mostly true in the code today: there is one shared list of ~100 actions, and all the surfaces call into the same functions.

---

## 3. Who gets to use it, and what they're allowed to see

This was the very first thing established about the concept, and it's foundational: **the AI must never have more power than the human using it.**

- A regular member typing into the panel can only see and touch what that member could see and touch by clicking around the app themselves.
- An owner/admin can ask "who's most overloaded across the whole company" and get a real answer. A regular member asking the same question should be told no, or should only get answers scoped to teams/projects they're actually part of.
- The AI is never allowed to delete anything — not issues, not projects, not comments, nothing — no matter who's asking. That's a hard rule, not a suggestion.
- Some actions (changing someone's role, removing a member, archiving something) are "big enough" that the AI should describe what it's about to do and wait for an explicit "yes" before doing it, rather than just doing it.
- Every action the AI takes on your behalf should show up in the normal activity log, tagged as AI-initiated, so nothing happens invisibly.

This permission model is genuinely built into the code (each action re-checks who's asking before running), and most of it works correctly. Tonight's work found and fixed several real cracks in it — places where the AI was accidentally more permissive than the actual app (letting a member see company-wide stress data it shouldn't) or accidentally less permissive (blocking a member from creating a project they're allowed to create).

---

## 4. How it decides what you meant

This is the part that matters most for the redesign conversation, so it's worth explaining carefully, because it's not one thing — it's two very different systems bolted together.

**System A — a big list of "if you said this exact kind of thing, do this exact thing" rules.**
About 20 hand-written pattern-matches. If your sentence contains "my" and "issues," it assumes you want your task list. If it contains "create" and "bug," it assumes you're making a bug. These rules are free (no AI cost) and instant, and they cover the most common, boring, everyday phrasings well.

**System B — an actual AI model reads your message and decides what to do.**
This only kicks in when System A's rules don't match anything. The model can reason about intent, pick which of the ~100 tools to call, call several in sequence, and hold a real back-and-forth conversation with memory of what was said before.

The intended design (documented, and reasonable) was: use System A for the boring, obvious, high-volume stuff to save money, and let System B handle everything else, with System B being the trustworthy fallback that "just works" for anything unusual.

**What's actually true tonight, after a lot of live testing:** System A is much bigger and much more eager than it should be — it tries to claim almost every message, including ones that are actually ambiguous, and when its guess is wrong, there's a second layer of hand-written "which specific team/project/person did you mean" logic sitting underneath it that has its own bugs (like locking onto the first guess and never revisiting it even when you explicitly correct yourself). System B — the real reasoning path — turned out to be more reliable than System A in almost every case we tested tonight. The "obvious rule" system is, ironically, the least trustworthy part of the whole thing.

---

## 5. What it can actually touch

Every action — read or write — is implemented once, in one place, as a "tool": `list_issues`, `create_project`, `get_team_analytics`, `change_workspace_member_role`, and so on. There are roughly 100 of these. A few important boundaries on this toolbox, by design:

- **No delete tools exist, anywhere, ever.** Not a policy the AI is told to follow — the delete capability simply isn't wired up as something it can call.
- Mutating actions are supposed to call the same underlying logic the normal app uses (the same code that runs when you click a button in the UI) — not a separate, simplified reimplementation. When this rule was violated (found in several places tonight), real things silently broke: no notification sent, no live update for other people looking at the same screen, template rules skipped, limits not enforced.
- Every mutation is protected against accidental double-execution (if your message gets retried, or the connection drops, it won't create the same issue twice).
- High-impact actions require you to confirm before they run, and that confirmation is checked on the server, not just trusted from the conversation.

---

## 6. Does it actually remember the conversation?

This should be a simple "yes," and it mostly is now, but it wasn't earlier tonight, and it's worth understanding why it's subtle.

The panel *shows* a running conversation, and stores every message. But whether a given reply actually *uses* that history depends on which of the two systems (A or B) handled it. System B (the real AI reasoning path) always had full memory of the conversation. System A's "fill in the missing detail" logic — the part that asks follow-up questions like "which team?" — did not consult the conversation at all for a while; it treated every follow-up as if it had no memory of what was already said, which is why it could ask the same question forever even after you'd already answered it. That's been fixed, but it's a good example of how the "two systems" split causes inconsistent behavior that looks like the AI is being inconsistent about something as basic as remembering what you just said.

---

## 7. Where this breaks down, honestly

The pattern behind essentially every bug found and fixed tonight was the same shape: **someone had to think of a specific phrasing, a specific edge case, or a specific entity type in advance, and write a rule for it — and anything not thought of in advance falls through the cracks.** Concretely:

- A permission check existed for one tool but was forgotten on its near-identical sibling tool.
- A "which team did you mean" clarification loop assumed people never change their mind mid-conversation.
- A word like "stressed" wasn't on the list of words that trigger "show me the team breakdown," so the exact same request sometimes worked great and sometimes got stuck — depending on phrasing the system had never been told about.
- A raw, non-human-readable ID slipped into a reply because the fallback text-builder didn't know that IDs are only meant to be shown for issues, not for teams or people.

None of these are one-off mistakes by a careless developer. They're the natural, expected failure mode of building a system's understanding out of many individually hand-written rules instead of out of genuine contextual reasoning. Every fix closes one specific gap. The next unlisted phrasing, the next forgotten tool, the next assumption that "the user won't say it that way" — that's where the next bug already is, waiting.

---

## 8. What this means going into the redesign

Nothing in this document is a proposal for what to change — that's the next conversation. But the honest summary of "what I understand about the side panel" is:

- The **vision** (one shared toolbox, one AI across every surface, strict permission mirroring, no-delete, confirm-before-risky-actions, full audit trail) is sound and worth keeping.
- The **mechanism for understanding what the user wants** — a sprawling, ever-growing pile of hand-written keyword rules and slot-filling logic, with real AI reasoning relegated to a fallback role — is the part that doesn't hold up, and is the actual root cause behind almost every bug this session surfaced, not just the most recent one.
- The AI reasoning path we kept falling back to tonight, when it got to run, generally worked. The instinct that "just let the AI think about it more, more of the time, with real context" is the direction that keeps proving itself correct every time we've compared the two paths side by side tonight.
