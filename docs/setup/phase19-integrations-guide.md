# Phase 19 — Integrations & Data Import: Product Requirements

## Document Purpose

This document defines the product requirements, user experience, and business value for Linearis integrations. It is organized by sub-phase and written for product managers, designers, and engineers who need to understand what to build, why, and what users should experience — not how to implement it technically.

---

# Phase 19a — GitHub Integration

## Why Teams Need GitHub Integration

Engineering teams live in two worlds: the project management tool where work is planned and tracked, and GitHub where work is actually done. Without integration, these worlds are disconnected.

**The daily pain without GitHub integration:**

A developer finishes a feature. They push code, open a pull request, get it reviewed, and merge. Then they have to open Linearis, find the issue, move it to "Done", and maybe paste the PR link in a comment. They forget half the time. The PM checks the board and sees "In Progress" on something that shipped two days ago. Trust in the board erodes. Standups become status interrogations instead of forward-looking conversations.

**Who benefits:**

| Role | Benefit |
|---|---|
| **Engineers** | Never manually update issue status again. Work flows naturally from branch → commit → PR → merge → done. |
| **Engineering Managers** | See real delivery velocity, not self-reported status. Know which PRs are blocking which issues. |
| **Product Managers** | Trust the board. When something shows "Done", it means code was merged, not that someone clicked a button. |
| **Designers** | See when their design specs are actually being implemented and when the PR is ready for review. |
| **Founders/Stakeholders** | Track engineering output without asking for updates. Board accuracy eliminates "where are we?" meetings. |

## Connection Experience

### Initial Setup

When an ADMIN or OWNER opens **Settings > Integrations**, they see a card for each available provider. The GitHub card shows:

```
┌──────────────────────────────────────────────────────────────┐
│  GitHub                                          [Connect]   │
│                                                              │
│  Link your GitHub repositories to automatically track        │
│  branches, commits, and pull requests on your issues.        │
│                                                              │
│  ✓ Auto-link commits and PRs to issues                      │
│  ✓ Auto-update issue status when PRs merge                  │
│  ✓ See development progress directly on issue cards          │
└──────────────────────────────────────────────────────────────┘
```

Clicking **Connect** opens GitHub's authorization page. The user selects which organization and repositories Linearis can access. After authorization, the user returns to Linearis and sees:

```
┌──────────────────────────────────────────────────────────────┐
│  GitHub                                       [Connected ✓]  │
│  Connected by Shaheer Qureshi · 2 repositories              │
│                                                              │
│  Repositories:                                               │
│    acme/web-app                                              │
│    acme/mobile-app                                           │
│                                                              │
│  [Manage Repositories]  [Settings]  [Disconnect]             │
└──────────────────────────────────────────────────────────────┘
```

### Repository Selection

After connecting, the admin selects which repositories should be linked to the workspace. Only selected repositories will have their activity tracked.

The repository picker shows:

```
Select repositories to link

  🔍 Search repositories...

  ☑  acme/web-app              Last push: 2 hours ago
  ☑  acme/mobile-app           Last push: 1 day ago
  ☐  acme/design-system        Last push: 3 weeks ago
  ☐  acme/infrastructure       Last push: 5 days ago
  ☐  acme/docs                 Last push: 1 week ago

  Showing 5 of 12 repositories

  [Save Selection]
```

### Configurable Settings

| Setting | Default | Description |
|---|---|---|
| Auto-complete issue on PR merge | On | When a PR referencing `LIN-XXX` is merged, automatically move the issue to "Done" |
| Auto-move to "In Review" on PR open | On | When a PR referencing `LIN-XXX` is opened, move the issue to "Review" status |
| Notify assignee on new PR | On | Send notification when a PR is opened for their assigned issue |
| Notify assignee on PR review | On | Send notification when a PR review is submitted |
| Show commit activity on issues | On | Display linked commits in the issue activity feed |
| Show branch activity on issues | On | Display branch creation in the issue activity feed |
| Default project for unlinked PRs | None | If a PR references `LIN-XXX` but no project is found, create the link in this project |

## Developer Workflow

This is the core value of GitHub integration — making the developer's existing Git workflow automatically update Linearis.

### Step-by-Step Example

**The issue:**

```
LIN-24  Fix login crash on iOS Safari
Status: Todo
Priority: High
Assignee: Shaheer
Project: Mobile App
```

**Step 1: Developer creates a branch**

```bash
git checkout -b feature/LIN-24-fix-login
```

Linearis detects the branch name contains `LIN-24` and shows on the issue:

```
Development
  🌿 feature/LIN-24-fix-login  created just now by Shaheer
```

The issue remains in "Todo" — creating a branch is not starting work (the developer might be exploring). No status change.

**Step 2: Developer commits**

```bash
git commit -m "LIN-24 fix login crash on iOS Safari"
```

After pushing, Linearis shows on the issue:

```
Development
  🌿 feature/LIN-24-fix-login  created 1 hour ago
  📝 abc1234 "LIN-24 fix login crash on iOS Safari"  pushed just now
```

Activity feed entry:

```
Shaheer pushed a commit referencing this issue
abc1234 — "LIN-24 fix login crash on iOS Safari"
acme/mobile-app · feature/LIN-24-fix-login
2 minutes ago
```

