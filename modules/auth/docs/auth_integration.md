# Auth Integration Guide

> Complete guide for integrating Clerk authentication between the frontend (custom UI) and the Trussen backend.
> This covers the full flow from sign-up to authenticated API calls.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (React)                               │
│                                                                          │
│  Custom UI Forms → Clerk Headless SDK → Session Token → API Calls       │
└────────────────────────────────────────┬────────────────────────────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    │                    │                     │
                    ▼                    ▼                     ▼
         ┌──────────────┐    ┌──────────────────┐   ┌───────────────┐
         │  Clerk Cloud  │    │  Backend (Express) │   │  PostgreSQL   │
         │               │    │                    │   │               │
         │ - User store  │    │ - JWT verification │   │ - User table  │
         │ - OAuth       │───▶│ - Webhook handler  │──▶│ - Memberships │
         │ - Sessions    │    │ - Auth middleware   │   │ - All data    │
         │ - 2FA         │    │                    │   │               │
         └──────────────┘    └──────────────────┘   └───────────────┘
                │                                          ▲
                │         Webhook (user.created)           │
                └─────────────────────────────────────────┘
```

**Key principle:** Clerk owns auth state (passwords, OAuth tokens, sessions). Our backend only stores profile data (name, email, avatar) synced via webhooks. The frontend calls Clerk for auth actions and our backend for application data.

---

## 2. Frontend Setup

### 2.1 Install Dependencies

```bash
npm install @clerk/clerk-react
```

### 2.2 Wrap App in ClerkProvider

```tsx
// src/main.tsx (or App.tsx)
import { ClerkProvider } from "@clerk/clerk-react";

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

function App() {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
      <Router>
        {/* Your routes */}
      </Router>
    </ClerkProvider>
  );
}
```

**Environment variable (frontend):**
```env
VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxxxx
```

---

## 3. Sign-Up Flow (Email + Password)

### 3.1 Frontend Implementation

```tsx
import { useSignUp } from "@clerk/clerk-react";
import { useState } from "react";

export function SignUpPage() {
  const { signUp, setActive, isLoaded } = useSignUp();
  const [step, setStep] = useState<"form" | "verify">("form");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  if (!isLoaded) return null;

  // Step 1: Submit sign-up form
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    try {
      // Create sign-up attempt with Clerk
      await signUp.create({
        emailAddress: email,
        password,
        firstName,
        lastName,
      });

      // Send email verification code (4-digit)
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });

      // Move to verification step
      setStep("verify");
    } catch (err: any) {
      setError(err.errors?.[0]?.message || "Sign-up failed");
    }
  }

  // Step 2: Verify email with code
  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    try {
      const result = await signUp.attemptEmailAddressVerification({ code });

      if (result.status === "complete") {
        // Set active session — user is now logged in
        await setActive({ session: result.createdSessionId });
        // Redirect to workspace creation (first-time user)
        window.location.href = "/onboarding";
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.message || "Invalid verification code");
    }
  }

  if (step === "verify") {
    return (
      <form onSubmit={handleVerify}>
        <p>Enter the 4-digit code sent to {email}</p>
        <input value={code} onChange={(e) => setCode(e.target.value)} />
        {error && <p className="error">{error}</p>}
        <button type="submit">Verify</button>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <input placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
      <input placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="error">{error}</p>}
      <button type="submit">Sign Up</button>
    </form>
  );
}
```

### 3.2 What Happens on the Backend

When the user completes sign-up:

1. Clerk creates the user in their system
2. Clerk fires a `user.created` webhook to `POST /webhooks/clerk`
3. Our backend verifies the webhook signature (svix)
4. Our backend creates a `User` row in PostgreSQL:
   ```
   User {
     id: "user_2x1abc123"    (Clerk's user_id — used as our PK)
     email: "john@example.com"
     name: "John Doe"
     avatar: "https://img.clerk.com/..."
   }
   ```
5. The frontend can now call `GET /me` and get the user's profile

---

## 4. Sign-In Flow (Email + Password)

### 4.1 Frontend Implementation

```tsx
import { useSignIn } from "@clerk/clerk-react";
import { useState } from "react";

export function SignInPage() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  if (!isLoaded) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    try {
      const result = await signIn.create({
        identifier: email,
        password,
      });

      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        window.location.href = "/"; // Redirect to dashboard
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.message || "Invalid credentials");
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="error">{error}</p>}
      <button type="submit">Sign In</button>
    </form>
  );
}
```

---

## 5. OAuth Flow (Google / GitHub)

### 5.1 Frontend Implementation

```tsx
import { useSignIn } from "@clerk/clerk-react";

