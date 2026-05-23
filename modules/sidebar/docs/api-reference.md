# Sidebar Module — API Reference

## Get Sidebar Data

```http
GET /sidebar
Authorization: Bearer <clerk-session-token>
X-Workspace-Id: <workspace-id>
```

### Success

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "user_2x...",
      "name": "Shaheer Qureshi",
      "email": "shaheer@example.com",
      "avatar": null,
      "role": "OWNER"
    },
    "workspaces": [],
    "activeWorkspace": {
      "id": "uuid",
      "name": "abcd",
      "slug": "abcd",
      "logo": null,
      "teamSize": "SMALL",
      "role": "OWNER"
    },
    "badges": {
      "inbox": 0,
      "myIssues": 0,
      "pendingInvitations": 0
    },
    "teams": [],
    "permissions": {
      "canCreateIssue": true,
      "canCreateProject": true,
      "canCreateTeam": true,
      "canInviteMembers": true,
      "canManageSettings": true,
      "canManageBilling": true,
      "canManageApiKeys": true,
      "canManageTemplates": true,
      "canDeleteWorkspace": true
    }
  }
}
```

### Errors

| HTTP | Code | Meaning |
|---|---|---|
| `400` | `WORKSPACE_NOT_FOUND` | Missing `X-Workspace-Id` header |
| `401` | `UNAUTHORIZED` | Missing or invalid Clerk session |
| `403` | `NOT_WORKSPACE_MEMBER` | User is not a member of the active workspace |