**Step 3: Developer opens a pull request**

```
Title: LIN-24 Fix login crash on iOS Safari
Branch: feature/LIN-24-fix-login → main
```

Linearis detects `LIN-24` in the PR title and:
1. Links the PR to issue LIN-24
2. Moves issue status from "Todo" to "Review" (if auto-move is enabled)
3. Sends notification to the assignee: "PR #142 opened for LIN-24"

The issue now shows:

```
Development
  🌿 feature/LIN-24-fix-login
  📝 abc1234 "LIN-24 fix login crash on iOS Safari"
  🔀 PR #142 "LIN-24 Fix login crash on iOS Safari"
     Open · 0 of 2 reviews · No conflicts
     acme/mobile-app · feature/LIN-24-fix-login → main
```

Activity feed:

```
Shaheer opened a pull request for this issue
PR #142 — "LIN-24 Fix login crash on iOS Safari"
acme/mobile-app
5 minutes ago

Linearis moved this issue to Review
Triggered by PR #142 being opened
5 minutes ago
```

**Step 4: PR is reviewed**

A teammate approves the PR on GitHub. Linearis shows:

```
Development
  🔀 PR #142 "LIN-24 Fix login crash on iOS Safari"
     Open · 1 of 2 reviews approved · No conflicts
```

Notification to PR author: "Ali approved PR #142 for LIN-24"

Activity feed:

```
Ali approved pull request #142
acme/mobile-app
10 minutes ago
```

**Step 5: PR is merged**

The PR is merged on GitHub. Linearis:
1. Updates PR status to "Merged"
2. Moves issue LIN-24 from "Review" to "Done" (if auto-complete is enabled)
3. Sets `completedAt` timestamp
4. Sends notification to assignee: "LIN-24 completed — PR #142 merged"

The issue now shows:

```
Development
  🔀 PR #142 "LIN-24 Fix login crash on iOS Safari"
     Merged · 2 reviews approved
     acme/mobile-app · merged into main
```

Activity feed:

```
PR #142 was merged into main
LIN-24 automatically moved to Done
acme/mobile-app
just now
```

### How Issue References Are Detected

Linearis recognizes `LIN-XXX` in:
- Branch names: `feature/LIN-24-fix-login`, `bugfix/LIN-24`, `LIN-24-hotfix`
- Commit messages: `"LIN-24 fix login crash"`, `"Fixes LIN-24"`, `"closes LIN-24"`
- PR titles: `"LIN-24 Fix login crash"`
- PR descriptions: `"This PR fixes LIN-24 and LIN-25"`

Multiple issue references in a single PR are supported — a PR can link to `LIN-24`, `LIN-25`, and `LIN-26` simultaneously.

## Issue Experience

When GitHub activity is linked to an issue, a **Development** section appears on the issue detail page:

```
┌──────────────────────────────────────────────────────────────┐
│  Development                                                 │
│                                                              │
│  Branches                                                    │
│  🌿 feature/LIN-24-fix-login      acme/mobile-app           │
│                                                              │
│  Pull Requests                                               │
│  🔀 #142 Fix login crash on iOS   Merged ✓  2 approvals     │
│     acme/mobile-app · merged 2 hours ago                     │
│                                                              │
│  Commits (3)                                                 │
│  📝 abc1234 "fix login crash"         Shaheer · 3 hours ago  │
│  📝 def5678 "add Safari detection"    Shaheer · 2 hours ago  │
│  📝 ghi9012 "update unit tests"       Shaheer · 2 hours ago  │
└──────────────────────────────────────────────────────────────┘
```

**PR Status Indicators:**

| Status | Display |
|---|---|
| Open | `🟡 Open · Awaiting review` |
| Approved | `🟢 Approved · Ready to merge` |
| Changes Requested | `🔴 Changes requested` |
| Merged | `✅ Merged into main` |
| Closed (not merged) | `⚫ Closed without merge` |
| Draft | `⚪ Draft` |
| Conflicts | `⚠️ Has merge conflicts` |

## Activity Feed Experience

GitHub events appear alongside regular Linearis activity. Each entry clearly shows the GitHub icon to distinguish it from manual actions.

```
Timeline for LIN-24

  ✅ Linearis completed this issue                              just now
     Triggered by PR #142 merge

  🔀 PR #142 merged into main                                 2 min ago
     acme/mobile-app · by Shaheer

  👍 Ali approved PR #142                                     15 min ago
     acme/mobile-app

  🔀 Shaheer opened PR #142                                   1 hour ago
     "LIN-24 Fix login crash on iOS Safari"
     acme/mobile-app · feature/LIN-24-fix-login → main

  ➡️ Linearis moved to Review                                 1 hour ago
     Triggered by PR #142 being opened

  📝 Shaheer pushed 3 commits                                 2 hours ago
     abc1234 "fix login crash"
     def5678 "add Safari detection"
     ghi9012 "update unit tests"

  🌿 Shaheer created branch                                   3 hours ago
     feature/LIN-24-fix-login · acme/mobile-app

  👤 PM assigned this to Shaheer                               1 day ago

  ➕ PM created this issue                                     1 day ago
```

## Notifications

