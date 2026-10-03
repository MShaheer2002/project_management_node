---
id: github
title: GitHub
category: Integrations
route: /integrations
roles: OWNER, ADMIN
plans: STANDARD, PREMIUM
keywords: github, pull request, pr, commit, branch, link issue, auto close, merge, connect github, review status, development section, repository, repo
---

Connect GitHub so code work shows up on your issues. Available on **Standard** and **Premium**. Owners and admins connect it.

## Connect

1. Open **Integrations** and click **Connect** on GitHub.
2. Sign in to GitHub and approve Trussen.
3. Trussen connects to the repositories where your GitHub account has **admin** rights, up to 100 of the most recently used ones.

Activity from other repositories is ignored. To add a repository later, make sure the person connecting is an admin of it, then disconnect and connect again.

## Link code to an issue

Put the issue ID in your work. Trussen looks for it in:

- **Commit messages:** `ACME-24 fix login crash`
- **Branch names:** `feature/ACME-24-login`
- **Pull request titles and descriptions:** `Fixes ACME-24 and ACME-25`

Upper or lower case both work. One commit or PR can link to several issues. The issue must be in this workspace.

## What you see on the issue

The issue shows a **Development** section with its **Branches** and **Pull Requests**. Branches, commits and pull request events also appear in the issue's activity.

## Automations

When a linked pull request is:

- **Opened** (or reopened): the issue moves to the review status.
- **Merged:** the issue moves to the done status and is marked completed.
- **Closed without merging:** it's noted on the issue. The status doesn't change.

Which status is used for "opened" and "merged" is set in your workflow. See *Workflow statuses*.

## Settings

Click **Settings** on the GitHub card:

| Section | Option |
|---|---|
| Automation | Auto-complete issue when PR is merged |
| Automation | Move issue to "Review" when PR is opened |
| Notifications | Notify assignee when PR is opened, reviewed or merged |
| Display | Show commits in issue activity feed |
| Display | Show branches in issue activity feed |

## Disconnect

**Disconnect** stops tracking branches, commits and PRs, and stops automatic status changes. Links already on issues stay.
