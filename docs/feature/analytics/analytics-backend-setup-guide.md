# Analytics Backend Setup Guide — Phase 14

## Purpose

This guide defines the complete backend implementation for workspace analytics. Analytics are computed from existing data (issues, activities, memberships, cycles) with one schema addition (`completedAt` on Issue).

All analytics are read-only aggregation endpoints. No new domain models are needed.

## Prerequisites

- Phase 13 (Billing) complete and stable
- All core entities working: Issues, Projects, Teams, Departments, Cycles, Activity, Members

---

## 1. Schema Change

### Add `completedAt` to Issue

```prisma
model Issue {
  // ... existing fields
  completedAt DateTime?  // Set when status transitions to DONE, cleared when moved back
}
```

**Migration:**

```sql
ALTER TABLE "Issue" ADD COLUMN "completedAt" TIMESTAMP;

-- Backfill: set completedAt for all existing DONE issues using their updatedAt
UPDATE "Issue" SET "completedAt" = "updatedAt" WHERE status = 'DONE';
```

**Index:**

```prisma
@@index([workspaceId, completedAt])
```

### Update Issue Service

When status changes to `DONE`:
```typescript
data.completedAt = new Date();
```

When status changes away from `DONE`:
```typescript
data.completedAt = null;
```

This must be applied in:
- `updateIssue()` — when status field is updated
- `updateIssueStatus()` — quick status endpoint
- Any bulk status update paths

---

## 2. Module Structure

```
modules/analytics/
├── analytics.routes.ts
├── analytics.controller.ts
├── analytics.service.ts
├── analytics.schemas.ts
└── analytics.utils.ts
```

---

## 3. Shared Utilities (`analytics.utils.ts`)

### Date Range Resolver

All analytics endpoints accept:

```
?period=7d|30d|90d|custom
&from=2026-01-01
&to=2026-06-01
```

```typescript
interface DateRange {
  from: Date;
  to: Date;
  previousFrom: Date; // For trend comparison
  previousTo: Date;
}

function resolveDateRange(period: string, from?: string, to?: string): DateRange
```

Example:
- `period=7d` → last 7 days, previous period = 7 days before that
- `period=30d` → last 30 days, previous period = 30 days before that
- `period=custom&from=2026-05-01&to=2026-06-01` → custom range, previous = same duration before `from`

### Trend Calculator

```typescript
function calculateTrend(current: number, previous: number): { value: number; direction: "up" | "down" | "flat" }
```

Returns percentage change between current and previous period.

### Resolution Time Calculator

```typescript
function avgResolutionTime(issues: { createdAt: Date; completedAt: Date | null }[]): number
```

Returns average time in milliseconds from `createdAt` to `completedAt` for completed issues.

---

## 4. Schemas (`analytics.schemas.ts`)

### Query Schema (shared across all endpoints)

```typescript
const analyticsQuerySchema = z.object({
  period: z.enum(["7d", "30d", "90d", "custom"]).default("30d"),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
```

### Route Param Schemas

```typescript
const projectAnalyticsParamsSchema = z.object({ id: z.string().uuid() });
const teamAnalyticsParamsSchema = z.object({ id: z.string().uuid() });
const memberAnalyticsParamsSchema = z.object({ id: z.string() });
const cycleAnalyticsParamsSchema = z.object({ id: z.string().uuid() });

const exportQuerySchema = analyticsQuerySchema.extend({
  scope: z.enum(["workspace", "project", "team", "member", "cycle"]),
  scopeId: z.string().optional(),
  format: z.enum(["csv", "json", "pdf"]).default("json"),
});
```

---

## 5. Routes (`analytics.routes.ts`)

