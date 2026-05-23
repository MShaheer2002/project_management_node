# Dashboard Module — Integration Guide

## Architecture

The dashboard module is a read-only aggregate. It follows the standard backend flow:

```text
Route -> authenticate -> requireWorkspace -> Controller -> Service -> Prisma
```

The service performs only workspace-scoped queries. It does not trust client-provided user IDs; it uses `req.user.id` for user-specific sections like assigned issues and unread notifications.

## Returned Data

`GET /dashboard` returns:

- `workspace`: active workspace display data.
- `stats`: completed issues, active projects, team members, open issues, unread notifications.
- `charts.velocity`: last seven days of completed and opened issue counts.
- `charts.sprintProgress`: last seven days of open issue counts.
- `assignedToMe`: top open issues assigned to the authenticated user.
- `activeProjects`: latest active projects with issue progress.
- `upcomingDeadlines`: next open issues with due dates.
- `teamActivity`: recent workspace activity.

## Notes

There is no `completedAt` column yet, so completed chart data uses `Issue.updatedAt` for issues currently in `DONE`. If a future issue workflow adds completion timestamps, the dashboard chart should switch to that field.
