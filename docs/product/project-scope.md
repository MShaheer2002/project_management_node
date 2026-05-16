# Linearis — Product Scope Document

## 1. Product Overview

**Linearis** is a SaaS project management platform modeled after Linear. It provides issue tracking, project management, team collaboration, sprint cycles, and organizational hierarchy for software teams.

**Target users:** Engineering teams, product teams, and cross-functional organizations that need structured issue tracking with speed and keyboard-first UX.

**Product URL pattern:** `<workspace-slug>.linearis.app`

**Core philosophy:** Fast, opinionated, keyboard-driven. Issues are the atomic unit. Everything else (projects, cycles, teams, departments) organizes issues.

---

## 2. Authentication & Onboarding

### 2.1 Auth Methods

| Method        | Status   | Notes                                      |
|---------------|----------|--------------------------------------------|
| Email + Password | Current | Standard email/password with verification |
| Google OAuth  | Current  | "Continue with Google" button              |
| GitHub OAuth  | Current  | "Continue with GitHub" button              |
| SSO (SAML)   | Future   | Enterprise SSO for Plus plan               |

### 2.2 Auth Flow

```
1. User lands on /marketing (landing page)
2. Clicks "Sign up" → /signup
3. Enters: Full Name, Email, Password
   OR clicks Google/GitHub OAuth
4. → /email-verification (4-digit code sent to email)
5. Enters verification code
6. → /org-creation (first workspace setup)
7. Enters: Organization Name, Workspace URL slug
8. → / (dashboard — user is now workspace owner)
```

**Returning users:**
```
1. → /login
2. Enters Email + Password OR Google/GitHub OAuth
3. → / (dashboard)
```

**Password recovery:**
```
1. /login → clicks "Forgot password?"
2. → /forgot-password → enters email
3. Receives reset link via email
4. → /reset-password → enters new password + confirm
5. → /login
```

### 2.3 Session & Security
- JWT-based auth tokens (httpOnly cookies preferred)
- Refresh token rotation
- 2FA support (settings page, enable/disable)
- SSO configuration (future, Plus plan)
- Session timeout policy (configurable per workspace)

---

## 3. Workspace & Organization Model

### 3.1 Workspace (Organization)

A **workspace** is the top-level tenant boundary. All data is scoped to a workspace. One user can belong to multiple workspaces (switch via sidebar).

| Field         | Type     | Notes                                  |
|---------------|----------|----------------------------------------|
| `id`          | UUID     | Primary key                            |
| `name`        | string   | Display name (e.g., "Acme Corp")       |
| `slug`        | string   | Unique URL slug (e.g., "acme-corp")    |
| `logo`        | string?  | URL to workspace logo                  |
| `createdAt`   | datetime | Workspace creation timestamp           |
| `createdBy`   | UUID     | FK → User (becomes owner)              |

**Multi-tenancy:** All entities (issues, projects, teams, etc.) belong to exactly one workspace. API queries are always scoped to the authenticated user's active workspace.

### 3.2 Workspace Creation
- The user who creates a workspace automatically becomes the **owner**
- Workspace URL must be globally unique (`<slug>.linearis.app`)
- A workspace starts with zero departments, teams, and projects
- The owner can invite members immediately after creation

---

## 4. Roles & Permissions

### 4.1 Role Hierarchy

```
Owner (highest)
  └── Admin
       └── Member
            └── Guest (lowest)
```

| Role     | Description                                                | Limit per workspace |
|----------|------------------------------------------------------------|---------------------|
| `owner`  | Created the workspace. Full control. Cannot be demoted.    | Exactly 1           |
| `admin`  | Full management access. Can manage billing, API keys, templates, integrations. | Unlimited |
| `member` | Standard team member. Can create/edit issues, join teams, view analytics. | Unlimited |
| `guest`  | View-only with limited write access. Cannot see admin areas. | Unlimited |

### 4.2 Permission Matrix

