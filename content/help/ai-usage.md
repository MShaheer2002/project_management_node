---
id: ai-usage
title: AI Usage
category: AI
route: /ai-usage
primary: true
roles: OWNER, ADMIN
plans: FREE, STANDARD, PREMIUM
keywords: ai usage, ai limits, tokens, ai cost, ai requests, daily limit, who uses ai, chat turns, issue drafts
---

See how much AI your workspace uses. Owners and admins open **AI Usage** from the sidebar.

## Usage overview

| Number | What it means |
|---|---|
| Total Tokens | How much text the AI read and wrote. Longer questions and answers use more. |
| Requests | How many times the AI was used |
| Active Users | How many people used AI |
| Chat / Drafts | Chat messages, and issues written with AI |

A chart shows the trend by day. The workspace plan is shown too.

## Per-user usage

See who uses AI the most: **Tokens**, **Chat Turns** and **Issue Drafts** for each person.

## What counts

- Trussen AI: chats, generated issues and suggestions.
- AI Assistance questions that need the AI model. Instant answers, like going to a page, don't count.
- AI apps connected through MCP don't count. They use their own model.

## Daily limits

Each workspace has a daily limit of AI requests and tokens:

| Plan | AI requests per day |
|---|---|
| Free | {{ai.freeDailyRequests}} |
| Standard | {{ai.standardDailyRequests}} |
| Premium | {{ai.premiumDailyRequests}} |

When it's reached, AI stops until the limit resets at midnight UTC.
