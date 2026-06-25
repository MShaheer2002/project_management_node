# Department Module — API Reference

## Common Rules

All department routes require:

```http
Authorization: Bearer <clerk-session-token>
X-Workspace-Id: <workspace-uuid>
```

List responses use:

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

## Create Department

```http
POST /departments
```

Permissions: `ADMIN`, `OWNER`

### Request

```json
{
  "name": "Engineering",
  "description": "Platform and product engineering",
  "headId": "user_2abc",
  "color": "#0F766E",
  "visibility": "PUBLIC",
  "isDefault": false,
  "memberIds": ["user_2abc", "user_2def"]
}
```

### Success

```json
{
  "success": true,
  "data": {
    "id": "dept-id",
    "name": "Engineering",
    "description": "Platform and product engineering",
    "color": "#0F766E",
    "visibility": "PUBLIC",
    "isDefault": false,
    "createdAt": "2026-05-22T10:00:00.000Z",
    "updatedAt": "2026-05-22T10:00:00.000Z",
    "head": {
      "id": "user_2abc",
      "name": "Ayesha Khan",
      "email": "ayesha@example.com",
      "avatar": null
    },
    "stats": {
      "memberCount": 2,
      "teamCount": 0,
      "projectCount": 0,
      "issueCount": 0
    }
  }
}
```

### Common Errors

| HTTP | Code | Meaning |
|---|---|---|
| `401` | `UNAUTHORIZED` | Missing or invalid session |
| `403` | `INSUFFICIENT_ROLE` | Caller is not admin/owner |
| `404` | `HEAD_NOT_WORKSPACE_MEMBER` | `headId` is not in the workspace |
| `404` | `MEMBER_NOT_WORKSPACE_MEMBER` | one or more `memberIds` are not in the workspace |
| `409` | `DEPARTMENT_NAME_TAKEN` | name already used in this workspace |
| `422` | `VALIDATION_ERROR` | invalid body fields |

---

## List Departments

```http
GET /departments?q=eng&cursor=<department-id>&limit=20&sort=name:asc&visibility=PUBLIC&headId=user_2abc&view=full
```

Permissions: any workspace member

### Query Params

| Param | Type | Notes |
|---|---|---|
| `q` | string | case-insensitive search across `name`, `description` |
| `cursor` | uuid | use previous response `meta.cursor` |
| `limit` | number | default `20`, max `100` |
| `sort` | enum | `name:asc`, `name:desc`, `createdAt:asc`, `createdAt:desc` |
| `visibility` | enum | `PUBLIC`, `PRIVATE` |
| `headId` | string | Clerk user ID |
| `view` | enum | `compact`, `full` |

### Compact Success

