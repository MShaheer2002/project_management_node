---
id: templates
title: Issue templates
category: Workspace
route: /templates
primary: true
roles: OWNER, ADMIN
plans: FREE, STANDARD, PREMIUM
keywords: template, issue template, default text, activate template, apply template, bug template, checklist, due offset, blueprint
---

**Templates** give issues a ready-made structure, so every bug report or feature request starts the same way. Owners and admins manage them in **Templates**.

## Create a template

1. Open **Templates** and click **New Template**.
2. **Template details:**
   - **Name** and **Description** (both required).
   - **Title template:** a starting title, like `[Bug] Short summary`.
   - **Content template:** the issue body people start from (required).
3. **Bug fields** (for bug templates): steps to reproduce, expected and actual behavior.
4. **Issue / feature fields:** acceptance criteria, related issues and optional notes.
5. **Checklist builder:** each item becomes a **subtask** on the new issue.
6. **Default metadata:** issue type, priority, status, severity, assignee, creator, estimate (1 to 5), labels, and a **due offset** (the due date is set this many days after the issue is created, 0 to 365).
7. Save.

## Activate a template

**Activate** a template to make it the default for its issue type (task, bug or issue). Its content then fills in automatically whenever someone creates that type, and it shows **Active in scope**. Only one template can be active per type: activating a second one asks you to swap. Use **Deactivate** to stop it.

## Use a template

Anyone can use a template. Open it and click **Apply Template**, review the draft, then **Continue to Create Issue**. Everything can still be changed before you create the issue.

## Manage templates

**Edit**, **Duplicate** or **Delete** from the template list. Each template shows how often it was applied and when it was last used. Deleting a template doesn't change issues already created from it.