```typescript
router.get("/analytics/workspace",
  authenticate, requireWorkspace, requireRole("ADMIN", "OWNER"),
  validate({ query: analyticsQuerySchema }),
  controller.getWorkspaceAnalytics
);

router.get("/analytics/projects/:id",
  authenticate, requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"),
  validate({ params: projectAnalyticsParamsSchema, query: analyticsQuerySchema }),
  controller.getProjectAnalytics
);

router.get("/analytics/teams/:id",
  authenticate, requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"),
  validate({ params: teamAnalyticsParamsSchema, query: analyticsQuerySchema }),
  controller.getTeamAnalytics
);

router.get("/analytics/members/:id",
  authenticate, requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"),
  validate({ params: memberAnalyticsParamsSchema, query: analyticsQuerySchema }),
  controller.getMemberAnalytics
);

router.get("/analytics/cycles/:id",
  authenticate, requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"),
  validate({ params: cycleAnalyticsParamsSchema, query: analyticsQuerySchema }),
  controller.getCycleAnalytics
);

router.get("/analytics/export",
  authenticate, requireWorkspace, requireRole("MEMBER", "ADMIN", "OWNER"),
  validate({ query: exportQuerySchema }),
  controller.exportAnalytics
);
```

---

## 6. Service Implementation (`analytics.service.ts`)

### 6.1 Workspace Analytics

**Endpoint:** `GET /analytics/workspace`

**Response shape:**

```typescript
{
  summary: {
    tasksCompleted: { value: number; trend: number; direction: "up" | "down" | "flat" };
    avgResolutionTime: { value: number; unit: "hours" | "days"; trend: number; direction: string };
    activeProjects: { value: number; trend: number; direction: string };
    teamWorkload: { value: number; trend: number; direction: string }; // % of members with assigned issues
    overdueIssues: { value: number; trend: number; direction: string };
    openVsClosed: { open: number; closed: number };
  };
  charts: {
    completionVelocity: { date: string; completed: number; created: number }[];
    issuesByStatus: { status: string; count: number }[];
    issuesByPriority: { priority: string; count: number }[];
    issuesByType: { type: string; count: number }[];
  };
  tables: {
    teamPerformance: {
      teamId: string;
      teamName: string;
      memberCount: number;
      completed: number;
      efficiency: number; // completed / (completed + open) * 100
    }[];
    topContributors: {
      userId: string;
      name: string;
      avatar: string | null;
      completed: number;
      avgResolutionHours: number;
    }[];
    bottlenecks: {
      issueId: string;
      title: string;
      status: string;
      stuckDays: number; // days since last status change
      assignee: { id: string; name: string } | null;
    }[];
  };
}
```

**Implementation approach:**

```typescript
export async function getWorkspaceAnalytics(workspaceId: string, dateRange: DateRange) {
  const { from, to, previousFrom, previousTo } = dateRange;

  // Summary cards — parallel queries
  const [
    completedCurrent,
    completedPrevious,
    completedIssuesForAvg,
    previousCompletedForAvg,
    activeProjects,
    previousActiveProjects,
    overdueCount,
    previousOverdueCount,
    totalMembers,
    membersWithAssignments,
    openCount,
    closedCount,
  ] = await Promise.all([
    // Tasks completed in current period
    prisma.issue.count({
      where: { workspaceId, status: "DONE", completedAt: { gte: from, lte: to } },
    }),
    // Tasks completed in previous period
    prisma.issue.count({
      where: { workspaceId, status: "DONE", completedAt: { gte: previousFrom, lte: previousTo } },
    }),
    // Completed issues with timestamps for avg resolution
    prisma.issue.findMany({
      where: { workspaceId, status: "DONE", completedAt: { gte: from, lte: to } },
      select: { createdAt: true, completedAt: true },
    }),
    // Previous period completed for resolution time trend
    prisma.issue.findMany({
      where: { workspaceId, status: "DONE", completedAt: { gte: previousFrom, lte: previousTo } },
      select: { createdAt: true, completedAt: true },
    }),
    // Active projects
    prisma.project.count({
      where: { workspaceId, status: "ACTIVE" },
    }),
    // Previous active projects (use createdAt as proxy)
    prisma.project.count({
      where: { workspaceId, status: "ACTIVE", createdAt: { lte: previousTo } },
    }),
    // Overdue issues
    prisma.issue.count({
      where: { workspaceId, status: { not: "DONE" }, dueDate: { lt: new Date() } },
    }),
    // Previous overdue (approximate)
    prisma.issue.count({
      where: { workspaceId, status: { not: "DONE" }, dueDate: { lt: previousTo } },
    }),
    // Total members
    prisma.workspaceMembership.count({ where: { workspaceId } }),
    // Members with at least one assigned issue
    prisma.issue.findMany({
      where: { workspaceId, status: { not: "DONE" }, assigneeId: { not: null } },
      select: { assigneeId: true },
      distinct: ["assigneeId"],
    }),
    // Open issues
    prisma.issue.count({ where: { workspaceId, status: { not: "DONE" } } }),
    // Closed issues
    prisma.issue.count({ where: { workspaceId, status: "DONE" } }),
  ]);

  // Completion velocity chart — daily breakdown
  // Group completed and created issues by day within the period
  const velocityData = await buildDailyVelocity(workspaceId, from, to);

  // Issue distribution by status, priority, type
  const [byStatus, byPriority, byType] = await Promise.all([
    prisma.issue.groupBy({
      by: ["status"],
      where: { workspaceId },
      _count: true,
    }),
    prisma.issue.groupBy({
      by: ["priority"],
      where: { workspaceId },
      _count: true,
    }),
    prisma.issue.groupBy({
      by: ["type"],
      where: { workspaceId },
      _count: true,
    }),
  ]);

  // Team performance table
  const teamPerformance = await buildTeamPerformance(workspaceId, from, to);

  // Top contributors
  const topContributors = await buildTopContributors(workspaceId, from, to);

  // Bottleneck issues — stuck longest without status change
  const bottlenecks = await buildBottlenecks(workspaceId);

  // Assemble response ...
}
```

