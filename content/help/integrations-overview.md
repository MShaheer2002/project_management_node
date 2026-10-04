---
id: integrations-overview
title: Integrations
category: Integrations
route: /integrations
primary: true
roles: OWNER, ADMIN
plans: FREE, STANDARD, PREMIUM
keywords: integrations, connect app, connected apps, slack, github, discord, figma, google drive, disconnect integration, admin access required, request integration
---

Connect Trussen to the tools your team already uses. Open **Integrations** from the sidebar.

## Who can do what

- **Owners and admins** connect, set up and disconnect workspace integrations like Slack, GitHub, Discord and Figma.
- **Members** can open Integrations to connect their own Google Drive. Other cards show **Admin access required**.
- **Guests** can't open Integrations.

## What each one does

| Integration | What it does | Plans |
|---|---|---|
| Slack | Channel notifications, direct messages and the `/trussen` command | All plans |
| GitHub | Links branches, commits and pull requests to issues, and moves issues when PRs open or merge | Standard, Premium |
| Discord | Posts issue and project updates to your channels | Standard, Premium |
| Figma | Shows previews of Figma designs on issues | Standard, Premium |
| Google Drive | Uploads files to Google Drive. Trussen stores only the links. | All plans |

On Free, only {{free.integrations}} can be connected as a workspace integration. Locked ones are grouped in an **Unlock More Integrations** card with an **Upgrade Plan** button for owners and admins.

## Connect one

1. Find the card. Use **Search integrations...** to filter.
2. Click **Connect** and follow the steps. Slack and GitHub send you to their site to approve. Discord asks for a webhook URL. Figma asks for an access token.
3. When it's done, the card shows **Connected**.

Click **Settings** on a connected card to choose what it does. Each integration has its own article.

## Disconnect

Click **Disconnect** on the card. You're shown what will stop, then asked to confirm. For example, disconnecting Slack stops channel notifications, slash commands and direct messages, and removes its channel settings. Your issues are not deleted.

## Missing something?

On paid plans, use **Request Integration** to tell us what you need.
