---
id: create-issue
title: Create an issue
category: Issues
route: /issues/create
primary: true
roles: OWNER, ADMIN, MEMBER
plans: FREE, STANDARD, PREMIUM
keywords: create issue, new issue, add task, report bug, new task, issue type, priority, draft, complexity, points, estimate, acceptance criteria, due date, parent issue, watchers, severity
---

Create a task, bug or feature request. **Members, admins and owners** can create issues; guests can't.

## Open the form

Click **+** in the top bar, or **New Issue** on any issues page. You can also start from a template (see *Issue templates*).

## Fill it in

1. **Title:** a short summary. Required.
2. **Issue Type:**
   - **Task:** a piece of work. Needs a **Complexity** (1 to 5 points). It starts at 1.
   - **Bug:** something broken. Add **Steps to Reproduce**, **Expected Behavior**, **Actual Behavior** and **Severity** (low, medium or high).
   - **Issue:** a feature or request. **Acceptance Criteria** are required: what must be true for it to be done. You can also add **Related Issues** and **Optional Notes**.
3. **Description:** the details. Select text to format it: titles, **bold**, *italic*, underline, bullet and numbered lists, links, code blocks and media.
4. **Subtasks:** type a step and press **Enter** to add it.
5. In **Context Parameters** on the right:
   - **Project Source:** the project. Required.
   - **Cycle**, **Priority** (low, medium, high, urgent), **Status** and **Assignee**.
   - **Labels:** search for a label. Owners and admins can also create a new one by typing a new name.
   - **Execution Window:** a **Target Date** and **Time**.
   - **Complexity** (points) and **Dept.** (department).
6. In **System Parameters**:
   - **Parent Issue:** put this issue under a bigger one.
   - **Dependencies:** link issues it blocks, is blocked by, or relates to.
   - **Watchers:** people who should be notified about changes.
   - **Integration References:** outside IDs or web links, like a ticket in another tool.
7. Add **attachments** (images and videos, or any file through Google Drive).
8. Click **Create**, or press **⌘Enter / Ctrl+Enter**.

## Good to know

- **Templates:** if your admins activated a template for the type you picked, its text fills in automatically. You can still change everything.
- **Drafts:** your form is saved in this browser every few seconds, so a reload doesn't lose it. The draft is cleared when you create the issue, switch workspace or sign out.
- **Assignee outside the project:** you're asked to add them to the project first.
- **Partly saved:** if the issue is created but something extra (like labels or watchers) can't be saved, you go to the new issue with a message saying what to add again. A second copy is never created.
- **Premium:** describe the work in plain words and let **Trussen AI** fill in the form. See *Trussen AI*.

## Common messages

- **"Please select a project":** pick a project in Context Parameters.
- **"Please select a complexity between 1 and 5":** tasks need points.
- **"Please add acceptance criteria":** issues of type Issue need them.