| Event | Recipients | Message |
|---|---|---|
| PR opened for issue | Issue assignee | "Shaheer opened PR #142 for LIN-24" |
| PR review submitted | PR author | "Ali approved PR #142 for LIN-24" |
| PR changes requested | PR author | "Ali requested changes on PR #142 for LIN-24" |
| PR merged | Issue assignee, issue creator | "PR #142 merged — LIN-24 completed" |
| PR closed without merge | Issue assignee | "PR #142 closed without merge for LIN-24" |
| Branch created for issue | None (too noisy) | — |
| Commit pushed | None (too noisy) | — |

Notifications are delivered:
- In-app (notification inbox + bell icon badge)
- Realtime via Socket.IO (toast if user is online)
- Slack DM (if Slack integration is also connected)

## Workspace Settings — GitHub

Accessible at **Settings > Integrations > GitHub > Settings**:

```
┌──────────────────────────────────────────────────────────────┐
│  GitHub Settings                                             │
│                                                              │
│  Automation                                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ☑ Auto-move issue to "Review" when PR is opened     │   │
│  │ ☑ Auto-complete issue when PR is merged             │   │
│  │ ☐ Auto-move issue to "In Progress" on first commit  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Notifications                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ☑ Notify assignee when PR is opened                 │   │
│  │ ☑ Notify assignee when PR is reviewed               │   │
│  │ ☑ Notify assignee when PR is merged                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Display                                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ☑ Show commits in issue activity feed               │   │
│  │ ☑ Show branches in issue activity feed              │   │
│  │ ☑ Show PR status on issue cards in board view       │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Connected Repositories                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ acme/web-app              [Remove]                   │   │
│  │ acme/mobile-app           [Remove]                   │   │
│  │                                                      │   │
│  │ [+ Add Repository]                                   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Danger Zone                                                 │
│  [Disconnect GitHub]                                         │
└──────────────────────────────────────────────────────────────┘
```

## Team Benefits

- **Zero context switching** — developers never leave their terminal or GitHub to update Linearis
- **Accurate project status** — the board reflects reality because it's driven by code activity, not manual clicks
- **Accountability without micromanagement** — managers see progress through automated signals, not standups
- **Faster code review** — reviewers see the full issue context (description, acceptance criteria, designs) linked from the PR
- **Sprint velocity accuracy** — completion is tied to actual merges, making velocity metrics trustworthy
- **Onboarding** — new team members see the full history of an issue including all code changes

## What Is NOT Included

| Not Included | Reason |
|---|---|
| Repository management (create, delete, settings) | GitHub is the source of truth for repository configuration |
| CI/CD pipeline management | Out of scope — use GitHub Actions, CircleCI, etc. directly |
| Code review within Linearis | GitHub's review experience is superior and established |
| Source code viewing or editing | Linearis is not an IDE or code browser |
| GitHub Issues sync (bidirectional) | Phase 19a is one-directional: GitHub activity → Linearis. Bidirectional sync adds complexity without clear value for teams already using Linearis as their primary tracker |
| GitHub Projects board sync | Teams should choose one board: Linearis or GitHub Projects, not both |
| Automatic branch creation from Linearis | Nice-to-have for future. In Phase 19a, developers create branches themselves with the `LIN-XXX` naming convention |

**GitHub remains the source of truth for code. Linearis remains the source of truth for work planning.**

---

# Phase 19b — Slack Integration

## Why Teams Need Slack Integration

Slack is where teams communicate. Linearis is where teams plan. Without integration, important work updates get buried in Slack threads that no one can find later, and issue status updates require leaving a conversation to open another tool.

**The daily pain without Slack integration:**

A PM asks in #engineering: "What's the status of the login fix?" Three people respond with different levels of detail. Someone says "I think it's done?" Someone else says "PR is open." Nobody is sure. The PM opens Linearis to check. The board says "In Progress" because nobody remembered to update it.

Meanwhile, the on-call engineer gets paged about a production issue. They create the issue in Linearis, but nobody in #incidents knows about it. They have to post in Slack separately, creating duplicate information that will drift apart.

**Who benefits:**

| Role | Benefit |
|---|---|
| **Everyone** | Important updates appear where the team already is — Slack |
| **PMs** | Get project updates in Slack without checking Linearis constantly |
| **Engineers** | Create and manage issues without leaving Slack |
| **Engineering Managers** | See cycle completions, blockers, and urgent issues in team channels |
| **Remote Teams** | Async-friendly: updates post to channels automatically regardless of timezone |

## Workspace Connection Experience

### Initial Setup

Clicking **Connect** on the Slack card initiates Slack's OAuth flow. After authorization, the admin configures which Slack channels should receive which types of notifications.

### Channel Configuration

```
┌──────────────────────────────────────────────────────────────┐
│  Slack Channel Configuration                                 │
│                                                              │
│  Default Channel                                             │
│  All workspace notifications go here unless overridden       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ #engineering                                    [v]  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Channel Overrides (optional)                                │
│  Route specific notification types to specific channels      │
│                                                              │
│  Urgent / High Priority Issues → #incidents                  │
│  Cycle Updates                 → #sprint-updates             │
│  Project Completions           → #announcements              │
│                                                              │
│  [+ Add Override]                                            │
│                                                              │
│  [Save Configuration]                                        │
└──────────────────────────────────────────────────────────────┘
```

## Linearis to Slack — Outbound Messages