| Action                        | Owner | Admin | Member | Guest |
|-------------------------------|-------|-------|--------|-------|
| **Workspace**                 |       |       |        |       |
| Edit workspace settings       | Yes   | Yes   | No     | No    |
| Delete workspace              | Yes   | No    | No     | No    |
| Manage billing/subscription   | Yes   | Yes   | No     | No    |
| Manage API keys               | Yes   | Yes   | No     | No    |
| Manage integrations           | Yes   | Yes   | Yes    | No    |
| View analytics/reports        | Yes   | Yes   | Yes    | No    |
| Manage templates              | Yes   | Yes   | No     | No    |
| **Members**                   |       |       |        |       |
| Invite members                | Yes   | Yes   | No     | No    |
| Remove members                | Yes   | Yes   | No     | No    |
| Change member roles           | Yes   | Yes   | No     | No    |
| View member directory         | Yes   | Yes   | Yes    | Yes   |
| **Departments**               |       |       |        |       |
| Create department             | Yes   | Yes   | No     | No    |
| Edit department settings      | Yes   | Yes   | Head   | No    |
| Delete department             | Yes   | Yes   | No     | No    |
| View departments              | Yes   | Yes   | Yes    | Public only |
| **Teams**                     |       |       |        |       |
| Create team                   | Yes   | Yes   | Yes    | No    |
| Edit team settings            | Yes   | Yes   | Lead   | No    |
| Delete team                   | Yes   | Yes   | No     | No    |
| Join/leave team               | Yes   | Yes   | Yes    | No    |
| **Projects**                  |       |       |        |       |
| Create project                | Yes   | Yes   | Yes    | No    |
| Edit project settings         | Yes   | Yes   | Lead   | No    |
| Archive/delete project        | Yes   | Yes   | Lead   | No    |
| View project                  | Yes   | Yes   | Yes    | Public only |
| **Issues**                    |       |       |        |       |
| Create issue                  | Yes   | Yes   | Yes    | No    |
| Edit any issue                | Yes   | Yes   | Yes    | No    |
| Delete any issue              | Yes   | Yes   | No     | No    |
| Change issue status           | Yes   | Yes   | Yes    | No    |
| Comment on issues             | Yes   | Yes   | Yes    | Yes   |
| **Cycles**                    |       |       |        |       |
| Create/edit/delete cycles     | Yes   | Yes   | Yes    | No    |
| View cycles                   | Yes   | Yes   | Yes    | Yes   |

**"Lead" and "Head" permissions:** A team lead can edit their own team's settings. A department head can edit their own department's settings. This is not a separate role — it's a contextual permission based on ownership.

### 4.3 Ownership Transfer
- Workspace ownership can be transferred to another admin (future feature)
- Team lead can be changed by admins
- Department head can be changed by admins

---

## 5. Core Data Model

### 5.1 Entity Relationships

```
Workspace (Organization)
├── Departments
│   ├── Teams
│   │   ├── Projects
│   │   │   └── Issues
│   │   │       ├── Subtasks
│   │   │       ├── Comments
│   │   │       └── Labels
│   │   ├── Cycles
│   │   └── Members (via membership)
│   └── Members (via membership)
├── Members (Users with workspace role)
├── Templates
├── Integrations
├── API Keys
├── Subscription/Billing
└── Activity Log
```

### 5.2 Entity Definitions

#### User
A person with an account. Exists independently of workspaces.

| Field          | Type       | Notes                                    |
|----------------|------------|------------------------------------------|
| `id`           | UUID       | Primary key                              |
| `name`         | string     | Display name                             |
| `email`        | string     | Unique, used for auth                    |
| `avatar`       | string?    | URL to profile picture                   |
| `passwordHash` | string?    | Null if OAuth-only                       |
| `authProvider`  | enum      | `email`, `google`, `github`              |
| `authProviderId`| string?   | External provider user ID                |
| `emailVerified`| boolean    | Must be true to use the app              |
| `twoFactorEnabled` | boolean | 2FA status                           |
| `createdAt`    | datetime   |                                          |
| `lastActiveAt` | datetime   | Last activity timestamp                  |

#### WorkspaceMembership (join table)
Links users to workspaces with their role.

| Field          | Type       | Notes                                    |
|----------------|------------|------------------------------------------|
| `id`           | UUID       | Primary key                              |
| `userId`       | UUID       | FK → User                                |
| `workspaceId`  | UUID       | FK → Workspace                           |
| `role`         | enum       | `owner`, `admin`, `member`, `guest`      |
| `joinedAt`     | datetime   |                                          |

#### Department

| Field          | Type       | Notes                                    |
|----------------|------------|------------------------------------------|
| `id`           | UUID       | Primary key                              |
| `workspaceId`  | UUID       | FK → Workspace                           |
| `name`         | string     |                                          |
| `description`  | string?    |                                          |
| `headId`       | UUID?      | FK → User (department head)              |
| `color`        | string?    | Hex color for UI                         |
| `icon`         | string?    | Icon identifier                          |
| `visibility`   | enum       | `public`, `private`                      |
| `isDefault`    | boolean    | New members auto-join this dept          |
| `createdAt`    | datetime   |                                          |

