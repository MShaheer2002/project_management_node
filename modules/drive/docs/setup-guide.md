# Google Drive Integration — Setup Guide

> This guide covers everything needed to configure Google Drive integration for Linearis.
> Follow these steps **before** starting the backend server with Drive features enabled.

---

## 1. Google Cloud Console Setup

### 1.1 Create or Select a Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (e.g., "Linearis") or select an existing one
3. Note the **Project ID** — you'll need it for reference

### 1.2 Enable the Google Drive API

1. Go to **APIs & Services → Library**
2. Search for **Google Drive API**
3. Click **Enable**

### 1.3 Configure OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Choose **External** (unless you have Google Workspace and want internal-only)
3. Fill in the required fields:
   - **App name:** Linearis
   - **User support email:** your email
   - **Developer contact email:** your email
4. Click **Save and Continue**
5. **Scopes** — Add these two scopes:
   - `https://www.googleapis.com/auth/drive.file` — Access only files created by the app
   - `https://www.googleapis.com/auth/userinfo.email` — Read user's email for display
6. Click **Save and Continue**
7. **Test users** — Add your own Google email(s) for testing
8. Click **Save and Continue** → **Back to Dashboard**

> **Note:** While in "Testing" mode, only listed test users can authorize.
> Once ready for production, submit for Google verification.

### 1.4 Create OAuth 2.0 Credentials

1. Go to **APIs & Services → Credentials**
2. Click **+ CREATE CREDENTIALS → OAuth client ID**
3. Application type: **Web application**
4. Name: "Linearis Backend"
5. **Authorized redirect URIs** — Add both:
   - `http://localhost:8000/me/drive/callback` (local development)
   - `https://<your-ngrok-or-production-url>/me/drive/callback` (testing/production)
6. Click **Create**
7. Copy the **Client ID** and **Client Secret**

---

## 2. Environment Variables

Add these to your `.env` file:

```env
# Google Drive — per-user storage integration
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret
GOOGLE_REDIRECT_URI=http://localhost:8000/me/drive/callback
ENCRYPTION_KEY=a-random-32-character-string-here
```

### Variable Details

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Yes | OAuth 2.0 Client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth 2.0 Client Secret (backend only — never expose to frontend) |
| `GOOGLE_REDIRECT_URI` | Optional | Defaults to `{BACKEND_URL}/me/drive/callback`. Set explicitly for ngrok/production. |
| `ENCRYPTION_KEY` | Yes | 32+ character string for AES-256-GCM encryption of OAuth tokens at rest. Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex').slice(0,32))"` |

### Frontend Environment

The frontend needs only the Client ID (for Google Picker API):

```env
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

**Never put the Client Secret in the frontend.**

---

## 3. Database Migration

The migration is already included. Run it if you haven't:

```bash
npx prisma migrate dev
npx prisma generate
```

This creates the `UserDriveConnection` table with encrypted token storage.

---

## 4. How It Differs From Other Integrations

| Aspect | GitHub/Slack/Discord | Google Drive |
|---|---|---|
| **Scope** | Workspace-scoped (one per workspace) | User-scoped (one per user, works across all workspaces) |
| **Who can connect** | ADMIN/OWNER only | Any authenticated user |
| **Storage** | Workspace `Integration` table | Separate `UserDriveConnection` table |
| **Token security** | Stored as plain text in `Integration.accessToken` | AES-256-GCM encrypted at rest |
| **Purpose** | Workflow automation (webhooks, notifications) | File storage offloading (upload to user's Drive) |

---

## 5. API Endpoints

All endpoints are under `/me/drive`:

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/me/drive` | `authenticate` | Get connection status |
| `POST` | `/me/drive/connect` | `authenticate` | Start OAuth flow |
| `GET` | `/me/drive/callback` | None (Google redirect) | OAuth callback |
| `DELETE` | `/me/drive/disconnect` | `authenticate` | Revoke and delete connection |
| `POST` | `/me/drive/upload-url` | `authenticate` | Generate resumable upload URL |

---

## 6. OAuth Scopes Used

| Scope | Why |
|---|---|
| `drive.file` | Can only access files that Linearis creates. Cannot read user's existing Drive files. This is the most restrictive Drive scope available. |
| `userinfo.email` | Display the connected Google account email in the UI. |

---

## 7. Testing the Flow

1. Start the backend: `npm run dev`
2. Authenticate as any user
3. `POST /me/drive/connect` → get `authUrl`
4. Open `authUrl` in browser → consent → redirects to callback
5. `GET /me/drive` → should show `{ connected: true, email: "..." }`
6. `POST /me/drive/upload-url` with `{ fileName: "test.pdf", mimeType: "application/pdf" }` → get `uploadUrl` + `accessToken`
7. `DELETE /me/drive/disconnect` → connection removed

---

## 8. Troubleshooting

| Issue | Solution |
|---|---|
| "No refresh token received" | User previously authorized. Go to [Google Account Permissions](https://myaccount.google.com/permissions), revoke Linearis access, try again. |
| "Google Drive integration is not configured" | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, or `ENCRYPTION_KEY` is missing from `.env` |
| "redirect_uri_mismatch" | The callback URL in Google Console doesn't exactly match `GOOGLE_REDIRECT_URI` in `.env` |
| Token refresh fails | The refresh token may have been revoked. User needs to reconnect. |
| "Malformed encrypted token" | `ENCRYPTION_KEY` was changed after tokens were stored. Users need to reconnect. |