### 6.2 Project Analytics

**Endpoint:** `GET /analytics/projects/:id`

**Queries:**

```typescript
export async function getProjectAnalytics(workspaceId: string, projectId: string, dateRange: DateRange) {
  // Verify project belongs to workspace
  // Progress: done / total
  // Burndown: daily remaining issue count over the period
  // Scope changes: issues created after project.startDate (if set)
  // Status breakdown: groupBy status
  // Priority breakdown: groupBy priority
  // Member workload: issues per assignee within this project
  // Timeline health: compare completion rate vs days remaining to targetDate
}
```

**Burndown chart data:**

For each day in the range, count issues that existed and were not DONE:

```typescript
async function buildBurndown(workspaceId: string, projectId: string, from: Date, to: Date) {
  const days = getDaysBetween(from, to);
  const result = [];

  for (const day of days) {
    const remaining = await prisma.issue.count({
      where: {
        workspaceId,
        projectId,
        createdAt: { lte: day },
        OR: [
          { completedAt: null },
          { completedAt: { gt: day } },
        ],
      },
    });
    result.push({ date: day.toISOString().split("T")[0], remaining });
  }

  return result;
}
```

Note: For production at scale, consider materializing burndown data or using raw SQL with date series.

**Timeline health:**

```typescript
type TimelineHealth = "on_track" | "at_risk" | "behind";

function calculateTimelineHealth(
  totalIssues: number,
  completedIssues: number,
  startDate: Date | null,
  targetDate: Date | null,
): TimelineHealth {
  if (!targetDate) return "on_track"; // No deadline set

  const now = new Date();
  if (now > targetDate) return "behind";

  const totalDays = differenceInDays(targetDate, startDate ?? targetDate);
  const elapsedDays = differenceInDays(now, startDate ?? now);
  const timeProgress = totalDays > 0 ? elapsedDays / totalDays : 0;
  const issueProgress = totalIssues > 0 ? completedIssues / totalIssues : 0;

  // If issue progress is significantly behind time progress
  if (issueProgress < timeProgress * 0.7) return "behind";
  if (issueProgress < timeProgress * 0.9) return "at_risk";
  return "on_track";
}
```

### 6.3 Team Analytics

**Endpoint:** `GET /analytics/teams/:id`

**Queries:**

```typescript
export async function getTeamAnalytics(workspaceId: string, teamId: string, dateRange: DateRange) {
  // Verify team belongs to workspace
  // Team velocity: issues completed per week within period
  // Workload distribution: count of non-DONE issues per member
  // Completion rate per member: done / total per assignee
  // Avg resolution time per member
  // Overdue per member
  // Cycle-over-cycle: if team has completed cycles, compare completed issue counts
  // Member performance table
}
```