#### Team

| Field          | Type       | Notes                                    |
|----------------|------------|------------------------------------------|
| `id`           | UUID       | Primary key                              |
| `workspaceId`  | UUID       | FK → Workspace                           |
| `departmentId` | UUID?      | FK → Department (optional)               |
| `name`         | string     |                                          |
| `leadId`       | UUID       | FK → User (team lead)                    |
| `createdAt`    | datetime   |                                          |

#### TeamMembership (join table)

| Field          | Type       | Notes                                    |
|----------------|------------|------------------------------------------|
| `userId`       | UUID       | FK → User                                |
| `teamId`       | UUID       | FK → Team                                |
| `joinedAt`     | datetime   |                                          |

#### DepartmentMembership (join table)

| Field          | Type       | Notes                                    |
|----------------|------------|------------------------------------------|
| `userId`       | UUID       | FK → User                                |
| `departmentId` | UUID       | FK → Department                          |
| `joinedAt`     | datetime   |                                          |

#### Project

| Field          | Type       | Notes                                    |
|----------------|------------|------------------------------------------|
| `id`           | UUID       | Primary key                              |
| `workspaceId`  | UUID       | FK → Workspace                           |
| `teamId`       | UUID       | FK → Team                                |
| `departmentId` | UUID?      | FK → Department (derived from team)      |
| `name`         | string     |                                          |
| `description`  | string?    |                                          |
| `leadId`       | UUID?      | FK → User (project lead)                 |
| `status`       | enum       | `active`, `archived`, `completed`        |
| `visibility`   | enum       | `public`, `private`                      |
| `createdAt`    | datetime   |                                          |
| `updatedAt`    | datetime   |                                          |

#### Issue
The core entity of the system.

| Field               | Type       | Notes                                |
|---------------------|------------|--------------------------------------|
| `id`                | string     | Human-readable (e.g., `LIN-101`)     |
| `workspaceId`       | UUID       | FK → Workspace                       |
| `projectId`         | UUID       | FK → Project                         |
| `teamId`            | UUID       | FK → Team                            |
| `departmentId`      | UUID?      | FK → Department                      |
| `title`             | string     | Required                             |
| `description`       | text       | Rich text (HTML/Markdown)            |
| `type`              | enum       | `task`, `bug`, `issue`               |
| `status`            | enum       | `backlog`, `todo`, `in-progress`, `review`, `done` |
| `priority`          | enum       | `low`, `medium`, `high`, `urgent`    |
| `assigneeId`        | UUID?      | FK → User                            |
| `creatorId`         | UUID       | FK → User                            |
| `dueDate`           | date?      |                                      |
| `dueTime`           | time?      |                                      |
| `estimate`          | integer?   | Story points / complexity            |
| `cycleId`           | UUID?      | FK → Cycle (optional)                |
| `createdAt`         | datetime   |                                      |
| `updatedAt`         | datetime   |                                      |

**Bug-specific fields** (stored on Issue, populated when `type = 'bug'`):

| Field              | Type     | Notes                  |
|--------------------|----------|------------------------|
| `stepsToReproduce` | text?    |                        |
| `expectedBehavior` | text?    |                        |
| `actualBehavior`   | text?    |                        |
| `severity`         | enum?    | `low`, `medium`, `high`|

**Feature/Issue-specific fields** (stored on Issue, populated when `type = 'issue'`):

| Field                | Type     | Notes                  |
|----------------------|----------|------------------------|
| `acceptanceCriteria` | text?    |                        |
| `notes`              | text?    |                        |

#### IssueSubtask

| Field       | Type     | Notes                          |
|-------------|----------|--------------------------------|
| `id`        | UUID     | Primary key                    |
| `issueId`   | string   | FK → Issue                     |
| `title`     | string   |                                |
| `completed` | boolean  | Default: false                 |
| `order`     | integer  | Sort position (drag-and-drop)  |
| `createdAt` | datetime |                                |

#### IssueLabel (join table)

| Field    | Type   | Notes          |
|----------|--------|----------------|
| `issueId`| string | FK → Issue     |
| `labelId`| UUID   | FK → Label     |

#### Label

| Field         | Type     | Notes                       |
|---------------|----------|-----------------------------|
| `id`          | UUID     | Primary key                 |
| `workspaceId` | UUID     | FK → Workspace              |
| `name`        | string   | e.g., "bug", "frontend"     |
| `color`       | string   | Hex color                   |

