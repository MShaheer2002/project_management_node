---
id: project-workflow
title: Project workflows and statuses
category: Planning
route: /projects/:id
primary: true
roles: OWNER, ADMIN, MEMBER
plans: FREE, STANDARD, PREMIUM
keywords: workflow, statuses, custom statuses, project workflow, override, status order, customize workflow, revert workflow, project statuses
---

Every project uses the **workspace's workflow** (its statuses and rules) unless it gets its own. Use your own when a project works differently, for example a design project with Review and Approved steps.

## Customize a project's workflow

The project lead, admins and owners can do this.

1. Open the project, then **Settings**.
2. Under **Workflow**, click **Customize workflow for this project**.
3. Change the statuses, their order, transition rules, approvals and automations. These work the same way as the workspace workflow. See *Workflow statuses*.
4. Save.

## Go back to the workspace workflow

In the same place, revert to the workspace default. The project then follows the workspace statuses again.

## Removing a status that's in use

Issues can't be left without a status. When you remove one that issues still use, you choose:

- **Merge into** another status: the issues move to it.
- Or **Export issues on this status (CSV)** first, to keep a list.

## Good to know

- A project's workflow only affects that project's issues.
- Members who don't lead the project can't change its workflow, and the editing controls are hidden for them.
