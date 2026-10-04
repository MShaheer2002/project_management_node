---
id: discord
title: Discord
category: Integrations
route: /integrations
roles: OWNER, ADMIN
plans: STANDARD, PREMIUM
keywords: discord, discord webhook, discord notifications, channel, webhook url, connect discord, urgent webhook, project webhook
---

Post Trussen updates to your Discord channels. Available on **Standard** and **Premium**. Owners and admins set it up.

Discord works with **webhooks**: a link that lets Trussen post to one channel.

## Create a webhook in Discord

1. In Discord, right click the channel and choose **Edit Channel**.
2. Open **Integrations**, then **Webhooks**.
3. Click **New Webhook**, then **Copy URL**.

The URL starts with `https://discord.com/api/webhooks/`.

## Connect

1. In Trussen, open **Integrations** and click **Connect** on Discord.
2. Paste the webhook URL. Add a name like `#dev-updates` so you can recognize it later.
3. Save. This becomes the **Default Webhook**: all notifications go there unless a rule overrides it.

## Send some updates to other channels

Click **Settings** on the Discord card:

- **Project Webhooks:** pick a project and paste a webhook for its channel.
- **Team Webhooks:** pick a team and paste a webhook for its channel.
- **Urgent Webhook:** urgent issues are also posted here, on top of their normal channel.

## Which events are sent

Under **Channel Notifications**, turn each on or off:

- Urgent or high issue created
- Issue completed
- Issue assigned
- Issue status changed
- Cycle started
- Cycle completed
- Project completed

## Good to know

- Anyone with a webhook URL can post to that channel. After saving, Trussen only shows it masked. To change one, paste the new URL.
- If you delete the webhook in Discord, posts to that channel stop. Add a new one in Trussen.
- **Disconnect** stops all Discord notifications and removes every webhook and channel mapping.