**Member performance table:**

```typescript
async function buildMemberPerformance(workspaceId: string, teamId: string, from: Date, to: Date) {
  const members = await prisma.teamMembership.findMany({
    where: { teamId },
    include: { user: { select: { id: true, name: true, email: true, avatar: true } } },
  });

  const result = await Promise.all(
    members.map(async (m) => {
      const [assigned, completed, open, overdue] = await Promise.all([
        prisma.issue.count({
          where: { workspaceId, teamId, assigneeId: m.userId },
        }),
        prisma.issue.count({
          where: { workspaceId, teamId, assigneeId: m.userId, status: "DONE", completedAt: { gte: from, lte: to } },
        }),
        prisma.issue.count({
          where: { workspaceId, teamId, assigneeId: m.userId, status: { not: "DONE" } },
        }),
        prisma.issue.count({
          where: { workspaceId, teamId, assigneeId: m.userId, status: { not: "DONE" }, dueDate: { lt: new Date() } },
        }),
      ]);

      return {
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        avatar: m.user.avatar,
        role: m.role,
        assigned,
        completed,
        open,
        overdue,
        completionRate: assigned > 0 ? Math.round((completed / assigned) * 100) : 0,
      };
    }),
  );

  return result;
}
```

### 6.4 Member Analytics

**Endpoint:** `GET /analytics/members/:id`

**Queries:**

```typescript
export async function getMemberAnalytics(workspaceId: string, memberId: string, dateRange: DateRange) {
  // Summary: assigned, completed, in progress, overdue
  // Completion rate + trend vs previous period
  // Avg resolution time + trend
  // Activity heatmap: count activities per day (from Activity model)
  // Breakdown by project: issues per project
  // Breakdown by team: issues per team
  // Recent activity: last 20 Activity entries by this actor
}
```

**Activity heatmap:**

```typescript
async function buildActivityHeatmap(workspaceId: string, actorId: string, from: Date, to: Date) {
  const activities = await prisma.activity.groupBy({
    by: ["createdAt"],
    where: {
      workspaceId,
      actorId,
      createdAt: { gte: from, lte: to },
    },
    _count: true,
  });

  // Group by date (strip time)
  const heatmap: Record<string, number> = {};
  for (const a of activities) {
    const date = a.createdAt.toISOString().split("T")[0];
    heatmap[date] = (heatmap[date] ?? 0) + a._count;
  }

  return Object.entries(heatmap).map(([date, count]) => ({ date, count }));
}
```

Note: `groupBy` on `createdAt` groups by exact timestamp. For daily grouping, use raw SQL:

```sql
SELECT DATE("createdAt") as date, COUNT(*) as count
FROM "Activity"
WHERE "workspaceId" = $1 AND "actorId" = $2 AND "createdAt" >= $3 AND "createdAt" <= $4
GROUP BY DATE("createdAt")
ORDER BY date
```

### 6.5 Cycle Analytics

**Endpoint:** `GET /analytics/cycles/:id`

Extends the existing cycle stats (from `cycle.service.ts`) with:

```typescript
{
  // Existing stats
  totalIssues, completedIssues, inProgressIssues, todoIssues, backlogIssues, reviewIssues,
  progress, daysTotal, daysElapsed, daysRemaining,

  // New analytics
  burndown: { date: string; remaining: number }[];
  velocityPerDay: { date: string; completed: number }[];
  issuesByAssignee: { userId: string; name: string; total: number; completed: number }[];
  carryOverCount: number; // Issues from previous cycle
  scopeChanges: number;   // Issues added after cycle start
  avgResolutionHours: number;
}
```

---

## 7. Bottleneck Detection

Issues stuck longest in `IN_PROGRESS` or `REVIEW`:

```typescript
async function buildBottlenecks(workspaceId: string, limit = 10) {
  // Find issues in IN_PROGRESS or REVIEW, ordered by updatedAt ascending (oldest = most stuck)
  const stuck = await prisma.issue.findMany({
    where: {
      workspaceId,
      status: { in: ["IN_PROGRESS", "REVIEW"] },
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: {
      id: true,
      title: true,
      status: true,
      updatedAt: true,
      assignee: { select: { id: true, name: true } },
    },
  });

  return stuck.map((issue) => ({
    issueId: issue.id,
    title: issue.title,
    status: issue.status,
    stuckDays: Math.floor((Date.now() - issue.updatedAt.getTime()) / (1000 * 60 * 60 * 24)),
    assignee: issue.assignee,
  }));
}
```

---

## 8. Daily Velocity Chart

```typescript
async function buildDailyVelocity(workspaceId: string, from: Date, to: Date) {
  // Raw SQL for date-grouped aggregation
  const completed = await prisma.$queryRaw<{ date: string; count: bigint }[]>`
    SELECT DATE("completedAt") as date, COUNT(*) as count
    FROM "Issue"
    WHERE "workspaceId" = ${workspaceId}
      AND "completedAt" >= ${from}
      AND "completedAt" <= ${to}
    GROUP BY DATE("completedAt")
    ORDER BY date
  `;

  const created = await prisma.$queryRaw<{ date: string; count: bigint }[]>`
    SELECT DATE("createdAt") as date, COUNT(*) as count
    FROM "Issue"
    WHERE "workspaceId" = ${workspaceId}
      AND "createdAt" >= ${from}
      AND "createdAt" <= ${to}
    GROUP BY DATE("createdAt")
    ORDER BY date
  `;

  // Merge into a single array with all dates in range
  const days = getDaysBetween(from, to);
  const completedMap = new Map(completed.map((r) => [r.date, Number(r.count)]));
  const createdMap = new Map(created.map((r) => [r.date, Number(r.count)]));

  return days.map((day) => {
    const dateStr = day.toISOString().split("T")[0];
    return {
      date: dateStr,
      completed: completedMap.get(dateStr) ?? 0,
      created: createdMap.get(dateStr) ?? 0,
    };
  });
}
```

---

## 9. Export Endpoint

```typescript
export async function exportAnalytics(
  workspaceId: string,
  scope: string,
  scopeId: string | undefined,
  format: "csv" | "json" | "pdf",
  dateRange: DateRange,
) {
  let data: any;

  switch (scope) {
    case "workspace":
      data = await getWorkspaceAnalytics(workspaceId, dateRange);
      break;
    case "project":
      data = await getProjectAnalytics(workspaceId, scopeId!, dateRange);
      break;
    case "team":
      data = await getTeamAnalytics(workspaceId, scopeId!, dateRange);
      break;
    case "member":
      data = await getMemberAnalytics(workspaceId, scopeId!, dateRange);
      break;
    case "cycle":
      data = await getCycleAnalytics(workspaceId, scopeId!, dateRange);
      break;
  }

  if (format === "json") {
    return { contentType: "application/json", body: JSON.stringify(data, null, 2) };
  }

  if (format === "pdf") {
    return { contentType: "application/pdf", body: renderAnalyticsPdf(data) };
  }

  // CSV: flatten the summary and tables into rows
  const csv = convertToCSV(data);
  return { contentType: "text/csv", body: csv };
}
```

The controller should set `Content-Disposition` with a file name matching the selected format, for example:
- `analytics-export.csv`
- `analytics-export.json`
- `analytics-export.pdf`

---

## 10. Access Control Rules

### Workspace Analytics
- OWNER, ADMIN: Full access
- MEMBER: Can view, but team performance table only shows teams they belong to
- GUEST: No access (403)

### Project Analytics
- OWNER, ADMIN: Full access to any project
- MEMBER: Only projects they are a member of (or public projects)
- GUEST: No access

### Team Analytics
- OWNER, ADMIN: Full access to any team
- MEMBER: Only teams they are a member of
- GUEST: No access

### Member Analytics
- OWNER, ADMIN: Can view any member's analytics
- MEMBER: Can only view their own analytics
- GUEST: No access

### Export
- OWNER, ADMIN: Can export any scope
- MEMBER: Can export own member analytics and teams/projects/cycles they can already view
- GUEST: No access

