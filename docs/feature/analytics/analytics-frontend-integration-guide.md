# Analytics Frontend Integration Guide

## Base rules

All analytics requests must include:
- auth token/session as used by the rest of the app
- `X-Workspace-Id` header

Example header:

```http
X-Workspace-Id: <workspace-uuid>
```

Base endpoints:
- `GET /analytics/workspace`
- `GET /analytics/projects/:id`
- `GET /analytics/teams/:id`
- `GET /analytics/members/:id`
- `GET /analytics/cycles/:id`
- `GET /analytics/export`

## Query params

Supported on all analytics pages:
- `period=7d|30d|90d|custom`
- `from=YYYY-MM-DD`
- `to=YYYY-MM-DD`

Rules:
- use `period=7d`, `30d`, or `90d` for preset filters
- use `period=custom` only with both `from` and `to`
- backend returns current and previous period metadata in workspace analytics; other pages should still treat the selected period as the source of truth for charts

Example:

```http
GET /analytics/projects/0d7c1a0d-1111-2222-3333-abcdef123456?period=30d
```

Custom example:

```http
GET /analytics/members/user_123?period=custom&from=2026-05-01&to=2026-05-31
```

## Response envelope

Standard analytics endpoints return:

```json
{
  "success": true,
  "data": { ... }
}
```

Frontend should read from `response.data.data` if using Axios-style wrappers, or the inner `data` field from the raw JSON payload.

## Page-by-page integration

### 1. Workspace analytics page

Request:

```http
GET /analytics/workspace?period=30d
```

Access:
- only `ADMIN` and `OWNER`

Important fields:
- `data.period`
- `data.summary.tasksCompleted`
- `data.summary.avgResolutionTime`
- `data.summary.activeProjects`
- `data.summary.teamWorkload`
- `data.summary.overdueIssues`
- `data.summary.openVsClosed`
- `data.charts.completionVelocity`
- `data.charts.issuesByStatus`
- `data.charts.issuesByPriority`
- `data.charts.issuesByType`
- `data.tables.teamPerformance`
- `data.tables.topContributors`
- `data.tables.bottlenecks`

Suggested UI mapping:
- summary cards from `summary.*`
- line chart from `charts.completionVelocity`
- pie/donut charts from status/priority/type arrays
- tables from `tables.*`

Metric card shape:

```json
{
  "value": 12,
  "trend": 25,
  "direction": "up"
}
```

Resolution card shape:

```json
{
  "value": 18.5,
  "unit": "hours",
  "trend": -12,
  "direction": "down"
}
```

### 2. Project analytics page

Request:

```http
GET /analytics/projects/:id?period=30d
```

Important fields:
- `data.project`
- `data.summary.progress`
- `data.summary.scopeChanges`
- `data.summary.timelineHealth`
- `data.charts.burndown`
- `data.charts.completionVelocity`
- `data.charts.statusBreakdown`
- `data.charts.priorityBreakdown`
- `data.tables.memberWorkload`

Suggested UI:
- progress hero from `summary.progress`
- risk badge from `summary.timelineHealth`
- burndown line chart from `charts.burndown`
- team member workload table from `tables.memberWorkload`

Timeline health values currently returned:
- `on-track`
- `at-risk`
- `behind`
- `unknown`

### 3. Team analytics page

Request:

```http
GET /analytics/teams/:id?period=30d
```

Important fields:
- `data.team`
- `data.summary.velocity`
- `data.summary.avgResolutionTime`
- `data.charts.completionVelocity`
- `data.charts.workloadDistribution`
- `data.charts.completionRatePerMember`
- `data.charts.overduePerMember`
- `data.charts.cycleComparison`
- `data.tables.memberPerformance`

Suggested UI:
- velocity summary card from `summary.velocity`
- stacked/member bars from `workloadDistribution`
- simple comparison chart from `cycleComparison`
- sortable table from `memberPerformance`

### 4. Member analytics page

Request:

```http
GET /analytics/members/:id?period=30d
```

Access behavior:
- members can open only their own analytics
- admins/owners can open any member analytics

Important fields:
- `data.member`
- `data.summary.assigned`
- `data.summary.completed`
- `data.summary.inProgress`
- `data.summary.overdue`
- `data.summary.completionRate`
- `data.summary.avgResolutionTime`
- `data.charts.activityHeatmap`
- `data.charts.breakdownByProject`
- `data.charts.breakdownByTeam`
- `data.tables.teams`
- `data.tables.recentActivity`

Suggested UI:
- stat cards from `summary`
- heatmap grid from `activityHeatmap`
- project/team bar charts from the breakdown arrays
- recent activity list from `tables.recentActivity`

### 5. Cycle analytics page

Request:

```http
GET /analytics/cycles/:id?period=30d
```

Important fields:
- `data.cycle`
- `data.summary.progress`
- `data.summary.totalIssues`
- `data.summary.completedIssues`
- `data.summary.openIssues`
- `data.summary.avgResolutionTime`
- `data.charts.burndown`
- `data.charts.dailyVelocity`
- `data.charts.statusBreakdown`
- `data.charts.priorityBreakdown`
- `data.charts.typeBreakdown`

Suggested UI:
- cycle progress header
- burndown chart
- daily velocity chart
- issue mix charts

## Export integration

Request pattern:

```http
GET /analytics/export?scope=project&scopeId=<project-id>&format=csv&period=30d
```

Supported scopes:
- `workspace`
- `project`
- `team`
- `member`
- `cycle`

Formats:
- `csv`
- `json`
- `pdf`

Important behavior:
- response is a file download, not the normal JSON envelope
- backend sets `Content-Disposition: attachment`
- frontend should use `blob`/`arraybuffer` handling

Browser example with `fetch`:

```ts
async function downloadAnalytics(url: string, token: string, workspaceId: string) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Workspace-Id": workspaceId,
    },
  });

  if (!response.ok) {
    throw new Error("Export failed");
  }

  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename=\"?([^\"]+)\"?/);
  const fileName = match?.[1] || "analytics-export";

  const urlObject = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = urlObject;
  link.download = fileName;
  link.click();
  window.URL.revokeObjectURL(urlObject);
}
```

## Error handling expectations

Frontend should handle these statuses:
- `400` missing workspace context
- `401` unauthenticated
- `403` forbidden by role or scope rules
- `404` entity not found or not visible
- `422` invalid query params

Examples:
- member opens another member analytics without admin role -> `403`
- non-admin opens workspace analytics -> `403`
- `period=custom` without `from/to` -> `422`
- wrong project/team/cycle id -> `404`

## Recommended frontend implementation order

1. Build a shared analytics query state object: `period`, `from`, `to`
2. Build a shared API client helper that always injects `X-Workspace-Id`
3. Implement workspace page cards/charts first
4. Reuse chart components for project/team/cycle pages
5. Reuse one export helper across all analytics pages
6. Gate pages/buttons in UI based on role to avoid predictable `403`s

## Practical notes

- workspace analytics should not be shown to standard members in the current backend implementation
- export button should be hidden for workspace exports unless the user is `ADMIN` or `OWNER`
- member profile analytics route should use the logged-in user id for normal members
- CSV export is flattened; frontend should treat it strictly as a download, not as structured API data