export function OAuthButtons() {
  const { signIn, isLoaded } = useSignIn();

  if (!isLoaded) return null;

  async function handleOAuth(strategy: "oauth_google" | "oauth_github") {
    try {
      await signIn.authenticateWithRedirect({
        strategy,
        redirectUrl: "/sso-callback",         // Where Clerk redirects after OAuth
        redirectUrlComplete: "/",             // Where to go after auth is complete
      });
    } catch (err) {
      console.error("OAuth error:", err);
    }
  }

  return (
    <div>
      <button onClick={() => handleOAuth("oauth_google")}>
        Continue with Google
      </button>
      <button onClick={() => handleOAuth("oauth_github")}>
        Continue with GitHub
      </button>
    </div>
  );
}
```

### 5.2 SSO Callback Page

Create a route at `/sso-callback` that handles the OAuth redirect return:

```tsx
// src/pages/sso-callback.tsx
import { AuthenticateWithRedirectCallback } from "@clerk/clerk-react";

export function SSOCallbackPage() {
  // This component handles the OAuth callback automatically
  // It verifies the code, creates the session, and redirects to redirectUrlComplete
  return <AuthenticateWithRedirectCallback />;
}
```

### 5.3 What Happens on the Backend

OAuth sign-up triggers the same webhook flow as email sign-up:
1. User clicks "Continue with Google" → redirected to Google → consent → back to app
2. Clerk creates user (if new) or matches existing user (if returning)
3. Clerk fires `user.created` webhook (new user) or does nothing (existing user)
4. Our backend syncs the user data via webhook
5. Frontend gets a session token and calls our API

**There is NO difference in backend handling between email and OAuth users.**
The `User` table doesn't even know which auth method was used — Clerk owns that information.

---

## 6. Password Reset Flow

### 6.1 Frontend Implementation

```tsx
import { useSignIn } from "@clerk/clerk-react";
import { useState } from "react";

export function ForgotPasswordPage() {
  const { signIn, setActive, isLoaded } = useSignIn();
  const [step, setStep] = useState<"email" | "code" | "newPassword">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");

  if (!isLoaded) return null;

  // Step 1: Request reset code
  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    try {
      await signIn.create({
        strategy: "reset_password_email_code",
        identifier: email,
      });
      setStep("code");
    } catch (err: any) {
      setError(err.errors?.[0]?.message || "Failed to send reset code");
    }
  }

  // Step 2: Verify code and set new password
  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    try {
      const result = await signIn.attemptFirstFactor({
        strategy: "reset_password_email_code",
        code,
        password: newPassword,
      });

      if (result.status === "complete") {
        await setActive({ session: result.createdSessionId });
        window.location.href = "/";
      }
    } catch (err: any) {
      setError(err.errors?.[0]?.message || "Reset failed");
    }
  }

  // Render based on step...
}
```

### 6.2 Backend Impact

**None.** Password reset is entirely handled by Clerk. Our backend is not involved at all. No webhook fires for password changes.

---

## 7. Making Authenticated API Calls

### 7.1 Getting the Session Token

After sign-in, every API call to our backend must include the Clerk session token:

```tsx
import { useAuth } from "@clerk/clerk-react";