#### IssueRelation (future, for related issues)

| Field       | Type   | Notes                              |
|-------------|--------|------------------------------------|
| `issueId`   | string | FK → Issue                         |
| `relatedId` | string | FK → Issue                         |
| `type`      | enum   | `related`, `blocks`, `blocked_by`, `duplicate` |

#### Comment

| Field      | Type     | Notes                             |
|------------|----------|-----------------------------------|
| `id`       | UUID     | Primary key                       |
| `issueId`  | string   | FK → Issue                        |
| `authorId` | UUID     | FK → User                         |
| `body`     | text     | Rich text                         |
| `parentId` | UUID?    | FK → Comment (for threaded replies)|
| `createdAt`| datetime |                                   |
| `updatedAt`| datetime |                                   |

#### Cycle (Sprint)

| Field         | Type     | Notes                           |
|---------------|----------|---------------------------------|
| `id`          | UUID     | Primary key                     |
| `workspaceId` | UUID     | FK → Workspace                  |
| `teamId`      | UUID?    | FK → Team (optional scope)      |
| `name`        | string   | e.g., "Cycle 12"                |
| `startDate`   | date     |                                 |
| `endDate`     | date     |                                 |
| `status`      | enum     | `upcoming`, `current`, `completed` |
| `createdAt`   | datetime |                                 |

#### Notification

| Field         | Type     | Notes                            |
|---------------|----------|----------------------------------|
| `id`          | UUID     | Primary key                      |
| `workspaceId` | UUID     | FK → Workspace                   |
| `userId`      | UUID     | FK → User (recipient)            |
| `actorId`     | UUID     | FK → User (who triggered it)     |
| `type`        | enum     | `mention`, `assignment`, `update`|
| `issueId`     | string?  | FK → Issue                       |
| `description` | string   | Human-readable summary           |
| `read`        | boolean  | Default: false                   |
| `createdAt`   | datetime |                                  |

#### Activity

| Field         | Type     | Notes                            |
|---------------|----------|----------------------------------|
| `id`          | UUID     | Primary key                      |
| `workspaceId` | UUID     | FK → Workspace                   |
| `actorId`     | UUID     | FK → User                        |
| `type`        | enum     | `issue_created`, `issue_completed`, `comment_added`, `member_joined`, `status_changed`, `assignment_changed` |
| `targetId`    | string   | ID of the affected entity        |
| `targetType`  | enum     | `issue`, `project`, `team`, `department` |
| `description` | string   | Human-readable summary           |
| `metadata`    | jsonb?   | Extra context (old/new values)   |
| `createdAt`   | datetime |                                  |

#### Template

| Field           | Type     | Notes                          |
|-----------------|----------|--------------------------------|
| `id`            | UUID     | Primary key                    |
| `workspaceId`   | UUID     | FK → Workspace                 |
| `name`          | string   |                                |
| `description`   | string?  |                                |
| `content`       | text     | Rich text template body        |
| `defaultPriority` | enum?  | Pre-filled priority            |
| `defaultAssignee` | enum   | `unassigned`, `creator`, or UUID |
| `defaultLabels` | string[] | Array of label IDs             |
| `checklistItems`| jsonb    | Default subtask titles         |
| `createdBy`     | UUID     | FK → User                      |
| `createdAt`     | datetime |                                |
| `updatedAt`     | datetime |                                |

#### Integration

| Field         | Type     | Notes                            |
|---------------|----------|----------------------------------|
| `id`          | UUID     | Primary key                      |
| `workspaceId` | UUID     | FK → Workspace                   |
| `provider`    | enum     | `github`, `slack`, `discord`, `figma` |
| `connected`   | boolean  |                                  |
| `config`      | jsonb?   | Provider-specific configuration  |
| `connectedAt` | datetime?|                                  |
| `connectedBy` | UUID?    | FK → User                        |

#### ApiKey

| Field         | Type     | Notes                            |
|---------------|----------|----------------------------------|
| `id`          | UUID     | Primary key                      |
| `workspaceId` | UUID     | FK → Workspace                   |
| `name`        | string   | Human-readable label             |
| `keyHash`     | string   | Hashed API key (never store raw) |
| `keyPrefix`   | string   | First 8 chars for identification |
| `createdBy`   | UUID     | FK → User                        |
| `createdAt`   | datetime |                                  |
| `lastUsedAt`  | datetime?|                                  |
| `expiresAt`   | datetime?| Optional expiration              |