Implementation: Add access checks at the start of each service function. For MEMBER role, verify membership in the target entity before returning data.

---

## 11. Performance Considerations

### Indexes Required

```prisma
@@index([workspaceId, completedAt])        // Completion queries
@@index([workspaceId, status])             // Already exists
@@index([workspaceId, assigneeId])         // Already exists
@@index([workspaceId, teamId, status])     // Team analytics
@@index([workspaceId, projectId, status])  // Project analytics
```

### Query Optimization

- Use `Promise.all()` for independent queries (already shown above)
- Use `groupBy` instead of fetching all records and counting in JS
- Use raw SQL for date-grouped aggregations (Prisma `groupBy` doesn't support date functions)
- For burndown charts at scale, consider materializing daily snapshots instead of computing retroactively

### Caching (optional, later)

Analytics data changes slowly. Consider caching responses for 1-5 minutes using:
- In-memory cache (Map with TTL) for single-server deployments
- Redis for multi-server deployments

Cache key format: `analytics:{scope}:{scopeId}:{period}:{from}:{to}`

Invalidation: not critical for analytics — stale data for 1-5 min is acceptable.

---

## 12. Frontend Integration Contract

### Response Envelope

All analytics endpoints return:

```json
{
  "success": true,
  "data": {
    "period": { "from": "2026-05-04", "to": "2026-06-04", "label": "Last 30 days" },
    "summary": { ... },
    "charts": { ... },
    "tables": { ... }
  }
}
```

### Period Selector

Frontend should render a period selector with options:
- Last 7 days (`?period=7d`)
- Last 30 days (`?period=30d`)
- Last 90 days (`?period=90d`)
- Custom range (`?period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`)

### Trend Indicators

Summary cards include `trend` (percentage) and `direction` ("up" / "down" / "flat"). Frontend should render:
- Green up arrow for positive trends (completed, efficiency)
- Red down arrow for negative trends (overdue, stuck)
- Gray flat indicator for no change

### Charts

- Completion velocity: bar chart or line chart (daily or weekly)
- Issue distribution: donut/pie chart with status colors matching kanban board
- Burndown: line chart with ideal line overlay
- Activity heatmap: GitHub-style contribution grid

### Tables

- Team performance: sortable by completed, efficiency
- Top contributors: sortable by completed, resolution time
- Member performance: sortable by all columns
- Bottlenecks: sorted by stuck days descending

### Export Button

Visible on all analytics pages. Triggers `GET /analytics/export?scope=...&format=csv|json|pdf`. Frontend should trigger a file download.

---

## 13. Implementation Order

1. Add `completedAt` field to Issue model + migration + backfill
2. Update issue service to set/clear `completedAt` on status change
3. Create `analytics.utils.ts` with date range resolver and trend calculator
4. Create `analytics.schemas.ts` with query and param schemas
5. Implement `getWorkspaceAnalytics` (most complex — validates the approach)
6. Implement `getTeamAnalytics` with member performance table
7. Implement `getMemberAnalytics` with activity heatmap
8. Implement `getProjectAnalytics` with burndown and timeline health
9. Implement `getCycleAnalytics` extending existing cycle stats
10. Implement export endpoint
11. Wire routes and register in app
12. Add access control checks
13. Add indexes for performance
14. Test workspace isolation

---

## 14. Testing Matrix

| Scenario | Expected |
|---|---|
| Workspace analytics with no issues | All counts = 0, empty charts, no errors |
| Workspace analytics with mixed statuses | Correct counts per status |
| Trend calculation with zero previous | Direction = "up" if current > 0 |
| Trend calculation with zero current | Direction = "down" |
| Project burndown with no DONE issues | Flat line at total count |
| Team with no members | Empty member performance table |
| Member viewing other member's analytics | 403 Forbidden |
| GUEST accessing any analytics | 403 Forbidden |
| Cross-workspace access | 403 or 404 |
| Export as CSV | Valid CSV with headers and data rows |
| Export as JSON | Valid JSON matching analytics response shape |
| Custom date range with from > to | 422 Validation Error |
| Analytics with completedAt backfill | Existing DONE issues appear in historical data |