export function useApi() {
  const { getToken } = useAuth();

  async function apiCall(path: string, options: RequestInit = {}) {
    // getToken() returns a fresh JWT (handles refresh automatically)
    const token = await getToken();

    const response = await fetch(`http://localhost:8000${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error.message);
    }

    return data.data;
  }

  return { apiCall };
}
```

### 7.2 Usage in Components

```tsx
import { useApi } from "../hooks/useApi";

export function Dashboard() {
  const { apiCall } = useApi();
  const [user, setUser] = useState(null);

  useEffect(() => {
    apiCall("/me").then(setUser);
  }, []);

  if (!user) return <p>Loading...</p>;
  return <h1>Welcome, {user.name}</h1>;
}
```

### 7.3 What Happens on the Backend

```
Frontend: GET /me with Authorization: Bearer eyJhbG...
                                │
                                ▼
[clerkMiddleware] ──── Parses JWT, makes it available via getAuth()
                                │
                                ▼
[authenticate] ─────── getAuth(req) → { userId: "user_2x1abc123" }
                      │ Looks up User in DB
                      │ Attaches to req.user = { id, email, name }
                                │
                                ▼
[authController.getMe] ─── Calls authService.getUserById(req.user.id)
                          │ Returns full profile from DB
                                │
                                ▼
Response: { success: true, data: { id, email, name, avatar, ... } }
```

---

## 8. Adding Workspace Context (Phase 2 Preview)

Once workspaces are built, API calls will also include the active workspace:

```tsx
async function apiCall(path: string, options: RequestInit = {}) {
  const token = await getToken();

  const response = await fetch(`http://localhost:8000${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Workspace-Id": activeWorkspaceId,   // ← Added in Phase 2
      ...options.headers,
    },
  });

  // ...
}
```

The backend `requireWorkspace` middleware will read this header, verify the user is a member, and attach `req.workspace = { id, role }`.

---

## 9. Handling Auth State in Frontend

### 9.1 Checking if User is Signed In

```tsx
import { useUser, useAuth } from "@clerk/clerk-react";

export function App() {
  const { isSignedIn, isLoaded } = useUser();
  const { signOut } = useAuth();

  if (!isLoaded) return <LoadingSpinner />;

  if (!isSignedIn) {
    return <Navigate to="/login" />;
  }

  return (
    <div>
      <AppLayout />
      <button onClick={() => signOut()}>Logout</button>
    </div>
  );
}
```

### 9.2 Protecting Routes

```tsx
import { useUser } from "@clerk/clerk-react";
import { Navigate } from "react-router-dom";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useUser();

  if (!isLoaded) return <LoadingSpinner />;
  if (!isSignedIn) return <Navigate to="/login" replace />;

  return <>{children}</>;
}
```

### 9.3 Sign Out

```tsx
import { useAuth } from "@clerk/clerk-react";

function LogoutButton() {
  const { signOut } = useAuth();

  return (
    <button onClick={() => signOut({ redirectUrl: "/login" })}>
      Logout
    </button>
  );
}
```

---

## 10. Error Handling Reference

| Backend Error Code | HTTP Status | When | Frontend Action |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | No token or expired/invalid token | Redirect to `/login` |
| `USER_NOT_SYNCED` | 403 | Token valid but user not in DB yet | Retry after 1-2 seconds (webhook delay) |

### 10.1 Handling 401 Globally

```tsx
// In your API hook or axios interceptor
if (response.status === 401) {
  // Token expired or invalid — Clerk should auto-refresh
  // If still 401 after getToken(), force sign-out
  await signOut();
  window.location.href = "/login";
}