```json
{
  "success": true,
  "data": [
    {
      "id": "dept-id",
      "name": "Engineering"
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
      "id": "dept-id",
      "name": "Engineering",
      "description": "Platform and product engineering",
      "color": "#0F766E",
      "visibility": "PUBLIC",
      "isDefault": false,
      "createdAt": "2026-05-22T10:00:00.000Z",
      "updatedAt": "2026-05-22T10:00:00.000Z",
      "head": {
        "id": "user_2abc",
        "name": "Ayesha Khan",
        "email": "ayesha@example.com",
        "avatar": null
      },
      "stats": {
        "memberCount": 6,
        "teamCount": 2,
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

### Visibility Rule

Guests only receive public departments. Private matches are hidden.

---

## Get Department Detail

```http
GET /departments/:id
```

Permissions: any workspace member if visible

### Success

```json
{
  "success": true,
  "data": {
    "id": "dept-id",
    "name": "Engineering",
    "description": "Platform and product engineering",
    "color": "#0F766E",
    "visibility": "PUBLIC",
    "isDefault": false,
    "createdAt": "2026-05-22T10:00:00.000Z",
    "updatedAt": "2026-05-22T10:00:00.000Z",
    "head": {
      "id": "user_2abc",
      "name": "Ayesha Khan",
      "email": "ayesha@example.com",
      "avatar": null
    },
    "stats": {
      "memberCount": 6,
      "teamCount": 2,
      "projectCount": 0,
      "issueCount": 0
    },
    "analytics": {
      "period": {
        "from": "2026-06-17T00:00:00.000Z",
        "to": "2026-06-23T23:59:59.999Z",
        "previousFrom": "2026-06-10T00:00:00.000Z",
        "previousTo": "2026-06-16T23:59:59.999Z"
      },
      "summary": {
        "efficiencyPercent": {
          "value": 84,
          "trend": {
            "value": 5,
            "direction": "up"
          }
        },
        "resourceLoadPercent": {
          "value": 72,
          "trend": {
            "value": 3,
            "direction": "up"
          }
        },
        "stressIndex": {
          "value": 18,
          "trend": {
            "value": -2,
            "direction": "down"
          }
        },
        "overdueIssues": 4
      },
      "charts": {
        "velocity": [
          {
            "date": "2026-06-23",
            "label": "Mon",
            "completed": 5,
            "created": 4,
            "velocity": 5
          }
        ],
        "workload": [
          {
            "teamId": "team-id",
            "name": "Platform",
            "issues": 18,
            "completed": 11,
            "open": 7,
            "completionRate": 61
          }
        ]
      }
    }
  }
}
```

### Errors

| HTTP | Code | Meaning |
|---|---|---|
| `404` | `DEPARTMENT_NOT_FOUND` | department does not exist in workspace |
| `404` | `PRIVATE_DEPARTMENT_FORBIDDEN` | guest tried to open a private department |

---

## Update Department

```http
PATCH /departments/:id
```

Permissions: `ADMIN`, `OWNER`, or current department head

### Request

```json
{
  "name": "Product Engineering",
  "description": null,
  "headId": "user_2xyz",
  "color": "#155E75",
  "visibility": "PRIVATE",
  "isDefault": true
}
```

### Success

Returns the same shape as `GET /departments/:id`.

### Common Errors

| HTTP | Code | Meaning |
|---|---|---|
| `403` | `FORBIDDEN` | caller is not allowed to edit this department |
| `404` | `DEPARTMENT_NOT_FOUND` | department missing |
| `404` | `HEAD_NOT_WORKSPACE_MEMBER` | replacement head is not in workspace |
| `409` | `DEPARTMENT_NAME_TAKEN` | duplicate department name |

---

## Delete Department

```http
DELETE /departments/:id
```

Permissions: `ADMIN`, `OWNER`

### Success

```http
204 No Content
```

### Behavior

- removes department memberships
- clears `team.departmentId`
- clears denormalized `project.departmentId`
- clears denormalized `issue.departmentId`

---

## List Department Members

```http
GET /departments/:id/members?q=ay&cursor=user_2abc&limit=20&sort=joinedAt:desc&role=MEMBER&view=full
```

Permissions: any workspace member if the department is visible

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

## Add Department Members

```http
POST /departments/:id/members
```

Permissions: `ADMIN`, `OWNER`, or current department head

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
| `404` | `DEPARTMENT_NOT_FOUND` | department missing |
| `404` | `MEMBER_NOT_WORKSPACE_MEMBER` | one or more users are not workspace members |
| `409` | `MEMBER_ALREADY_IN_DEPARTMENT` | at least one user already belongs to the department |

---

## Remove Department Member

```http
DELETE /departments/:id/members/:uid
```

Permissions: `ADMIN`, `OWNER`, or current department head

### Success

```http
204 No Content
```

### Errors

| HTTP | Code | Meaning |
|---|---|---|
| `404` | `DEPARTMENT_NOT_FOUND` | department missing |
| `404` | `MEMBER_NOT_IN_DEPARTMENT` | target user is not a department member |

If the removed user is also the current department head, `headId` is cleared automatically.
