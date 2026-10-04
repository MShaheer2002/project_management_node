---
id: plan-limit-messages
title: Plan limit messages explained
category: Billing
roles: OWNER, ADMIN, MEMBER, GUEST
plans: FREE, STANDARD, PREMIUM
keywords: limit reached, upgrade required, cannot invite, cannot create team, not available on your plan, access limit, over limit, error, storage full, storage limit, daily ai limit
---

What each plan message means, and what to do.

## "Free plan supports up to {{free.memberCap}} workspace members and pending invites combined."

The workspace is full on Free. Pending invites count too.

- Revoke invites nobody will use, in **Members**.
- Remove people who no longer need access.
- Or ask the owner to upgrade.

## "Free plan supports up to {{free.teamCap}} teams."

Free allows {{free.teamCap}} teams. Delete a team you don't need, or ask the owner to upgrade.

## "GitHub is available on Standard or Premium."

That integration needs a paid plan. The same message appears for Discord and Figma. On Free, only {{free.integrations}} can be connected.

## "This workspace is over the Free plan's {{free.memberCap}}-member limit."

The workspace has more members than Free allows, usually after a paid plan ended. Only the owner and the earliest members up to the limit can get in. Nobody is removed. When the owner upgrades, everyone gets access again.

## "Workspace storage limit of {{free.storage}} exceeded."

The workspace has used all its storage. The size in the message is your plan's limit. Delete files you don't need, upload to Google Drive instead, or ask the owner to upgrade.

## "AI is currently available on the Premium plan."

That AI feature needs Premium. AI Assistance (help) and AI apps through MCP work on every plan.

## "The workspace's daily AI request limit has been reached."

The workspace used today's AI allowance. A similar message mentions the token limit. It resets at midnight UTC. See *AI Usage*.
