# AI Issue Creator (Phase 20A) — Setup Guide

> This guide covers everything needed to set up and run the Trussen AI Issue Creator.

---

## 1. Prerequisites

- Backend server running (Express + Prisma + PostgreSQL)
- Frontend running (React + Vite)
- OpenRouter account ([openrouter.ai](https://openrouter.ai))

---

## 2. OpenRouter Setup

### 2.1 Create Account

1. Go to [openrouter.ai](https://openrouter.ai)
2. Sign up (free, no card required)
3. Go to **Keys** → **+ New Key**
4. Copy the API key (starts with `sk-or-v1-...`)

### 2.2 Environment Variable

Add to your backend `.env`:

```env
# OpenRouter — AI gateway (Phase 20)
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

Also in `.env.example`:

```env
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

No frontend env var needed — all AI calls go through the backend.

---

## 3. Free vs Paid Models

### Current Setup (Free — $0)

The system uses free models on OpenRouter with automatic fallback:

```
Primary: meta-llama/llama-3.3-70b-instruct:free
    ↓ (if rate-limited)
Fallback: qwen/qwen3-coder:free
    ↓
Fallback: google/gemma-4-31b-it:free
    ↓
Fallback: qwen/qwen3-next-80b-a3b-instruct:free
    ↓
Fallback: nvidia/nemotron-3-ultra-550b-a55b:free
    ↓
Fallback: openai/gpt-oss-120b:free
```

**Limitations of free tier:**
- 20 requests/minute rate limit
- 50-1000 requests/day (depends on account age)
- Models can be temporarily unavailable
- Fallback chain handles this automatically

### Upgrading to Paid ($5 one-time)

Adding $5 credits to OpenRouter:
- Permanently increases daily limit from 50 to 1000 requests
- Unlocks paid models (faster, more reliable)
- Credits never expire
- $5 lasts for months of development (~50,000 issue generations with DeepSeek)

**Steps to upgrade:**

1. Go to [openrouter.ai/credits](https://openrouter.ai/credits)
2. Add $5 credits
3. Change one line in `modules/ai/ai.provider.ts`:

```typescript
// Before (free):
export const DEFAULT_AI_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

// After (paid — $0.0001 per call):
export const DEFAULT_AI_MODEL = "deepseek/deepseek-v4-flash";
```

4. Restart backend

No other code changes needed. The fallback chain still works — if the paid model fails, free models are used as backup.

### Model Comparison

| Model | Cost per issue | Quality | Speed | Availability |
|---|---|---|---|---|
| Llama 3.3 70B (free) | $0 | Good | 5-10s | Sometimes rate-limited |
| Qwen3 Coder (free) | $0 | Good | 5-10s | Sometimes rate-limited |
| Gemma 4 31B (free) | $0 | Good | 3-8s | More reliable |
| DeepSeek V4 Flash (paid) | $0.0001 | Excellent | 2-5s | Very reliable |
| Claude Sonnet 4 (paid) | $0.02 | Best | 3-8s | Very reliable |

---

## 4. Architecture

```
Frontend (React)                    Backend (Express)                  External
┌──────────────────┐    POST      ┌──────────────────────────┐     ┌────────────┐
│ AiIssueGenerator │──────────────│ /ai/generate-issue       │     │ OpenRouter │
│ Component        │   prompt +   │                          │     │            │
│                  │   resolved   │ 1. Sanitize prompt       │     │ → Llama    │
│ @mention dropdown│   IDs       │ 2. Rule-based detection  │────▶│ → Qwen     │
│ Type/priority    │              │ 3. Fetch workspace ctx   │     │ → Gemma    │
│ auto-detect     │◀──────────────│ 4. Call AI (OpenRouter)  │◀────│ → DeepSeek │
│ Form auto-fill  │   generated  │ 5. Validate with Zod     │     │ → Claude   │
└──────────────────┘   issue data │ 6. Resolve references    │     └────────────┘
                                  │ 7. Return to frontend    │
                                  └──────────────────────────┘
```

---

## 5. API Endpoint

### POST /ai/generate-issue

**Auth:** `authenticate` + `requireWorkspace`
**Rate limit:** `strictRateLimiter` (20 req/min)

**Request:**
```json
{
  "prompt": "Login crashes on Android, assign to @shaheer, deadline 2 days, urgent",
  "resolvedAssigneeId": "user_xyz",
  "resolvedProjectId": "proj_abc"
}
```

- `prompt` (required) — Natural language description, 5-5000 chars
- `resolvedAssigneeId` (optional) — Pre-resolved from frontend @ dropdown
- `resolvedProjectId` (optional) — Pre-resolved from frontend @ dropdown

**Response (generated):**
```json
{
  "success": true,
  "data": {
    "status": "generated",
    "title": "Android Login Crash on Google Sign-In",
    "type": "bug",
    "priority": "urgent",
    "description": "## Summary\n\nGoogle OAuth login crashes...",
    "suggestedLabels": ["bug", "android"],
    "suggestedAssigneeId": "user_xyz",
    "suggestedProjectId": "proj_abc",
    "suggestedProjectName": "Mobile App",
    "subtasks": [],
    "templateId": null,
    "suggestedDueDate": "2026-06-22",
    "suggestedEstimate": 3,
    "figmaUrls": [],
    "stepsToReproduce": "1. Open app...",
    "expectedBehavior": "OAuth consent screen should appear",
    "actualBehavior": "App crashes immediately",
    "severity": "high",
    "acceptanceCriteria": null,
    "notes": null,
    "aiModel": "google/gemma-4-31b-it:free",
    "tokensUsed": 847
  }
}
```

**Response (clarification needed):**
```json
{
  "success": true,
  "data": {
    "status": "clarification_needed",
    "message": "I need more details. Please describe...",
    "missingFields": ["details"],
    "detectedSoFar": {
      "type": "bug",
      "priority": null,
      "mentions": []
    },
    "aiModel": null,
    "tokensUsed": 0
  }
}
```

**Error codes:**
| Code | When |
|---|---|
| `AI_NOT_CONFIGURED` | `OPENROUTER_API_KEY` missing from `.env` |
| `AI_PROVIDER_ERROR` | OpenRouter returned an error |
| `AI_RESPONSE_INVALID` | AI returned invalid/unparseable JSON |
| `AI_RATE_LIMITED` | Too many requests (OpenRouter or our rate limiter) |
| `AI_BUDGET_EXCEEDED` | Daily token budget exceeded (future) |

---

## 6. What Gets Detected For Free (No AI Call)

These rule-based detections run before any AI call, saving tokens and money:

| Feature | How | Examples |
|---|---|---|
| Issue type | Keyword regex | "crash/error/bug" → BUG, "add/build" → TASK |
| Priority | Keyword regex | "urgent/asap" → URGENT, "nice to have" → LOW |
| Severity | Keyword regex | "data loss" → HIGH, "typo" → LOW |
| @mentions | Regex + dropdown | @shaheer → user ID, @project:mobile → project ID |
| Due date | Regex | "2 days" → date, "tomorrow" → date, "next week" → date |
| Estimate | Keyword regex | "simple" → 1, "complex" → 4, "huge" → 5 |
| Figma URLs | URL regex | `https://figma.com/file/...` → integration ref |
| Issue refs | Pattern match | `VAT-42` → linked issue |
| Gibberish | Vowel ratio + word analysis | "dsgjbisdbg" → rejected ($0) |
| Off-topic | Pattern match | "what is 2+2" → rejected ($0) |
| Incomplete | Word count check | "create bug" → asks for details ($0) |

---

## 7. Troubleshooting

| Issue | Solution |
|---|---|
| "AI is not configured" | Add `OPENROUTER_API_KEY` to `.env` and restart |
| "AI rate limit reached" | Wait 10 seconds or add $5 credits to OpenRouter |
| "AI returned invalid JSON" | Model returned bad format — retry (automatic fallback will try next model) |
| "AI request timed out" | OpenRouter or model is slow — retry |
| Wrong user assigned | Use the @ dropdown to select the exact user (sends user ID, not fuzzy name) |
| AI generates gibberish | Switch to a better model (DeepSeek V4 Flash recommended) |
| No labels suggested | AI only suggests labels that exist in your workspace — create labels first |