When events happen in Linearis, formatted messages are posted to configured Slack channels.

### Issue Created (High/Urgent Priority)

```
┌──────────────────────────────────────────────────────────────┐
│  🔴 Urgent Issue Created                                     │
│                                                              │
│  LIN-87  Production API returning 500 on checkout            │
│                                                              │
│  Priority:   Urgent                                          │
│  Project:    Payment Service                                 │
│  Assignee:   Ali Khan                                        │
│  Created by: Shaheer Qureshi                                 │
│                                                              │
│  [View in Linearis]                                          │
└──────────────────────────────────────────────────────────────┘
```

### Issue Assigned

```
┌──────────────────────────────────────────────────────────────┐
│  👤 Issue Assigned                                           │
│                                                              │
│  LIN-42 Fix login crash on iOS Safari                        │
│  Assigned to Shaheer Qureshi by Product Manager              │
│  Priority: High · Project: Mobile App                        │
│                                                              │
│  [View Issue]                                                │
└──────────────────────────────────────────────────────────────┘
```

### Issue Completed

```
┌──────────────────────────────────────────────────────────────┐
│  ✅ Issue Completed                                          │
│                                                              │
│  LIN-24 Fix login crash on iOS Safari                        │
│  Completed by Shaheer Qureshi                                │
│  Resolution time: 2 days                                     │
│                                                              │
│  [View Issue]                                                │
└──────────────────────────────────────────────────────────────┘
```

### Cycle Completed

```
┌──────────────────────────────────────────────────────────────┐
│  🏁 Cycle Completed                                          │
│                                                              │
│  Sprint 14 — Backend Team                                    │
│  Jun 1 – Jun 14, 2026                                        │
│                                                              │
│  ✅ Completed: 18 issues                                     │
│  ⏭️ Carried over: 3 issues                                   │
│  📊 Velocity: 92% completion rate                            │
│                                                              │
│  [View Cycle Summary]                                        │
└──────────────────────────────────────────────────────────────┘
```

### Comment Mention

```
┌──────────────────────────────────────────────────────────────┐
│  💬 You were mentioned                                       │
│                                                              │
│  Shaheer mentioned you in LIN-42                             │
│  "Hey @Ali can you review the Safari detection logic?        │
│   I'm not sure if we need a polyfill here."                  │
│                                                              │
│  [Reply in Linearis]                                         │
└──────────────────────────────────────────────────────────────┘
```

## Slack to Linearis — Slash Commands

### Create Issue

```
/linearis create Fix payment gateway timeout --priority high --project "Payment Service"
```

Linearis responds (ephemeral, only visible to the command user):

```
✅ Issue created

LIN-91 Fix payment gateway timeout
Priority: High · Project: Payment Service · Status: Backlog
Assigned to: you

[View in Linearis]
```

### Check Issue Status

```
/linearis status LIN-24
```

Response:

```
LIN-24 Fix login crash on iOS Safari

Status:    Done ✅
Priority:  High
Assignee:  Shaheer Qureshi
Project:   Mobile App
Updated:   2 hours ago

Development:
  🔀 PR #142 — Merged ✅

[View in Linearis]
```

### View My Issues

```
/linearis my-issues
```

Response:

```
Your Open Issues (4)

🔴 LIN-91 Fix payment gateway timeout          Urgent · Backlog
🟡 LIN-85 Add rate limiting to API             High · In Progress
🔵 LIN-78 Update user onboarding flow          Medium · Review
🔵 LIN-72 Refactor notification service        Medium · Todo

[View All in Linearis]
```

### View Cycle Progress

```
/linearis cycle
```

Response:

```
Current Cycle: Sprint 15 — Backend Team
Jun 15 – Jun 28, 2026 · 6 days remaining

Progress: ████████░░░░ 67% (12/18 issues)

✅ Done: 12
🔄 In Progress: 3
📋 Todo: 3

[View Cycle in Linearis]
```

## Direct Message Experience

Personal notifications are sent as Slack DMs to the user (matched by email address between Linearis and Slack).

**Examples of DM notifications:**

```
📌 You were assigned LIN-91 "Fix payment gateway timeout"
   Priority: Urgent · Project: Payment Service
   Assigned by: Shaheer Qureshi
   [View Issue]
```

```
⏰ Due date approaching: LIN-72 "Refactor notification service"
   Due: Tomorrow (Jun 17)
   Status: Todo — not yet started
   [View Issue]
```

```
🚫 LIN-85 is blocked by LIN-79
   "Add rate limiting to API" is blocked by "Deploy Redis cluster"
   LIN-79 is assigned to DevOps Team
   [View Blocker]
```

## Workspace Settings — Slack

```
┌──────────────────────────────────────────────────────────────┐
│  Slack Settings                                              │
│                                                              │
│  Channel Notifications                                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ☑ Issue created (high/urgent only)                  │   │
│  │ ☑ Issue completed                                   │   │
│  │ ☑ Issue assigned                                    │   │
│  │ ☐ Issue status changed (all statuses)               │   │
│  │ ☑ Cycle started                                     │   │
│  │ ☑ Cycle completed                                   │   │
│  │ ☐ Project created                                   │   │
│  │ ☑ Project completed                                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Direct Messages                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ☑ Issue assigned to you                             │   │
│  │ ☑ Mentioned in comment                              │   │
│  │ ☑ PR activity on your issues                        │   │
│  │ ☑ Due date reminders (1 day before)                 │   │
│  │ ☐ All status changes on your issues                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Slash Commands                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ☑ /linearis create                                  │   │
│  │ ☑ /linearis status                                  │   │
│  │ ☑ /linearis my-issues                               │   │
│  │ ☑ /linearis cycle                                   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  [Disconnect Slack]                                          │
└──────────────────────────────────────────────────────────────┘
```