---

## 6. Current Feature Scope

### 6.1 Dashboard
The home screen after login. Provides an at-a-glance overview.

**Displays:**
- 4 stat cards: Issues Completed, Active Projects, Team Members, Open Issues (with trend %)
- Velocity chart (bar): completed vs open issues per day
- Sprint progress chart (line): open issues trend
- "Assigned to me" list: top 5 issues with priority/status indicators
- Team activity feed: recent actions
- Active projects with progress bars
- Upcoming deadlines: issues due soon, with overdue/today/future labels

**Actions:** Navigate to issues, projects, create issue

### 6.2 Issues

The core of the product. Issues are the atomic work unit.

**Issue types:**
| Type    | Use case                           | Extra fields                             |
|---------|------------------------------------|------------------------------------------|
| `task`  | General work items                 | Standard fields only                     |
| `bug`   | Defects and problems               | Steps to reproduce, expected/actual behavior, severity |
| `issue` | Feature requests and enhancements  | Acceptance criteria, related issues, notes |

**Issue lifecycle:**
```
Backlog → Todo → In Progress → Review → Done
```

**Issue views:**
- **List view**: Sortable table with columns: priority, ID, title, type, status, assignee, due date
- **Kanban board**: 5 columns by status, drag-and-drop between columns (dnd-kit), cards show priority, title, type badge, subtask progress, assignee avatar
- **Calendar view**: Issues plotted on calendar by due date (placeholder)

**Issue detail page** (`/issues/:issueId`):
- Full issue view with editable fields
- Status, priority, assignee, due date dropdowns
- Label management (add/remove)
- Subtasks with drag-to-reorder, inline edit, completion tracking
- Comments with threaded replies
- Activity timeline (status changes, assignments, etc.)
- Delete issue action

**Issue creation** (`/issues/create`):
- Type selector (task/bug/issue) — changes visible fields
- Title, description (rich text editor)
- Project, priority, status, assignee, department dropdowns
- Due date + time picker
- Complexity estimate (points)
- Label selection (multi-select)
- Subtask builder (add/edit/delete/reorder)
- Auto-draft save to localStorage every 5 seconds
- Keyboard shortcuts: Cmd+Enter to submit, Esc to cancel

**My Issues** (`/issues/my`):
- Tabs: Assigned to Me, Created by Me, Completed
- List and board view modes
- Search and type filter

**Context panel** (right sidebar):
- Appears when clicking an issue from any list
- Shows full issue detail without leaving the current page
- Slide-in animation, 450px wide
- All the same edit capabilities as the detail page

### 6.3 Projects

Projects group related issues under a team.

**Project list** (`/projects`):
- Card grid: name, description, team, progress bar, issue count, last updated
- Filterable by team (via URL query param `?team=t1`)

**Project detail** (`/projects/:id`):
- **Overview tab**: Description, recent issues, progress, team members
- **Issues tab**: Full issue list filtered to project
- **Board tab**: Kanban board filtered to project
- **Roadmap tab**: Timeline view
- **Members tab**: Team members
- **Activity tab**: Project activity feed
- **Settings tab** (lead/admin):
  - General: name, description, lead, visibility (public/private)
  - Workflow: custom status management (add/edit/remove statuses)
  - Permissions: who can create/edit issues, manage settings
  - Danger zone: archive or permanently delete

### 6.4 Teams

Teams are groups of members that own projects.

**Team directory** (`/teams`):
- Card grid: team name, lead (with shield badge), member avatars, project count
- Create team modal

**Team detail** (`/teams/:id`):
- Tabs: Members, Projects, Issues, Activity
- Team-scoped views of issues and projects
- Sidebar navigation links directly to team-scoped pages (issues, projects, cycles, roadmap with `?team=` param)

### 6.5 Departments

Departments are organizational divisions that contain teams.

**Department list** (`/departments`):
- Grid and list view toggle
- Cards show: icon with color, name, description, stats (members/teams/projects), department head
- Search by name/description

**Department detail** (`/departments/:id`):
- **Overview tab**: 4 stat cards (resources, active projects, efficiency, resource load), velocity chart, workload distribution chart, key details
- **Members tab**: Table with avatar, name, email, online status, team, role
- **Teams tab**: Team cards grid
- **Projects tab**: Project cards grid
- **Activity tab**: Timeline
- **Settings tab** (admin/head only):
  - General: name, head, description
  - Visibility & access: public vs private
  - Visual identity: color picker, icon selector
  - Advanced: auto-membership toggle, default department toggle
  - Danger zone: archive or delete

