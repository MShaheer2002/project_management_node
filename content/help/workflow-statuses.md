---
id: workflow-statuses
title: Workflow statuses
category: Workspace
route: /settings
roles: OWNER, ADMIN
plans: FREE, STANDARD, PREMIUM
keywords: status, statuses, workflow, backlog, in progress, done, custom status, automation, overdue, approval, transition, rules, add status
---

Statuses are the stages an issue moves through, like Backlog, In Progress and Done. Owners and admins edit the workspace workflow in **Settings › Workspace**. Projects can have their own (see *Project workflows and statuses*).

## Status groups

Every status belongs to a group: **Backlog**, **Unstarted**, **Active**, **Review**, **Done** or **Cancelled**. Done statuses count as finished: they set the completed date, count toward cycle progress and show in **My issues › Completed**.

## Add or edit a status

Use **Add status**, or click a status to edit:

- **Name** and **Category** (group).
- **Visibility:** where it appears (board, list, filters, cycle views).
- **Cycle Behavior:** how it behaves in cycles.
- **Transition Rules:**
  - **Movement mode:** **Free movement**, or **Restricted next states** (only certain statuses can come next).
  - **Allow rollback** to earlier statuses.
  - **Who can move issues here** (Entry Rules).
- **Approval Gate:** **Require approval to leave this status**, how many approvals, and **who can approve** (project members, team lead, department head, or specific people).

The workflow needs at least one status, one Done status, and one status visible on the board.

## Automation Rules

- **When all subtasks are complete:** **Suggest completion**, or **Move automatically**.
- **When a cycle starts:** move planned work into the first active status.
- **When work becomes overdue:** flag it.
- **GitHub pull requests:** which status an issue moves to when a PR is **opened** or **merged**.

## Remove a status

If issues still use it, choose **Merge into** another status to move them. You can first **Export issues on this status (CSV)** to keep a list.