## Team Benefits

- **Visibility without effort** — important updates show up where the team already communicates
- **Faster incident response** — urgent issues immediately appear in #incidents
- **Quick actions from Slack** — create issues, check status, view sprint progress without opening Linearis
- **DM notifications** — personal notifications reach you even when you're not in Linearis
- **Async-friendly** — channel posts create a timeline of project progress that any timezone can catch up on
- **Meeting reduction** — automated cycle summaries and project completions replace many status meetings

## What Is NOT Included

| Not Included | Reason |
|---|---|
| Full issue management in Slack | Slack is a companion, not a replacement for Linearis. Complex workflows (drag to reorder, bulk edit, roadmap planning) belong in the app |
| Bidirectional comment sync | Comments posted in Slack do not create comments in Linearis. Reply in Linearis when you need the context preserved |
| Slack channel creation/management | Linearis does not manage your Slack workspace structure |
| File sharing through Slack | Use Linearis attachments for project files |
| User provisioning from Slack | Team membership is managed in Linearis, not derived from Slack channels |

**Slack acts as a companion experience — a notification destination and quick-action surface. Linearis remains the source of truth for all project data.**

---

# Phase 19c — Figma Integration

## Why Teams Need Figma Integration

Design and development are sequential: designs are created first, then implemented. The handoff between these two phases is where information gets lost. Developers open an issue, see "Implement login page redesign," and have to go hunting for the Figma link. They find three different versions across Slack, email, and a Google Doc. They implement the wrong one.

**Who benefits:**

| Role | Benefit |
|---|---|
| **Designers** | Designs are linked to the work they inform. No more "which Figma file is the latest?" |
| **Developers** | Open an issue, see the design right there. No hunting, no guessing |
| **PMs** | Ensure design specs are attached to issues before development starts |
| **QA** | Compare implementation against the linked design, not a screenshot from 3 weeks ago |

## Designer Workflow

### Linking Designs to Projects

A designer working on the Mobile App project opens the project in Linearis and navigates to the **Designs** tab:

```
┌──────────────────────────────────────────────────────────────┐
│  Mobile App > Designs                        [+ Add Design]  │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │            │  │            │  │            │            │
│  │  Login     │  │  Checkout  │  │  Dashboard │            │
│  │  Flow      │  │  Flow      │  │  Screens   │            │
│  │            │  │            │  │            │            │
│  │  Figma     │  │  Figma     │  │  Figma     │            │
│  └────────────┘  └────────────┘  └────────────┘            │
│  Updated 2 days   Updated 1 week  Updated 3 days            │
│  12 frames         8 frames        15 frames                 │
│                                                              │
│  Design System                                               │
│  ┌────────────┐                                             │
│  │            │                                             │
│  │  Component │                                             │
│  │  Library   │                                             │
│  │            │                                             │
│  │  Figma     │                                             │
│  └────────────┘                                             │
│  Updated 5 days · 200+ components                            │
└──────────────────────────────────────────────────────────────┘
```

### Linking Designs to Issues

When creating or editing an issue, a designer can paste a Figma URL and Linearis automatically creates a rich link:

```
┌──────────────────────────────────────────────────────────────┐
│  LIN-50  Redesign checkout flow                              │
│                                                              │
│  Design Reference                                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ┌───────────┐                                       │   │
│  │  │           │  Checkout Flow v2                      │   │
│  │  │  Preview  │  Mobile App Designs                    │   │
│  │  │  Image    │  Last modified: Jun 8, 2026            │   │
│  │  │           │  by Sarah (Designer)                   │   │
│  │  └───────────┘                                       │   │
│  │                 [Open in Figma]                       │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Description                                                 │
│  Redesign the checkout flow based on the updated design...   │
└──────────────────────────────────────────────────────────────┘
```

## Design Preview Experience

When a Figma link is attached to an issue, Linearis displays:

- **Thumbnail preview** — a visual snapshot of the linked frame/page
- **File name** — "Checkout Flow v2"
- **Project name** — "Mobile App Designs"
- **Last modified** — "Jun 8, 2026" with modifier name
- **Frame count** — how many frames/pages in the file (if applicable)
- **Open in Figma** — direct link to the exact frame in Figma

Clicking the preview opens a larger preview modal within Linearis. Clicking "Open in Figma" opens the file directly in Figma.

## Collaboration Benefits

- **Single source of design truth per issue** — no more "which mockup are we implementing?"
- **Design review in context** — developers see the design alongside the acceptance criteria and technical requirements
- **Progress tracking** — PMs can see which issues have designs attached and which are still waiting
- **QA accuracy** — testers compare implementation against the actual linked design, not a screenshot
- **Design history** — since Figma shows "last modified," the team knows if the design has changed since development started

## Workspace Settings — Figma