### 6.6 Cycles (Sprints)

Time-boxed periods for tracking issue progress.

**Cycles page** (`/cycles`):
- Current cycle: highlighted card with progress bar, issue count, date range
- Upcoming cycles: list with dates
- Completed cycles: list with completion status
- Team-scoped filtering (via `?team=` param)
- Create cycle modal: name, start date, end date

### 6.7 Roadmap

Visual timeline of project progress.

**Roadmap page** (`/roadmap`):
- Gantt-chart style horizontal timeline
- Monthly/quarterly view toggle
- Projects as timeline bars with progress %
- Quarter/month navigation (prev/next)

### 6.8 Notifications (Inbox)

**Notification types:**
- `mention`: @mention in a comment
- `assignment`: Issue assigned to you
- `update`: Status/field change on an issue you're watching

**Inbox page** (`/inbox`):
- Tabs: All, Mentions, Assignments, Updates
- Each notification: actor avatar, description, issue ID, timestamp, read status
- Mark as read, archive actions
- Unread count badge in sidebar

### 6.9 Activity Feed

**Activity page** (`/activity`):
- Vertical timeline of all workspace actions
- Types: `issue_created`, `issue_completed`, `comment_added`, `member_joined`
- Each entry: actor avatar, name, action badge, description, timestamp
- Search and filter

### 6.10 Analytics & Reports

**Reports page** (`/analytics`, admin/member only):
- Stat cards: tasks completed, avg resolution time, active projects, team workload
- Velocity chart (bar): completed issues per day
- Issue distribution (pie/donut): breakdown by status
- Team performance table: team name, members, completed, efficiency %, progress bar
- Date range filter: 7 days / 30 days
- Export data button

### 6.11 Templates

**Templates page** (`/templates`, admin only):
- Template card grid: name, description, creator, last updated
- Create/edit template form:
  - Name, description
  - Rich text content body
  - Default metadata: priority, assignee (unassigned/creator/specific), labels, checklist items
- Delete template

### 6.12 Settings

**Settings page** (`/settings`):
- Appearance: theme selector (light/dark/system)
- Workspace profile: org name, workspace URL
- Security & access: 2FA toggle, SSO configuration (future)
- Danger zone: delete workspace

**Sub-pages (separate routes):**
- `/billing` — Subscription management (admin only)
- `/api-keys` — API key management (admin only)
- `/integrations` — Third-party connections (admin/member)

### 6.13 Billing & Subscription

**Billing page** (`/billing`, admin only):

**Plans:**

| Plan       | Price           | Key features                             |
|------------|-----------------|------------------------------------------|
| Free       | $0              | Up to 10 members, basic issue tracking   |
| Standard   | $12/user/month  | Unlimited members, all features          |
| Plus       | $24/user/month  | SSO, audit logs, advanced analytics, priority support |

**Billing features:**
- Current plan display with next billing date and amount
- Upgrade/downgrade/cancel actions
- Payment method management (card on file, add new)
- Billing email configuration
- Invoice history table: ID, date, amount, status (paid/unpaid), download PDF

### 6.14 Integrations

**Integrations page** (`/integrations`, admin/member):

| Integration | Description                        | Status    |
|-------------|------------------------------------|-----------|
| GitHub      | Sync pull requests and issues      | Supported |
| Slack       | Notifications in channels          | Supported |
| Discord     | Community server connection        | Supported |
| Figma       | Embed designs in issues            | Supported |

- Connect/disconnect toggle per integration
- Documentation link per integration
- "Request Integration" for unlisted services

### 6.15 API Keys

**API Keys page** (`/api-keys`, admin only):
- Generate new key (via modal: enter key name)
- Key list: name, created date, last used, masked key value
- Reveal/copy/delete actions
- Security best practices banner
- Key format: `lin_live_*` (production), `lin_test_*` (development)

### 6.16 Members Management

**Members page** (`/members`):
- Table: avatar, name, email, role badge, department, team
- Role badges: Owner (orange dot), Admin (shield), Member, Guest
- Filters: search, role filter, department filter
- Invite member modal
- Actions dropdown per member

### 6.17 Marketing / Landing Page

