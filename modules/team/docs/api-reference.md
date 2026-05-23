# Team Module — API Reference

## Common Rules

All team routes require:

```http
Authorization: Bearer <clerk-session-token>
X-Workspace-Id: <workspace-uuid>
```

List endpoints return:

```json
{
  "success": true,
  "data": [],
  "meta": {
    "total": 0,
    "cursor": null,
    "hasMore": false
  }
}
```

---

## Create Team

```http
POST /teams
```

Permissions: `MEMBER`, `ADMIN`, `OWNER`

### Request

```json
{
  "name": "Platform",
  "description": "Owns infra and backend systems",
  "leadId": "user_2abc",
  "departmentId": "dept-id",
  "visibility": "PUBLIC",
  "memberIds": ["user_2abc", "user_2def"]
}
```

### Success

```json
{
  "success": true,
  "data": {
    "id": "team-id",
    "name": "Platform",
    "description": "Owns infra and backend systems",
    "visibility": "PUBLIC",
    "createdAt": "2026-05-22T10:00:00.000Z",
    "updatedAt": "2026-05-22T10:00:00.000Z",
    "lead": {
      "id": "user_2abc",
      "name": "Ayesha Khan",
      "email": "ayesha@example.com",
      "avatar": null
    },
    "department": {
      "id": "dept-id",
      "name": "Engineering",
      "color": "#0F766E"
    },
    "stats": {
      "memberCount": 2,
      "projectCount": 0,
      "issueCount": 0
    }
  }
}
```

### Common Errors

| HTTP | Code | Meaning |
|---|---|---|
| `401` | `UNAUTHORIZED` | missing or invalid session |
| `403` | `INSUFFICIENT_ROLE` | guest tried to create a team |
| `404` | `LEAD_NOT_WORKSPACE_MEMBER` | `leadId` is not in the workspace |
| `404` | `DEPARTMENT_NOT_FOUND` | provided `departmentId` is not in the workspace |
| `404` | `MEMBER_NOT_WORKSPACE_MEMBER` | one or more `memberIds` are not in the workspace |
| `409` | `TEAM_NAME_TAKEN` | duplicate team name |
| `422` | `VALIDATION_ERROR` | invalid body fields |

---

## List Teams

```http
GET /teams?q=plat&cursor=<team-id>&limit=20&sort=name:asc&departmentId=<department-id>&leadId=user_2abc&visibility=PUBLIC&view=full
```

Permissions: any workspace member

### Query Params

| Param | Type | Notes |
|---|---|---|
| `q` | string | case-insensitive search across `name`, `description` |
| `cursor` | uuid | use `meta.cursor` from the previous page |
| `limit` | number | default `20`, max `100` |
| `sort` | enum | `name:asc`, `name:desc`, `createdAt:asc`, `createdAt:desc` |
| `departmentId` | uuid | optional department filter |
| `leadId` | string | Clerk user ID |
| `visibility` | enum | `PUBLIC`, `PRIVATE` |
| `view` | enum | `compact`, `full` |

### Compact Success

```json
{
  "success": true,
  "data": [
    {
      "id": "team-id",
      "name": "Platform",
      "departmentId": "dept-id"
    }
  ],
  "meta": {
    "total": 1,
    "cursor": null,
    "hasMore": false
  }
}
```

### Full Success

```json
{
  "success": true,
  "data": [
    {
      "id": "team-id",
      "name": "Platform",
      "description": "Owns infra and backend systems",
      "visibility": "PUBLIC",
      "createdAt": "2026-05-22T10:00:00.000Z",
      "updatedAt": "2026-05-22T10:00:00.000Z",
      "lead": {
        "id": "user_2abc",
        "name": "Ayesha Khan",
        "email": "ayesha@example.com",
        "avatar": null
      },
      "department": {
        "id": "dept-id",
        "name": "Engineering",
        "color": "#0F766E"
      },
      "stats": {
        "memberCount": 6,
        "projectCount": 0
      }
    }
  ],
  "meta": {
    "total": 1,
    "cursor": null,
    "hasMore": false
  }
}
```

Guests only receive public teams.

---

## Get Team Detail

```http
GET /teams/:id
```

Permissions: any workspace member if visible

### Success