```
┌──────────────────────────────────────────────────────────────┐
│  Figma Settings                                              │
│                                                              │
│  Display                                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ☑ Show design preview thumbnails on issues          │   │
│  │ ☑ Show design preview in issue list (compact)       │   │
│  │ ☑ Show "last modified" on design links              │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  [Disconnect Figma]                                          │
└──────────────────────────────────────────────────────────────┘
```

## What Is NOT Included

| Not Included | Reason |
|---|---|
| Design editing within Linearis | Figma is the design tool. Linearis is a link and preview surface. |
| Design file management | No creating, deleting, or organizing Figma files from Linearis |
| Design version comparison | Use Figma's built-in version history |
| Design-to-code export | Out of scope for a project management tool |
| Real-time design sync | Thumbnails are fetched on demand, not continuously synced |
| Design review/approval workflow | Use Figma's comment and annotation features |

**Figma remains the source of truth for design. Linearis provides the bridge between design intent and development execution.**

---

# Phase 19d — Discord Integration

## Why Teams Use Discord

Many engineering teams, open-source communities, and startups use Discord as their primary communication platform. Discord is particularly popular with:

- **Open-source projects** that want community visibility into development progress
- **Gaming and creative studios** already using Discord for team communication
- **Small startups** that prefer Discord's free tier over Slack's paid plans
- **Developer communities** building products with engaged user bases

## Workspace Connection Experience

Connecting Discord uses a bot-based approach. The admin adds the Linearis bot to their Discord server and selects notification channels:

```
┌──────────────────────────────────────────────────────────────┐
│  Discord Settings                                            │
│                                                              │
│  Server: Acme Development                    [Connected ✓]   │
│                                                              │
│  Notification Channels                                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Default channel:    #dev-updates               [v]  │   │
│  │ Urgent issues:      #incidents                 [v]  │   │
│  │ Release updates:    #releases                  [v]  │   │
│  │ Community updates:  #changelog                 [v]  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  [Disconnect Discord]                                        │
└──────────────────────────────────────────────────────────────┘
```

## Linearis to Discord — Outbound Messages

### New Issue (Urgent/High)

```
┌──────────────────────────────────────────────────────────────┐
│  🔴 Urgent Issue Created                                     │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│                                                              │
│  LIN-87 Production API returning 500 on checkout             │
│                                                              │
│  Priority   Urgent                                           │
│  Assignee   Ali Khan                                         │
│  Project    Payment Service                                  │
│  Created    Shaheer Qureshi                                  │
│                                                              │
│  🔗 View in Linearis                                        │
│                                                              │
│  Linearis · just now                                         │
└──────────────────────────────────────────────────────────────┘
```

### Cycle Completed

```
┌──────────────────────────────────────────────────────────────┐
│  🏁 Cycle Completed                                          │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│                                                              │
│  Sprint 14 — Backend Team                                    │
│  Jun 1 – Jun 14                                              │
│                                                              │
│  ✅ Completed    18 issues                                   │
│  ⏭️ Carried over  3 issues                                   │
│  📊 Velocity     92% completion                              │
│                                                              │
│  🔗 View Summary                                            │
│                                                              │
│  Linearis · just now                                         │
└──────────────────────────────────────────────────────────────┘
```

### Milestone Reached

```
┌──────────────────────────────────────────────────────────────┐
│  🎯 Milestone Reached                                        │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│                                                              │
│  "Beta Launch" milestone completed                           │
│  Project: Mobile App v2                                      │
│  All 5 milestone issues resolved                             │
│                                                              │
│  🔗 View Milestone                                          │
│                                                              │
│  Linearis · just now                                         │
└──────────────────────────────────────────────────────────────┘
```

## Team Benefits

- **Community transparency** — open-source contributors see progress in real-time
- **Free-tier friendly** — Discord's free plan has no message limits
- **Low-friction setup** — bot-based connection, no OAuth complexity for team members
- **Channel flexibility** — route different notification types to different channels

## What Is NOT Included

| Not Included | Reason |
|---|---|
| Slash commands in Discord | Phase 19d is outbound-only. Slash commands may be added later |
| Direct messages | Discord DMs are not used for personal notifications — use the Linearis inbox |
| Bidirectional sync | Discord messages do not create or modify Linearis data |
| Thread management | Discord threads are not linked to Linearis issues |
| Voice channel integration | Out of scope for project management |

**Discord acts primarily as a notification destination — a one-way broadcast channel for workspace events.**

---

# Phase 19e — Data Import

## Why Teams Need Importing

Teams switch project management tools for many reasons: the current tool is too complex (Jira), too limited (Trello), too expensive (Asana at scale), or the team simply wants a better experience (migrating to Linearis).

The biggest barrier to switching is the migration cost. Teams have months or years of project history, hundreds or thousands of issues, carefully organized labels, sprint data, and team structures. Starting from zero is not an option.

**Without import capability:**
- Teams must manually recreate every project, issue, and label
- History is lost — no context on past decisions, no audit trail
- Sprint velocity data resets — no baseline for planning
- Adoption stalls because the "just try it" cost is too high

**With import capability:**
- Teams import their existing data in minutes, not weeks
- Hit the ground running with full history intact
- Zero disruption to ongoing work — import over lunch, switch the next morning
- Decision to try Linearis becomes low-risk: "if we don't like it, we haven't lost anything"