if (response.status === 403 && data.error.code === "USER_NOT_SYNCED") {
  // Webhook hasn't fired yet — wait and retry
  await new Promise((r) => setTimeout(r, 2000));
  return apiCall(path, options); // Retry once
}
```

---

## 11. Webhook Flow (Backend Details)

### 11.1 Event: `user.created`

**Trigger:** User completes sign-up (email verification passes OR OAuth succeeds)

**Payload received:**
```json
{
  "type": "user.created",
  "data": {
    "id": "user_2x1abc123",
    "email_addresses": [
      { "id": "idn_xxx", "email_address": "john@example.com" }
    ],
    "first_name": "John",
    "last_name": "Doe",
    "image_url": "https://img.clerk.com/abc123"
  }
}
```

**Backend action:** Upsert User row in PostgreSQL

### 11.2 Event: `user.updated`

**Trigger:** User changes their name, email, or avatar in profile settings

**Backend action:** Update the User row with new values

### 11.3 Event: `user.deleted`

**Trigger:** User deletes their account (or admin deletes from Clerk dashboard)

**Payload received:**
```json
{
  "type": "user.deleted",
  "data": {
    "id": "user_2x1abc123"
  }
}
```

**Backend action:** Delete User row (cascades all memberships, unassigns issues)

---

## 12. Testing Auth Locally

### 12.1 Test Sign-Up → Webhook → DB

1. Start your backend: `npm run dev`
2. Expose via ngrok: `ngrok http 8000`
3. Set ngrok URL in Clerk webhook settings
4. Sign up a user on the frontend (or via Clerk dashboard → Users → Create)
5. Check webhook received: Clerk Dashboard → Webhooks → Logs
6. Verify User in DB:
   ```bash
   npx prisma studio
   # Open User table — should see the new user
   ```

### 12.2 Test Authenticated API Call

```bash
# Get a session token from your frontend (browser devtools → Network → any API call → copy Authorization header)

curl http://localhost:8000/me \
  -H "Authorization: Bearer eyJhbGciOiJSUzI1NiIs..."
```

Expected response:
```json
{
  "success": true,
  "data": {
    "id": "user_2x1abc123",
    "email": "john@example.com",
    "name": "John Doe",
    "avatar": "https://img.clerk.com/abc123",
    "lastActiveAt": null,
    "createdAt": "2026-05-16T08:30:00.000Z"
  }
}
```

### 12.3 Test Unauthorized Access

```bash
# No token
curl http://localhost:8000/me
# → 401: { "success": false, "error": { "code": "UNAUTHORIZED", ... } }

# Invalid token
curl http://localhost:8000/me -H "Authorization: Bearer invalid_token"
# → 401: { "success": false, "error": { "code": "UNAUTHORIZED", ... } }
```

---

## 13. File Reference

```
modules/auth/
├── docs/
│   ├── setup-guide.md           ← Clerk dashboard configuration
│   └── auth_integration.md      ← THIS FILE (frontend + backend integration)
├── auth.routes.ts               ← POST /webhooks/clerk, GET /me
├── auth.controller.ts           ← getMe handler
├── auth.service.ts              ← createUser, updateUser, deleteUser, getUserById
├── auth.schemas.ts              ← Zod schema for Clerk webhook payload
└── webhook.handler.ts           ← Signature verification + event dispatch

shared/middleware/
└── authenticate.ts              ← JWT verification middleware (used by all protected routes)
```

---

## 14. Decisions & Rationale

| Decision | Why |
|----------|-----|
| User.id = Clerk user_id (not UUID) | Direct PK lookup on every request — no join or secondary index needed |
| Upsert on user.created | Idempotent — duplicate webhooks don't crash the system |
| 403 USER_NOT_SYNCED (not 401) | Token IS valid — the user exists in Clerk. Our DB just hasn't caught up yet. Retry will work. |
| No password/OAuth fields in User table | Clerk owns all auth state. We only store what we need for display and relations. |
| clerkMiddleware is global + permissive | Parses token on every request but doesn't block. authenticate middleware handles blocking. |
| lastActiveAt updated fire-and-forget | Non-critical update shouldn't slow down the /me response or cause errors |
