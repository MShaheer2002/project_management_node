# Dashboard Module — API Reference

## Get Dashboard Data

```http
GET /dashboard
Authorization: Bearer <clerk-session-token>
X-Workspace-Id: <workspace-id>
```

Returns all data needed for the dashboard screen.

### Success

```json
{
  "success": true,
  "data": {
    "workspace": {
      "id": "uuid",
      "name": "Acme Corp",
      "slug": "acme",
      "logo": null,
      "teamSize": "SMALL"
    },
    "stats": {
      "issuesCompleted": 0,
      "activeProjects": 0,
      "teamMembers": 1,
      "openIssues": 0,
      "unreadNotifications": 0
    },
    "charts": {
      "velocity": [],
      "sprintProgress": []
    },
    "assignedToMe": [],
    "activeProjects": [],
    "upcomingDeadlines": [],
    "teamActivity": []
  }
}
```

### Errors

| HTTP | Code | Meaning |
|---|---|---|
| `401` | `UNAUTHORIZED` | Missing or invalid Clerk session |
| `403` | `NOT_WORKSPACE_MEMBER` | User is not a member of the active workspace |
| `400` | `WORKSPACE_NOT_FOUND` | Missing `X-Workspace-Id` header |