**Landing page** (`/marketing`):
- Navigation: Product, Features, Pricing, Customers, Login, Sign up
- Hero: tagline, CTA buttons (Get started free, Book demo)
- Features grid (6 items): speed, issue tracking, roadmaps, collaboration, security, workflows
- Pricing section: Free / Standard / Plus plans with feature comparison
- Footer: social links, product/company/legal link columns

---

## 7. UI Patterns

### 7.1 Navigation
- **Sidebar** (collapsible, 280px expanded):
  - Workspace switcher dropdown
  - Search / command palette trigger (Cmd+K)
  - Sections: Your Work, Browse, Your Teams (expandable), Organization
  - Role-based item visibility
  - Team-scoped navigation (issues, projects, cycles, roadmap per team)
  - Collapsed mode: icon-only with flyout panels on hover

- **Top navbar**: search bar, create issue button, notifications bell (with badge), user menu (profile, settings, theme, logout)

- **Command palette** (Cmd+K): quick jump to any page, issue, or action

### 7.2 Theming
- Three modes: Light, Dark, System (follows OS preference)
- Persisted in localStorage
- All components support both themes via Tailwind `dark:` variants

### 7.3 Context Panel
- Right-side slide-in panel (450px) for viewing/editing issues without leaving the current page
- Spring animation entry
- Full edit capabilities

### 7.4 Toasts
- Success (green), Error (red), Info (blue)
- Auto-dismiss after 3 seconds
- Stacked bottom-right

### 7.5 Modals
- Overlay with backdrop blur
- Used for: create project, create team, create department, create cycle, invite member, generate API key, create issue (quick)
- Spring animation enter/exit

---

## 8. Future Scope

### 8.1 SSO (SAML/OIDC)
- Plus plan feature
- Configure via Settings → Security & Access
- Support SAML 2.0 and OpenID Connect
- Domain-based auto-join (e.g., all `@acme.com` emails auto-join workspace)
- Enforce SSO-only login for workspace

### 8.2 AI Assistant (MCP Server)
- **Guided chat bot**: in-app AI assistant that understands workspace context
- Natural language commands: "Create a bug for the login page crash", "Show me all urgent issues assigned to Sarah", "Move LIN-105 to In Progress"
- **MCP (Model Context Protocol) server**: exposes workspace data as tools for external AI agents
  - Tool: `list_issues(filters)` — query issues
  - Tool: `create_issue(data)` — create an issue
  - Tool: `update_issue(id, changes)` — modify an issue
  - Tool: `get_project_status(id)` — project summary
  - Tool: `assign_issue(id, userId)` — assign an issue
- AI-powered suggestions: auto-assign based on expertise, duplicate detection, smart labeling
- Sprint planning assistant: suggest issues for next cycle based on velocity and capacity