## Supported Sources

| Source | What Teams Use It For |
|---|---|
| **Linear** | Engineering teams migrating from Linear's issue tracker |
| **Jira** | Enterprise teams moving away from Jira's complexity |
| **ClickUp** | Teams that outgrew ClickUp's "everything app" approach |
| **Asana** | Product/design teams switching to an engineering-focused tool |
| **Trello** | Teams graduating from Trello's card-based simplicity |

## Migration Experience

### Step 1: Select Source

The admin opens **Settings > Import Data** and sees:

```
┌──────────────────────────────────────────────────────────────┐
│  Import Data                                                 │
│                                                              │
│  Bring your existing projects and issues into Linearis.      │
│  Select where you're migrating from:                         │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │  Linear  │  │  Jira    │  │  ClickUp │                  │
│  │          │  │          │  │          │                  │
│  │ [Import] │  │ [Import] │  │ [Import] │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
│                                                              │
│  ┌──────────┐  ┌──────────┐                                 │
│  │  Asana   │  │  Trello  │                                 │
│  │          │  │          │                                 │
│  │ [Import] │  │ [Import] │                                 │
│  └──────────┘  └──────────┘                                 │
│                                                              │
│  ────────────────────────────────────────────                │
│  Import History                                              │
│  No previous imports                                         │
└──────────────────────────────────────────────────────────────┘
```

### Step 2: Authenticate

After selecting a source (e.g., Linear), the admin authorizes Linearis to read their Linear workspace. This uses read-only access — Linearis never modifies the source.

### Step 3: Preview

Linearis fetches the source workspace data and shows a preview:

```
┌──────────────────────────────────────────────────────────────┐
│  Import from Linear                           Step 1 of 4    │
│                                                              │
│  Connected to: Acme Corp (Linear)                            │
│                                                              │
│  We found the following data:                                │
│                                                              │
│  📁 Teams          3    (Backend, Frontend, Design)          │
│  📂 Projects      12    (Mobile App, Web Dashboard, ...)     │
│  📋 Issues       847    (423 open, 424 closed)               │
│  🏷️ Labels        45    (bug, feature, enhancement, ...)     │
│  💬 Comments   2,341                                         │
│  👥 Members       18    (14 match by email)                  │
│  🔄 Cycles        24    (8 active/upcoming)                  │
│                                                              │
│  Select what to import:                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ☑ Projects (all 12)                                 │   │
│  │ ☑ Issues (all 847)                                  │   │
│  │ ☑ Labels (all 45)                                   │   │
│  │ ☑ Comments (all 2,341)                              │   │
│  │ ☐ Attachments (127 files, ~340 MB)                  │   │
│  │ ☑ Cycles (upcoming and active only)                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ⚠️ 4 members not found in workspace:                       │
│     sarah@example.com, mike@example.com,                     │
│     jen@example.com, tom@example.com                         │
│     Their issues will be imported unassigned.                │
│                                                              │
│                                       [Cancel]  [Next →]     │
└──────────────────────────────────────────────────────────────┘
```

### Step 4: Mapping

The admin maps source data to Linearis equivalents:

```
┌──────────────────────────────────────────────────────────────┐
│  Import from Linear                           Step 2 of 4    │
│                                                              │
│  Status Mapping                                              │
│  ┌─────────────────────┬─────────────────────┐              │
│  │ Linear              │ Linearis            │              │
│  ├─────────────────────┼─────────────────────┤              │
│  │ Backlog             │ Backlog        [v]  │              │
│  │ Todo                │ Todo           [v]  │              │
│  │ In Progress         │ In Progress    [v]  │              │
│  │ In Review           │ Review         [v]  │              │
│  │ Done                │ Done           [v]  │              │
│  │ Cancelled           │ Done           [v]  │              │
│  └─────────────────────┴─────────────────────┘              │
│                                                              │
│  Priority Mapping                                            │
│  ┌─────────────────────┬─────────────────────┐              │
│  │ Linear              │ Linearis            │              │
│  ├─────────────────────┼─────────────────────┤              │
│  │ Urgent              │ Urgent         [v]  │              │
│  │ High                │ High           [v]  │              │
│  │ Medium              │ Medium         [v]  │              │
│  │ Low                 │ Low            [v]  │              │
│  │ No priority         │ Low            [v]  │              │
│  └─────────────────────┴─────────────────────┘              │
│                                                              │
│  Team Mapping                                                │
│  ┌─────────────────────┬─────────────────────┐              │
│  │ Linear Team         │ Linearis Team       │              │
│  ├─────────────────────┼─────────────────────┤              │
│  │ Backend             │ Backend        [v]  │              │
│  │ Frontend            │ Frontend       [v]  │              │
│  │ Design              │ + Create new   [v]  │              │
│  └─────────────────────┴─────────────────────┘              │
│                                                              │
│                                  [← Back]  [Next →]          │
└──────────────────────────────────────────────────────────────┘
```

### Step 5: Confirm and Start

