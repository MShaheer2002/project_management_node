# Auth Module — Setup Guide

> This guide walks through setting up Clerk as the authentication provider for Linearis.
> Follow every step before writing any auth code.

---

## 1. Create a Clerk Application

1. Go to [https://dashboard.clerk.com](https://dashboard.clerk.com)
2. Click **"Add application"**
3. Enter application name: `Linearis` (or `Linearis Dev` for development)
4. Select sign-in methods:
   - ✅ Email address
   - ✅ Google
   - ✅ GitHub
5. Click **"Create application"**

---

## 2. Configure Sign-In Methods

### 2.1 Email + Password

1. Go to **User & Authentication → Email, Phone, Username**
2. Ensure these are enabled:
   - ✅ Email address (required)
   - ✅ Password (required)
   - ✅ Email verification (required — 4-digit code)
3. Under **Authentication strategies**:
   - ✅ Password
   - ✅ Email verification code

### 2.2 Google OAuth

1. Go to **User & Authentication → Social Connections**
2. Click **Google**
3. Toggle **Enabled** → ON
4. For development: Clerk provides shared credentials (works out of the box)
5. For production: You need your own Google OAuth credentials:
   - Go to [Google Cloud Console](https://console.cloud.google.com)
   - Create a project (or use existing)
   - Go to **APIs & Services → Credentials**
   - Click **Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: Add `https://clerk.<your-domain>.com/v1/oauth_callback`
     (Clerk provides the exact URI in the dashboard)
   - Copy **Client ID** and **Client Secret** into Clerk dashboard
6. Click **Save**

### 2.3 GitHub OAuth

1. Go to **User & Authentication → Social Connections**
2. Click **GitHub**
3. Toggle **Enabled** → ON
4. For development: Clerk provides shared credentials (works out of the box)
5. For production: You need your own GitHub OAuth app:
   - Go to [GitHub Developer Settings](https://github.com/settings/developers)
   - Click **New OAuth App**
   - Application name: `Linearis`
   - Homepage URL: `https://linearis.app` (your production URL)
   - Authorization callback URL: Clerk provides this in the dashboard
     (format: `https://clerk.<your-domain>.com/v1/oauth_callback`)
   - Copy **Client ID** and **Client Secret** into Clerk dashboard
6. Click **Save**

---

## 3. Configure Session Settings

1. Go to **Sessions → Settings**
2. Session lifetime:
   - **Session maximum lifetime:** 7 days
   - **Inactivity timeout:** 24 hours
3. Multi-session: **Disabled** (one session per device is simpler)
4. Token lifetime:
   - **JWT expiration:** 60 seconds (short — Clerk auto-refreshes on the frontend)

---

## 4. Get API Keys

1. Go to **API Keys** in the Clerk dashboard
2. Copy these values into your `.env` file:

```env
# From Clerk Dashboard → API Keys
CLERK_PUBLISHABLE_KEY=pk_test_xxxxx    # Frontend key (safe to expose)
CLERK_SECRET_KEY=sk_test_xxxxx          # Backend key (NEVER expose)
```

---

## 5. Set Up Webhook

Webhooks allow Clerk to notify our backend when users are created, updated, or deleted.
This is how we keep our `User` table in sync with Clerk.

### 5.1 Create the Webhook Endpoint in Clerk

1. Go to **Webhooks** in the Clerk dashboard
2. Click **"Add Endpoint"**
3. Configure:
   - **Endpoint URL:**
     - Development: `https://<your-ngrok-url>/webhooks/clerk`
     - Production: `https://api.linearis.app/webhooks/clerk`
   - **Subscribe to events:**
     - ✅ `user.created`
     - ✅ `user.updated`
     - ✅ `user.deleted`
   - Leave all other events unchecked
4. Click **Create**

### 5.2 Get the Webhook Signing Secret

1. After creating the webhook, click on it to open details
2. Under **Signing Secret**, click **Reveal**
3. Copy the value (starts with `whsec_`)
4. Add to your `.env`:

```env
CLERK_WEBHOOK_SECRET=whsec_xxxxx
```

### 5.3 Exposing Localhost for Development

Clerk needs to reach your local server to send webhooks. Options:

**Option A: ngrok (recommended)**
```bash
# Install ngrok
brew install ngrok

# Expose local port 8000
ngrok http 8000

# Copy the https URL (e.g., https://abc123.ngrok.io)
# Paste into Clerk webhook endpoint URL: https://abc123.ngrok.io/webhooks/clerk
```

**Option B: Clerk CLI (alternative)**
```bash
# Install Clerk CLI
npm install -g @clerk/cli

# Forward webhooks to localhost
clerk webhook forward --url http://localhost:8000/webhooks/clerk
```

---

## 6. Environment Variables Summary

After completing all steps above, your `.env` should contain:

```env
# Clerk Authentication
CLERK_PUBLISHABLE_KEY=pk_test_xxxxx        # From: Dashboard → API Keys
CLERK_SECRET_KEY=sk_test_xxxxx              # From: Dashboard → API Keys
CLERK_WEBHOOK_SECRET=whsec_xxxxx            # From: Dashboard → Webhooks → Signing Secret
```

---

## 7. Dependencies

These packages must be installed (already done in Phase 0):

```bash
npm install @clerk/express   # Clerk Express SDK (middleware, JWT verification)
npm install svix             # Webhook signature verification library (used by Clerk)
```

---

## 8. Frontend Setup (Custom UI — No Clerk Components)

We use our own custom sign-up/sign-in forms. Clerk handles the logic headlessly.

```bash
npm install @clerk/clerk-react   # or @clerk/nextjs for Next.js
```

Frontend wraps the app in `<ClerkProvider>` (required for hooks):

```tsx
<ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
  <App />
</ClerkProvider>
```

### 8.1 Custom Sign-Up Flow (Email + Password)

```tsx
import { useSignUp } from "@clerk/clerk-react";

const { signUp, setActive } = useSignUp();

// Step 1: Create sign-up attempt
await signUp.create({ emailAddress, password, firstName, lastName });

// Step 2: Send email verification code
await signUp.prepareEmailAddressVerification({ strategy: "email_code" });

// Step 3: User enters the 4-digit code
await signUp.attemptEmailAddressVerification({ code: "1234" });

// Step 4: Set active session
await setActive({ session: signUp.createdSessionId });
```

### 8.2 Custom Sign-In Flow (Email + Password)

```tsx
import { useSignIn } from "@clerk/clerk-react";

const { signIn, setActive } = useSignIn();

// Step 1: Attempt sign-in
const result = await signIn.create({ identifier: email, password });

// Step 2: Set active session
if (result.status === "complete") {
  await setActive({ session: result.createdSessionId });
}
```

### 8.3 Custom OAuth Flow (Google / GitHub)

```tsx
import { useSignIn } from "@clerk/clerk-react";

const { signIn } = useSignIn();

// Redirect to OAuth provider
await signIn.authenticateWithRedirect({
  strategy: "oauth_google",  // or "oauth_github"
  redirectUrl: "/sso-callback",
  redirectUrlComplete: "/",
});
```

The `/sso-callback` page handles the OAuth return:

```tsx
import { AuthenticateWithRedirectCallback } from "@clerk/clerk-react";

// This page just renders the callback handler
export default function SSOCallback() {
  return <AuthenticateWithRedirectCallback />;
}
```

### 8.4 Sending Auth Token to Backend

After sign-in, every API request includes the Clerk session token:

```tsx
import { useAuth } from "@clerk/clerk-react";

const { getToken } = useAuth();

// Get fresh token for each request
const token = await getToken();

fetch("http://localhost:8000/me", {
  headers: { Authorization: `Bearer ${token}` },
});
```

### 8.5 Key Points for Custom UI

- Clerk does NOT render any UI — your forms call Clerk hooks for logic only
- Email verification uses a code (not a link) — your UI shows a code input field
- OAuth redirects to the provider — your UI just triggers the redirect
- Password reset uses `useSignIn().create({ strategy: "reset_password_email_code" })`
- The session token is a short-lived JWT — `getToken()` handles refresh automatically
- Our backend NEVER sees passwords — Clerk handles all credential storage

---

## 9. Verification Checklist

Before writing auth code, verify:

- [ ] Clerk application created
- [ ] Email + password sign-in enabled
- [ ] Google OAuth enabled and working (test in Clerk dashboard)
- [ ] GitHub OAuth enabled and working (test in Clerk dashboard)
- [ ] Webhook endpoint created with correct URL
- [ ] Webhook subscribed to: `user.created`, `user.updated`, `user.deleted`
- [ ] All 3 env vars in `.env`: `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`
- [ ] `@clerk/express` and `svix` packages installed
- [ ] Localhost exposed via ngrok (for development webhook testing)
- [ ] Test: Sign up a user in Clerk → verify webhook fires (check Clerk dashboard → Webhooks → Logs)

---

## 10. Clerk Dashboard URLs (Bookmarks)

| Page | URL |
|------|-----|
| Dashboard home | https://dashboard.clerk.com |
| API Keys | https://dashboard.clerk.com/apps/YOUR_APP_ID/api-keys |
| User & Auth settings | https://dashboard.clerk.com/apps/YOUR_APP_ID/user-authentication |
| Social connections | https://dashboard.clerk.com/apps/YOUR_APP_ID/user-authentication/social-connections |
| Webhooks | https://dashboard.clerk.com/apps/YOUR_APP_ID/webhooks |
| Webhook logs | https://dashboard.clerk.com/apps/YOUR_APP_ID/webhooks/ENDPOINT_ID/logs |
| Users list | https://dashboard.clerk.com/apps/YOUR_APP_ID/users |

---

## 11. Security Notes

- `CLERK_SECRET_KEY` is a **backend-only secret** — NEVER expose it in frontend code, logs, or error messages
- `CLERK_WEBHOOK_SECRET` must be verified on EVERY webhook request — reject unsigned payloads
- Clerk handles password hashing, OAuth token storage, and session management — we NEVER store these
- In production, use HTTPS for the webhook endpoint (required by Clerk)
- Rotate keys immediately if they are ever exposed (Dashboard → API Keys → Rotate)