### 8.3 Real-time Collaboration
- WebSocket-based live updates
- Presence indicators (who's viewing which issue)
- Real-time comment updates
- Live kanban board sync across users

### 8.4 Advanced Analytics
- Custom report builder
- Burndown/burnup charts per cycle
- Individual contributor metrics
- SLA tracking and alerts
- Export to CSV/PDF

### 8.5 Audit Log (Plus plan)
- Immutable log of all workspace actions
- Filterable by actor, action type, date range
- Required for enterprise compliance

### 8.6 Webhooks
- HTTP callbacks on workspace events
- Configurable per event type (issue created, status changed, etc.)
- Retry logic with exponential backoff

### 8.7 Email Notifications
- Configurable notification preferences per user
- Digest mode: daily/weekly summary email
- Instant notification for mentions and assignments

### 8.8 Mobile App
- React Native or progressive web app
- Core features: issue list, kanban, notifications, quick create

---

## 9. Technical Requirements for Backend

### 9.1 API Design
- RESTful API (or GraphQL, team's choice)
- All endpoints scoped to workspace via auth token
- Pagination on list endpoints (cursor-based preferred)
- Consistent error response format
- Rate limiting per API key and per user

### 9.2 Multi-tenancy
- All queries MUST be scoped to `workspaceId`
- Row-level security or middleware-enforced tenant isolation
- Workspace slug uniqueness enforced at DB level

### 9.3 Real-time
- WebSocket or SSE for live updates (notifications, issue changes, presence)
- Event bus for internal pub/sub (issue_updated, comment_created, etc.)

### 9.4 File Storage
- Avatar uploads (user, workspace logo)
- Comment attachments (future)
- Issue attachments (future)
- CDN-backed storage (S3/R2/GCS)

### 9.5 Search
- Full-text search across issues (title, description, comments)
- Faceted search (by status, priority, assignee, labels, type)
- Command palette search (issues, projects, teams, members)

### 9.6 Background Jobs
- Email sending (verification, password reset, notifications)
- Webhook delivery
- Analytics aggregation
- Cycle auto-completion (when end date passes)

### 9.7 Observability
- Structured logging
- Request tracing
- Error reporting (Sentry or equivalent)
- Performance monitoring

---

## 10. Subscription & Billing Model

### 10.1 Plans

| Feature                    | Free   | Standard ($12/user/mo) | Plus ($24/user/mo) |
|----------------------------|--------|------------------------|--------------------|
| Members                    | 10 max | Unlimited              | Unlimited          |
| Issues                     | Unlimited | Unlimited           | Unlimited          |
| Projects                   | 5 max  | Unlimited              | Unlimited          |
| Departments                | 1 max  | Unlimited              | Unlimited          |
| Storage                    | 1 GB   | 10 GB                  | 100 GB             |
| Issue types (task/bug/issue)| Yes   | Yes                    | Yes                |
| Kanban board               | Yes    | Yes                    | Yes                |
| Cycles                     | Yes    | Yes                    | Yes                |
| Roadmap                    | Yes    | Yes                    | Yes                |
| Templates                  | No     | Yes                    | Yes                |
| Analytics & reports        | Basic  | Full                   | Advanced           |
| Integrations               | 2 max  | Unlimited              | Unlimited          |
| API access                 | No     | Yes                    | Yes                |
| SSO (SAML/OIDC)           | No     | No                     | Yes                |
| Audit log                  | No     | No                     | Yes                |
| Priority support           | No     | No                     | Yes                |
| AI assistant               | No     | Basic                  | Full               |
| Custom fields (future)     | No     | No                     | Yes                |

### 10.2 Billing Entities

#### Subscription

| Field            | Type     | Notes                         |
|------------------|----------|-------------------------------|
| `id`             | UUID     | Primary key                   |
| `workspaceId`    | UUID     | FK → Workspace                |
| `plan`           | enum     | `free`, `standard`, `plus`    |
| `status`         | enum     | `active`, `canceled`, `past_due`, `trialing` |
| `billingCycle`   | enum     | `monthly`, `annual`           |
| `currentPeriodStart` | datetime |                           |
| `currentPeriodEnd`   | datetime |                           |
| `cancelAtPeriodEnd`  | boolean |                            |
| `stripeCustomerId`   | string? | Stripe integration          |
| `stripeSubscriptionId` | string? | Stripe integration       |

#### Invoice

| Field          | Type     | Notes                          |
|----------------|----------|--------------------------------|
| `id`           | UUID     | Primary key                    |
| `workspaceId`  | UUID     | FK → Workspace                 |
| `subscriptionId`| UUID    | FK → Subscription              |
| `invoiceNumber`| string   | e.g., "INV-001"                |
| `amount`       | integer  | In cents                       |
| `currency`     | string   | e.g., "usd"                    |
| `status`       | enum     | `paid`, `unpaid`, `void`       |
| `pdfUrl`       | string?  | Link to downloadable invoice   |
| `issuedAt`     | datetime |                                |
| `paidAt`       | datetime?|                                |

#### PaymentMethod

| Field          | Type     | Notes                          |
|----------------|----------|--------------------------------|
| `id`           | UUID     | Primary key                    |
| `workspaceId`  | UUID     | FK → Workspace                 |
| `type`         | enum     | `card`, `bank_transfer`        |
| `last4`        | string   | Last 4 digits                  |
| `brand`        | string?  | e.g., "visa", "mastercard"     |
| `expiryMonth`  | integer  |                                |
| `expiryYear`   | integer  |                                |
| `isDefault`    | boolean  |                                |
| `stripePaymentMethodId` | string? | Stripe integration    |

### 10.3 Usage Tracking
Track per-workspace for plan enforcement:
- Member count (against plan limit)
- Project count (against plan limit)
- Storage used (against plan limit)
- Integration count (against plan limit)
- API request count (for rate limiting)

---

## 11. Issue ID System

Issues use a human-readable sequential ID format: `<PREFIX>-<NUMBER>`

- Default prefix: `LIN` (configurable per workspace in future)
- Sequential within workspace: LIN-1, LIN-2, ... LIN-101
- Never reused — deleted issue IDs are permanently consumed
- Must be unique within workspace

Backend must maintain an atomic counter per workspace to generate issue IDs without collisions under concurrent requests.