```json
{
  "success": true,
  "data": {
    "id": "team-id",
    "name": "Platform",
    "description": "Owns infra and backend systems",
    "visibility": "PUBLIC",
    "createdAt": "2026-05-22T10:00:00.000Z",
    "updatedAt": "2026-05-22T10:00:00.000Z",
    "lead": {
      "id": "user_2abc",
      "name": "Ayesha Khan",
      "email": "ayesha@example.com",
      "avatar": null
    },
    "department": {
      "id": "dept-id",
      "name": "Engineering",
      "color": "#0F766E"
    },
    "stats": {
      "memberCount": 6,
      "projectCount": 0,
      "issueCount": 0
    }
  }
}
```

### Errors

| HTTP | Code | Meaning |
|---|---|---|
| `404` | `TEAM_NOT_FOUND` | team does not exist in the workspace |
| `404` | `PRIVATE_TEAM_FORBIDDEN` | guest tried to open a private team |

---

## Update Team

```http
PATCH /teams/:id
```

Permissions: `ADMIN`, `OWNER`, or current team lead

### Request

```json
{
  "name": "Platform Core",
  "description": null,
  "leadId": "user_2xyz",
  "departmentId": null,
  "visibility": "PRIVATE"
}
```

### Success

Returns the same shape as `GET /teams/:id`.

### Common Errors

| HTTP | Code | Meaning |
|---|---|---|
| `403` | `FORBIDDEN` | caller is not allowed to edit this team |
| `404` | `TEAM_NOT_FOUND` | team missing |
| `404` | `LEAD_NOT_WORKSPACE_MEMBER` | new lead is not in the workspace |
| `404` | `DEPARTMENT_NOT_FOUND` | new department is invalid for this workspace |
| `409` | `TEAM_NAME_TAKEN` | duplicate team name |

---

## Delete Team

```http
DELETE /teams/:id
```

Permissions: `ADMIN`, `OWNER`

### Success

```http
204 No Content
```

---

## List Team Members

```http
GET /teams/:id/members?q=ay&cursor=user_2abc&limit=20&sort=joinedAt:desc&role=MEMBER&view=full
```

Permissions: any workspace member if visible

### Query Params

| Param | Type | Notes |
|---|---|---|
| `q` | string | case-insensitive search across `name`, `email` |
| `cursor` | string | last `userId` from previous page |
| `limit` | number | default `20`, max `100` |
| `sort` | enum | `name:asc`, `name:desc`, `joinedAt:asc`, `joinedAt:desc` |
| `role` | enum | `OWNER`, `ADMIN`, `MEMBER`, `GUEST` |
| `view` | enum | `compact`, `full` |

### Compact Success

```json
{
  "success": true,
  "data": [
    {
      "id": "user_2abc",
      "name": "Ayesha Khan",
      "email": "ayesha@example.com",
      "role": "ADMIN"
    }
  ],
  "meta": {
    "total": 1,
    "cursor": null,
    "hasMore": false
  }
}
```

### Full Success

```json
{
  "success": true,
  "data": [
    {
      "id": "user_2abc",
      "name": "Ayesha Khan",
      "email": "ayesha@example.com",
      "avatar": null,
      "role": "ADMIN",
      "joinedAt": "2026-05-22T10:00:00.000Z",
      "department": {
        "id": "dept-id",
        "name": "Engineering"
      },
      "team": {
        "id": "team-id",
        "name": "Platform"
      }
    }
  ],
  "meta": {
    "total": 1,
    "cursor": null,
    "hasMore": false
  }
}
```

---

## Add Team Members

```http
POST /teams/:id/members
```

Permissions: `ADMIN`, `OWNER`, or current team lead

### Request

```json
{
  "userIds": ["user_2abc", "user_2def"]
}
```

### Success

```json
{
  "success": true,
  "data": {
    "added": ["user_2abc", "user_2def"]
  }
}
```

### Errors

| HTTP | Code | Meaning |
|---|---|---|
| `404` | `TEAM_NOT_FOUND` | team missing |
| `404` | `MEMBER_NOT_WORKSPACE_MEMBER` | one or more users are not workspace members |
| `409` | `MEMBER_ALREADY_IN_TEAM` | at least one user already belongs to the team |

---

## Remove Team Member

```http
DELETE /teams/:id/members/:uid
```

Permissions: `ADMIN`, `OWNER`, or current team lead

### Success

```http
204 No Content
```

### Errors

| HTTP | Code | Meaning |
|---|---|---|
| `404` | `TEAM_NOT_FOUND` | team missing |
| `404` | `MEMBER_NOT_IN_TEAM` | target user is not a team member |
| `409` | `FORBIDDEN` | target user is the current team lead; reassign lead first |
