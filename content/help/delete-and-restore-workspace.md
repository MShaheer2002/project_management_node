---
id: delete-and-restore-workspace
title: Delete or restore a workspace
category: Workspace
route: /settings
roles: OWNER
plans: FREE, STANDARD, PREMIUM
keywords: delete workspace, close workspace, deactivate, restore workspace, recover, purge, deleted workspace, cancel account
---

Only the **owner** can delete a workspace.

## Delete

1. Open **Settings › General › Danger Zone** and choose **Delete Workspace**.
2. Type the workspace name to confirm.

## What happens

1. The workspace is **deactivated right away**. Members see that it was deactivated by the owner, and get an email. Nobody can use it, and paid plans stop renewing.
2. The owner can **restore** it for **{{workspace.graceDays}} days**. Owners get reminder emails {{workspace.reminderDays}} days before the end, and the deactivated page shows the time left.
3. After that, the workspace and all its data are **deleted permanently**, and billing ends.

## Restore

Open the workspace and choose **Restore**. A paid plan resumes if its period hasn't ended; otherwise the workspace comes back on Free.

Members of a deactivated workspace can **Switch to another workspace** or **Sign out**.