```
┌──────────────────────────────────────────────────────────────┐
│  Import from Linear                           Step 3 of 4    │
│                                                              │
│  Ready to import                                             │
│                                                              │
│  Summary:                                                    │
│  • 12 projects into 3 teams                                  │
│  • 847 issues with status and priority mapping               │
│  • 45 labels                                                 │
│  • 2,341 comments                                            │
│  • 8 cycles (active and upcoming)                            │
│  • 14 of 18 members matched by email                         │
│                                                              │
│  ⚠️ This will add data to your workspace. Existing data     │
│  will not be modified. You can delete imported projects       │
│  if you need to undo.                                        │
│                                                              │
│  Estimated time: 2-5 minutes                                 │
│                                                              │
│                              [← Back]  [Start Import]        │
└──────────────────────────────────────────────────────────────┘
```

### Step 6: Import Progress

```
┌──────────────────────────────────────────────────────────────┐
│  Import from Linear                           Step 4 of 4    │
│                                                              │
│  Importing...                                                │
│                                                              │
│  ████████████████████░░░░░░░░░░  67%                        │
│                                                              │
│  ✅ Labels           45/45                                   │
│  ✅ Teams             3/3                                    │
│  ✅ Projects         12/12                                   │
│  🔄 Issues         568/847    Importing...                   │
│  ⏳ Comments          —       Waiting                        │
│  ⏳ Cycles            —       Waiting                        │
│                                                              │
│  Elapsed: 1m 42s · Est. remaining: 1m 15s                   │
│                                                              │
│  💡 You can close this page. The import will continue        │
│     in the background and you'll be notified when done.      │
│                                                              │
│                                              [Cancel Import] │
└──────────────────────────────────────────────────────────────┘
```

### Step 7: Import Summary

```
┌──────────────────────────────────────────────────────────────┐
│  Import Complete ✅                                          │
│                                                              │
│  Successfully imported from Linear                           │
│  Duration: 2 minutes 47 seconds                              │
│                                                              │
│  Results:                                                    │
│  ✅ Labels          45 imported                              │
│  ✅ Teams            3 imported (1 created new)              │
│  ✅ Projects        12 imported                              │
│  ✅ Issues         844 imported                              │
│  ⚠️ Issues           3 skipped (missing required fields)    │
│  ✅ Comments     2,341 imported                              │
│  ✅ Cycles           8 imported                              │
│                                                              │
│  Warnings:                                                   │
│  • 3 issues skipped — missing title (source IDs: #4521,     │
│    #4522, #4890). These appear to be corrupted in Linear.    │
│  • 4 members not matched — issues imported unassigned        │
│  • 12 "Cancelled" issues mapped to "Done" status             │
│                                                              │
│  [View Imported Projects]          [View Import Details]     │
└──────────────────────────────────────────────────────────────┘
```

## Import History Experience

Past imports are visible at **Settings > Import Data > Import History**:

```
┌──────────────────────────────────────────────────────────────┐
│  Import History                                              │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Linear Import                             Completed ✅│   │
│  │ Jun 10, 2026 · by Shaheer Qureshi                    │   │
│  │ 844 issues, 12 projects, 45 labels, 2,341 comments   │   │
│  │ 3 issues skipped · Duration: 2m 47s                   │   │
│  │ [View Details]                                        │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Trello Import                             Completed ✅│   │
│  │ May 28, 2026 · by Ali Khan                            │   │
│  │ 156 issues, 3 projects, 8 labels                      │   │
│  │ 0 skipped · Duration: 45s                             │   │
│  │ [View Details]                                        │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

## Team Benefits

- **Zero-friction migration** — switch to Linearis without losing months of project history
- **Preserve institutional knowledge** — comments, discussions, and decisions travel with the issues
- **Accurate velocity from day one** — imported sprint data gives meaningful baselines
- **Low-risk trial** — import your data, try Linearis for a week, decide without fear of data loss
- **Gradual migration** — import one team's projects first, expand once the team is comfortable

## What Is NOT Included

| Not Included | Reason |
|---|---|
| Ongoing synchronization | Import is a one-time migration, not continuous sync. After import, Linearis is the source of truth. |
| Export back to source | Linearis does not export data back to Linear/Jira/etc. |
| Attachment migration (Phase 19e v1) | File attachments are referenced but not re-uploaded in the initial version. URLs are preserved. |
| User account creation | Import matches members by email. Users not in Linearis must be invited separately. |
| Custom field migration | Source-specific custom fields are preserved in issue metadata but not displayed as first-class fields |
| Webhook/integration migration | Source tool integrations (e.g., Linear's GitHub integration) are not migrated |

**Importing is a one-time migration event, not ongoing synchronization. After import, Linearis becomes the single source of truth.**

---

## Summary — Integration Priorities

| Phase | Provider | Type | Priority | Reason |
|---|---|---|---|---|
| 19a | GitHub | Live integration | Highest | Core engineering workflow. Every engineering team uses Git. |
| 19b | Slack | Live integration | High | Most common team communication tool. Notifications and quick actions. |
| 19c | Figma | Link integration | Medium | Design-dev handoff. Read-only, low complexity. |
| 19d | Discord | Notification | Medium | Important for open-source and startup teams. Outbound-only, simple. |
| 19e | Data Import | Migration | High | Unblocks adoption. Teams cannot switch without their data. |

Recommended build order: **19a → 19e → 19b → 19c → 19d**

GitHub and import unblock adoption. Slack adds ongoing value. Figma and Discord are enhancements.
