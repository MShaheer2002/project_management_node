---
id: slack
title: Slack
category: Integrations
route: /integrations
roles: OWNER, ADMIN, MEMBER, GUEST
plans: FREE, STANDARD, PREMIUM
keywords: slack, slack notifications, slash command, /trussen, slack dm, slack dms, not getting slack messages, slack email, channel, slack channel, default channel, connect slack, direct message
---

Get Trussen updates in Slack and create issues without leaving it. Available on **every plan**. Owners and admins connect it.

## Connect

1. Open **Integrations** and click **Connect** on Slack.
2. Pick your Slack workspace and approve Trussen.
3. Click **Settings** on the Slack card to choose channels.

## Channels

In **Slack Settings**:

- **Default Channel:** all notifications go here unless a rule below overrides it.
- **Project Channels:** send a project's notifications to its own channel. Pick the project, then the channel.
- **Team Channels:** send a team's cycle notifications to its own channel.
- **Urgent / High Priority:** an extra channel for urgent and high priority issues. These still go to their normal channel too.

## Which events are sent

Under **Channel Notifications**, turn each on or off:

- Issue created (high and urgent only)
- Issue completed
- Issue assigned
- Cycle started
- Cycle completed

## Direct messages

Under **Direct Messages**, people get a Slack DM when:

- an issue is assigned to them
- they're mentioned in a comment
- an issue is due tomorrow (due date reminders, 1 day before)

DMs only reach people whose **Slack email is the same as their Trussen email**.

## Slash commands

Turn on **Enable /trussen commands**, then in Slack:

| Command | What it does |
|---|---|
| `/trussen create Fix the login bug` | Creates an issue |
| `/trussen create Fix the login bug --priority high` | Creates it with a priority: low, medium, high or urgent |
| `/trussen status ACME-24` | Shows an issue |
| `/trussen my-issues` | Lists up to 10 of your open issues |
| `/trussen cycle` | Shows the current cycle |
| `/trussen help` | Lists the commands |

Issues created from Slack are Tasks in Backlog, in the project that was updated most recently. Move them later if needed.

Commands only work if your Slack email matches your Trussen account. Links in Slack open your workspace directly.

## Disconnect

**Disconnect** stops notifications, DMs and slash commands, and removes the channel settings.
