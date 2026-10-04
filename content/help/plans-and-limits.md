---
id: plans-and-limits
title: Plans and limits
category: Billing
route: /billing
roles: OWNER, ADMIN, MEMBER, GUEST
plans: FREE, STANDARD, PREMIUM
keywords: plan, pricing, free plan, standard, premium, limits, upgrade, how much, price, seats, storage, cost, compare plans, what's included
---

Billing belongs to the **workspace**. The owner pays, and everyone in the workspace gets its plan.

| | Free | Standard | Premium |
|---|---|---|---|
| Price | $0 | {{price.standard}} per member per month | {{price.premium}} per member per month |
| Members | {{free.memberCap}} (including pending invites) | Unlimited | Unlimited |
| Teams | {{free.teamCap}} | Unlimited | Unlimited |
| Storage | {{free.storage}} | {{standard.storage}} | Unlimited |
| Integrations | {{free.integrations}} | All | All |
| Google Drive uploads | Yes | Yes | Yes |
| AI Assistance (help) | Yes | Yes | Yes |
| AI apps through MCP | Yes | Yes | Yes |
| Trussen AI | No | No | Yes |
| AI requests per day | {{ai.freeDailyRequests}} | {{ai.standardDailyRequests}} | {{ai.premiumDailyRequests}} |

Everything else, like issues, projects, cycles, documents and roles, works on every plan.

## Seats

**Seats** are the members of the workspace. A Standard workspace with 9 members pays for 9 seats. When people join or are removed, the bill adjusts.

## Storage

Storage counts files uploaded to Trussen. Files uploaded to Google Drive don't count. When storage is full, new uploads are blocked until you free space or upgrade.

## Upgrade

Only the **owner** can change the plan, in **Billing**. Members and guests: ask your owner.

## If a paid plan ends

The workspace goes back to Free. Nothing is deleted. If it has more than {{free.memberCap}} members, only the owner and the earliest members up to the limit keep access until it's upgraded again.
