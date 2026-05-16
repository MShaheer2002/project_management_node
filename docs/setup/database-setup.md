# Linearis — Database Setup & Schema Design

## 1. Overview

This document defines the PostgreSQL database setup, Prisma schema design, relations, indexing strategy, and conventions for the Linearis backend. All models are derived from the [Product Scope Document](../product/project-scope.md).

**Stack:**
- **Database:** PostgreSQL 16+
- **ORM:** Prisma 7 (with `prisma-client` generator)
- **Auth:** Clerk (handles signup, login, OAuth, email verification, 2FA, SSO)
- **Migrations:** Prisma Migrate (via `prisma.config.ts`)
- **Connection:** `DATABASE_URL` from `.env`

### Auth Strategy — Clerk

Clerk is the **sole authentication provider**. It manages:
- Email + password signup/login
- Google & GitHub OAuth
- Email verification
- 2FA (TOTP)
- SSO/SAML (future, Plus plan)
- Session management (JWTs issued by Clerk)

**How it integrates with our DB:**
1. Clerk owns the user identity. Our `User` model stores a `clerkId` (Clerk's `user_id`) as the primary key — no passwords, OAuth tokens, or email verification flags in our DB.
2. On first login, a Clerk webhook (`user.created`) fires → we create a `User` row with the Clerk-provided profile data (name, email, avatar).
3. On profile updates, a Clerk webhook (`user.updated`) fires → we sync the changed fields.
4. Auth middleware uses `@clerk/express` to verify the session JWT on every request and injects `userId` (clerkId) into the request context.
5. Our DB is purely for **application data** — Clerk handles all auth state.

---

## 2. Database Conventions

### 2.1 Naming

| Element       | Convention                  | Example                      |
|---------------|-----------------------------|------------------------------|
| Tables        | PascalCase (Prisma models)  | `User`, `WorkspaceMembership`|
| Columns       | camelCase                   | `createdAt`, `workspaceId`   |
| Enums         | PascalCase                  | `WorkspaceRole`, `IssueStatus`|
| Enum values   | SCREAMING_SNAKE_CASE        | `IN_PROGRESS`, `PAST_DUE`   |
| Foreign keys  | `<entity>Id`                | `userId`, `teamId`           |
| Join tables   | `<EntityA><EntityB>`        | `IssueLabel`, `TeamMembership`|
| Indexes       | Auto-named by Prisma        | `@@index([workspaceId])`     |

### 2.2 Common Field Patterns

Every table includes:

| Field       | Type       | Notes                            |
|-------------|------------|----------------------------------|
| `id`        | `String`   | UUID v4, `@default(uuid())`      |
| `createdAt` | `DateTime` | `@default(now())`                |
| `updatedAt` | `DateTime` | `@updatedAt`                     |

**Exceptions:**
- `Issue` uses a human-readable ID (`LIN-101`) as primary key alongside an internal UUID
- Join tables (`IssueLabel`, `TeamMembership`, `DepartmentMembership`) use composite keys instead of a UUID `id`

### 2.3 Soft Deletes vs Hard Deletes

- **Hard delete:** Comments, Subtasks, Labels, Notifications (low-value, no audit trail needed)
- **Soft delete (future):** Issues, Projects — if audit log feature is implemented on Plus plan, these would use a `deletedAt` nullable datetime. For now, we hard delete.

### 2.4 Multi-Tenancy

Every workspace-scoped entity has a `workspaceId` foreign key. **All queries must be scoped to the authenticated user's active workspace.** This is enforced at the middleware/service layer, not at the database level.

---

## 3. Enums

```prisma
// Note: No AuthProvider enum — Clerk manages all auth providers externally

enum WorkspaceRole {
  OWNER
  ADMIN
  MEMBER
  GUEST
}

enum Visibility {
  PUBLIC
  PRIVATE
}

enum IssueType {
  TASK
  BUG
  ISSUE
}

enum IssueStatus {
  BACKLOG
  TODO
  IN_PROGRESS
  REVIEW
  DONE
}

enum IssuePriority {
  LOW
  MEDIUM
  HIGH
  URGENT
}

enum BugSeverity {
  LOW
  MEDIUM
  HIGH
}

enum ProjectStatus {
  ACTIVE
  ARCHIVED
  COMPLETED
}

enum CycleStatus {
  UPCOMING
  CURRENT
  COMPLETED
}

enum NotificationType {
  MENTION
  ASSIGNMENT
  UPDATE
}

enum ActivityType {
  ISSUE_CREATED
  ISSUE_COMPLETED
  COMMENT_ADDED
  MEMBER_JOINED
  STATUS_CHANGED
  ASSIGNMENT_CHANGED
}

enum ActivityTargetType {
  ISSUE
  PROJECT
  TEAM
  DEPARTMENT
}

enum IssueRelationType {
  RELATED
  BLOCKS
  BLOCKED_BY
  DUPLICATE
}

enum SubscriptionPlan {
  FREE
  STANDARD
  PLUS
}

enum SubscriptionStatus {
  ACTIVE
  CANCELED
  PAST_DUE
  TRIALING
}

enum BillingCycle {
  MONTHLY
  ANNUAL
}

enum InvoiceStatus {
  PAID
  UNPAID
  VOID
}

enum PaymentMethodType {
  CARD
  BANK_TRANSFER
}

enum IntegrationProvider {
  GITHUB
  SLACK
  DISCORD
  FIGMA
}
```

---

## 4. Models & Relations

### 4.1 Entity Relationship Diagram (Conceptual)

```
User ──< WorkspaceMembership >── Workspace
User ──< TeamMembership >── Team
User ──< DepartmentMembership >── Department

Workspace ──< Department
Workspace ──< Team
Workspace ──< Project
Workspace ──< Issue
Workspace ──< Label
Workspace ──< Cycle
Workspace ──< Notification
Workspace ──< Activity
Workspace ──< Template
Workspace ──< Integration
Workspace ──< ApiKey
Workspace ──< Subscription ──< Invoice
Workspace ──< PaymentMethod

Department ──< Team
Team ──< Project
Project ──< Issue

Issue ──< IssueSubtask
Issue ──< Comment
Issue ──< IssueLabel >── Label
Issue ──< IssueRelation
Issue >── Cycle (optional)
Comment ──< Comment (self-referential, threaded replies)
```

### 4.2 Model Definitions

#### User

Global entity — not scoped to a workspace. Synced from Clerk via webhooks.

Clerk is the source of truth for auth (passwords, OAuth, 2FA, sessions). Our `User` table only stores the profile data we need for relations and display.

```prisma
model User {
  id           String    @id              // Clerk user_id (e.g., "user_2x...")
  email        String    @unique
  name         String
  avatar       String?
  lastActiveAt DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  // Relations
  workspaceMemberships  WorkspaceMembership[]
  teamMemberships       TeamMembership[]
  departmentMemberships DepartmentMembership[]
  createdWorkspaces     Workspace[]       @relation("WorkspaceCreator")
  ledTeams              Team[]            @relation("TeamLead")
  headedDepartments     Department[]      @relation("DepartmentHead")
  ledProjects           Project[]         @relation("ProjectLead")
  assignedIssues        Issue[]           @relation("IssueAssignee")
  createdIssues         Issue[]           @relation("IssueCreator")
  comments              Comment[]
  notifications         Notification[]    @relation("NotificationRecipient")
  actedNotifications    Notification[]    @relation("NotificationActor")
  activities            Activity[]
  createdTemplates      Template[]
  createdApiKeys        ApiKey[]
  connectedIntegrations Integration[]

  @@index([email])
}
```

**Clerk webhook sync flow:**

| Clerk Event      | Action                                              |
|------------------|-----------------------------------------------------|
| `user.created`   | Insert `User` row with `id = clerk_user_id`         |
| `user.updated`   | Update `name`, `email`, `avatar` from Clerk payload |
| `user.deleted`   | Cascade delete user and all memberships              |

#### Workspace

Top-level tenant boundary.

```prisma
model Workspace {
  id          String   @id @default(uuid())
  name        String
  slug        String   @unique
  logo        String?
  createdById String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  // Relations
  createdBy     User                  @relation("WorkspaceCreator", fields: [createdById], references: [id])
  memberships   WorkspaceMembership[]
  departments   Department[]
  teams         Team[]
  projects      Project[]
  issues        Issue[]
  labels        Label[]
  cycles        Cycle[]
  notifications Notification[]
  activities    Activity[]
  templates     Template[]
  integrations  Integration[]
  apiKeys       ApiKey[]
  subscriptions Subscription[]
  invoices      Invoice[]
  paymentMethods PaymentMethod[]
  issueCounter  Int               @default(0) // atomic counter for issue IDs

  @@index([slug])
}
```

#### WorkspaceMembership

```prisma
model WorkspaceMembership {
  id          String        @id @default(uuid())
  userId      String
  workspaceId String
  role        WorkspaceRole @default(MEMBER)
  joinedAt    DateTime      @default(now())

  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([userId, workspaceId])
  @@index([workspaceId])
  @@index([userId])
}
```

#### Department

```prisma
model Department {
  id           String     @id @default(uuid())
  workspaceId  String
  name         String
  description  String?
  headId       String?
  color        String?
  icon         String?
  visibility   Visibility @default(PUBLIC)
  isDefault    Boolean    @default(false)
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt

  workspace   Workspace              @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  head        User?                  @relation("DepartmentHead", fields: [headId], references: [id], onDelete: SetNull)
  teams       Team[]
  memberships DepartmentMembership[]
  projects    Project[]
  issues      Issue[]

  @@unique([workspaceId, name])
  @@index([workspaceId])
}
```

#### DepartmentMembership

```prisma
model DepartmentMembership {
  userId       String
  departmentId String
  joinedAt     DateTime @default(now())

  user       User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  department Department @relation(fields: [departmentId], references: [id], onDelete: Cascade)

  @@id([userId, departmentId])
  @@index([departmentId])
}
```

#### Team

```prisma
model Team {
  id           String   @id @default(uuid())
  workspaceId  String
  departmentId String?
  name         String
  leadId       String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  workspace   Workspace        @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  department  Department?      @relation(fields: [departmentId], references: [id], onDelete: SetNull)
  lead        User             @relation("TeamLead", fields: [leadId], references: [id])
  memberships TeamMembership[]
  projects    Project[]
  issues      Issue[]
  cycles      Cycle[]

  @@unique([workspaceId, name])
  @@index([workspaceId])
  @@index([departmentId])
}
```

#### TeamMembership

```prisma
model TeamMembership {
  userId   String
  teamId   String
  joinedAt DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@id([userId, teamId])
  @@index([teamId])
}
```

#### Project

```prisma
model Project {
  id           String        @id @default(uuid())
  workspaceId  String
  teamId       String
  departmentId String?
  name         String
  description  String?
  leadId       String?
  status       ProjectStatus @default(ACTIVE)
  visibility   Visibility    @default(PUBLIC)
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt

  workspace  Workspace   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  team       Team        @relation(fields: [teamId], references: [id], onDelete: Cascade)
  department Department? @relation(fields: [departmentId], references: [id], onDelete: SetNull)
  lead       User?       @relation("ProjectLead", fields: [leadId], references: [id], onDelete: SetNull)
  issues     Issue[]

  @@unique([workspaceId, name])
  @@index([workspaceId])
  @@index([teamId])
  @@index([departmentId])
  @@index([status])
}
```

#### Issue

The core entity. Uses a human-readable ID (`LIN-101`) alongside an internal UUID.

```prisma
model Issue {
  id           String        @id // Human-readable: "LIN-101"
  internalId   String        @unique @default(uuid())
  workspaceId  String
  projectId    String
  teamId       String
  departmentId String?
  title        String
  description  String?       @db.Text
  type         IssueType     @default(TASK)
  status       IssueStatus   @default(BACKLOG)
  priority     IssuePriority @default(MEDIUM)
  assigneeId   String?
  creatorId    String
  dueDate      DateTime?     @db.Date
  dueTime      DateTime?     @db.Time()
  estimate     Int?
  cycleId      String?
  number       Int           // Sequential number within workspace

  // Bug-specific fields (populated when type = BUG)
  stepsToReproduce String?   @db.Text
  expectedBehavior String?   @db.Text
  actualBehavior   String?   @db.Text
  severity         BugSeverity?

  // Issue/Feature-specific fields (populated when type = ISSUE)
  acceptanceCriteria String? @db.Text
  notes              String? @db.Text

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Relations
  workspace  Workspace   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  project    Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  team       Team        @relation(fields: [teamId], references: [id], onDelete: Cascade)
  department Department? @relation(fields: [departmentId], references: [id], onDelete: SetNull)
  assignee   User?       @relation("IssueAssignee", fields: [assigneeId], references: [id], onDelete: SetNull)
  creator    User        @relation("IssueCreator", fields: [creatorId], references: [id])
  cycle      Cycle?      @relation(fields: [cycleId], references: [id], onDelete: SetNull)
  subtasks   IssueSubtask[]
  comments   Comment[]
  labels     IssueLabel[]
  relationsFrom IssueRelation[] @relation("IssueRelationFrom")
  relationsTo   IssueRelation[] @relation("IssueRelationTo")

  @@unique([workspaceId, number])
  @@index([workspaceId])
  @@index([projectId])
  @@index([teamId])
  @@index([assigneeId])
  @@index([status])
  @@index([priority])
  @@index([cycleId])
  @@index([creatorId])
  @@index([workspaceId, status])
  @@index([workspaceId, assigneeId])
}
```

#### IssueSubtask

```prisma
model IssueSubtask {
  id        String   @id @default(uuid())
  issueId   String
  title     String
  completed Boolean  @default(false)
  order     Int
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  issue Issue @relation(fields: [issueId], references: [id], onDelete: Cascade)

  @@index([issueId])
}
```

#### Label

```prisma
model Label {
  id          String @id @default(uuid())
  workspaceId String
  name        String
  color       String

  workspace Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  issues    IssueLabel[]

  @@unique([workspaceId, name])
  @@index([workspaceId])
}
```

#### IssueLabel (Join Table)

```prisma
model IssueLabel {
  issueId String
  labelId String

  issue Issue @relation(fields: [issueId], references: [id], onDelete: Cascade)
  label Label @relation(fields: [labelId], references: [id], onDelete: Cascade)

  @@id([issueId, labelId])
  @@index([labelId])
}
```

#### IssueRelation

```prisma
model IssueRelation {
  id        String            @id @default(uuid())
  issueId   String
  relatedId String
  type      IssueRelationType

  issue   Issue @relation("IssueRelationFrom", fields: [issueId], references: [id], onDelete: Cascade)
  related Issue @relation("IssueRelationTo", fields: [relatedId], references: [id], onDelete: Cascade)

  @@unique([issueId, relatedId, type])
  @@index([issueId])
  @@index([relatedId])
}
```

#### Comment

Self-referential for threaded replies.

```prisma
model Comment {
  id        String   @id @default(uuid())
  issueId   String
  authorId  String
  body      String   @db.Text
  parentId  String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  issue    Issue     @relation(fields: [issueId], references: [id], onDelete: Cascade)
  author   User      @relation(fields: [authorId], references: [id])
  parent   Comment?  @relation("CommentThread", fields: [parentId], references: [id], onDelete: Cascade)
  replies  Comment[] @relation("CommentThread")

  @@index([issueId])
  @@index([parentId])
}
```

#### Cycle

```prisma
model Cycle {
  id          String      @id @default(uuid())
  workspaceId String
  teamId      String?
  name        String
  startDate   DateTime    @db.Date
  endDate     DateTime    @db.Date
  status      CycleStatus @default(UPCOMING)
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  team      Team?     @relation(fields: [teamId], references: [id], onDelete: SetNull)
  issues    Issue[]

  @@index([workspaceId])
  @@index([teamId])
  @@index([status])
}
```

#### Notification

```prisma
model Notification {
  id          String           @id @default(uuid())
  workspaceId String
  userId      String
  actorId     String
  type        NotificationType
  issueId     String?
  description String
  read        Boolean          @default(false)
  createdAt   DateTime         @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user      User      @relation("NotificationRecipient", fields: [userId], references: [id], onDelete: Cascade)
  actor     User      @relation("NotificationActor", fields: [actorId], references: [id])

  @@index([userId, read])
  @@index([workspaceId])
}
```

#### Activity

```prisma
model Activity {
  id          String             @id @default(uuid())
  workspaceId String
  actorId     String
  type        ActivityType
  targetId    String
  targetType  ActivityTargetType
  description String
  metadata    Json?
  createdAt   DateTime           @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  actor     User      @relation(fields: [actorId], references: [id])

  @@index([workspaceId])
  @@index([workspaceId, targetType])
  @@index([actorId])
  @@index([createdAt])
}
```

#### Template

```prisma
model Template {
  id               String   @id @default(uuid())
  workspaceId      String
  name             String
  description      String?
  content          String   @db.Text
  defaultPriority  IssuePriority?
  defaultAssignee  String?
  defaultLabels    String[] // Array of label IDs
  checklistItems   Json?    // Default subtask titles
  createdById      String
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  createdBy User      @relation(fields: [createdById], references: [id])

  @@unique([workspaceId, name])
  @@index([workspaceId])
}
```

#### Integration

```prisma
model Integration {
  id            String              @id @default(uuid())
  workspaceId   String
  provider      IntegrationProvider
  connected     Boolean             @default(false)
  config        Json?
  connectedAt   DateTime?
  connectedById String?

  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  connectedBy User?     @relation(fields: [connectedById], references: [id], onDelete: SetNull)

  @@unique([workspaceId, provider])
  @@index([workspaceId])
}
```

#### ApiKey

```prisma
model ApiKey {
  id          String    @id @default(uuid())
  workspaceId String
  name        String
  keyHash     String
  keyPrefix   String
  createdById String
  createdAt   DateTime  @default(now())
  lastUsedAt  DateTime?
  expiresAt   DateTime?

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  createdBy User      @relation(fields: [createdById], references: [id])

  @@index([workspaceId])
  @@index([keyPrefix])
}
```

#### Subscription

```prisma
model Subscription {
  id                    String             @id @default(uuid())
  workspaceId           String
  plan                  SubscriptionPlan   @default(FREE)
  status                SubscriptionStatus @default(ACTIVE)
  billingCycle          BillingCycle       @default(MONTHLY)
  currentPeriodStart    DateTime?
  currentPeriodEnd      DateTime?
  cancelAtPeriodEnd     Boolean            @default(false)
  stripeCustomerId      String?
  stripeSubscriptionId  String?
  createdAt             DateTime           @default(now())
  updatedAt             DateTime           @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
  @@index([stripeCustomerId])
}
```

#### Invoice

```prisma
model Invoice {
  id            String        @id @default(uuid())
  workspaceId   String
  invoiceNumber String
  amount        Int           // In cents
  currency      String        @default("usd")
  status        InvoiceStatus @default(UNPAID)
  pdfUrl        String?
  issuedAt      DateTime      @default(now())
  paidAt        DateTime?

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, invoiceNumber])
  @@index([workspaceId])
}
```

#### PaymentMethod

```prisma
model PaymentMethod {
  id                    String            @id @default(uuid())
  workspaceId           String
  type                  PaymentMethodType
  last4                 String
  brand                 String?
  expiryMonth           Int
  expiryYear            Int
  isDefault             Boolean           @default(false)
  stripePaymentMethodId String?
  createdAt             DateTime          @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId])
}
```

---

## 5. Indexing Strategy

### 5.1 Primary Access Patterns

These are the most common queries the app will run. Indexes are designed around them.

| Query                                     | Index                              |
|-------------------------------------------|------------------------------------|
| Get all issues in a workspace             | `Issue(workspaceId)`               |
| Get issues by status in workspace         | `Issue(workspaceId, status)`       |
| Get issues assigned to a user             | `Issue(workspaceId, assigneeId)`   |
| Get issues in a project                   | `Issue(projectId)`                 |
| Get issues in a cycle                     | `Issue(cycleId)`                   |
| Get user's workspace memberships          | `WorkspaceMembership(userId)`      |
| Get workspace members                     | `WorkspaceMembership(workspaceId)` |
| Get team members                          | `TeamMembership(teamId)`           |
| Get comments on an issue                  | `Comment(issueId)`                 |
| Get unread notifications for a user       | `Notification(userId, read)`       |
| Get recent activity in workspace          | `Activity(workspaceId)` + `Activity(createdAt)` |
| Look up workspace by slug                 | `Workspace(slug)` (unique)         |
| Look up user by email                     | `User(email)` (unique)             |
| Look up user by Clerk ID                  | `User(id)` (primary key)           |
| Look up API key by prefix                 | `ApiKey(keyPrefix)`                |

### 5.2 Composite Index Notes

- `Issue(workspaceId, status)` — dashboard filtered views, kanban boards
- `Issue(workspaceId, assigneeId)` — "My Issues" page
- `Activity(workspaceId, targetType)` — filtered activity feeds (e.g., show only issue activities)
- `Notification(userId, read)` — unread notification count badge

---

## 6. Issue ID Generation

Issues use human-readable IDs: `LIN-1`, `LIN-2`, ..., `LIN-101`.

**Implementation:**

The `Workspace` model has an `issueCounter` field (integer, default 0). When creating an issue:

```typescript
// Atomic increment + issue creation in a single transaction
const workspace = await prisma.workspace.update({
  where: { id: workspaceId },
  data: { issueCounter: { increment: 1 } },
  select: { issueCounter: true },
});

const issueId = `LIN-${workspace.issueCounter}`;

const issue = await prisma.issue.create({
  data: {
    id: issueId,
    number: workspace.issueCounter,
    // ...rest of fields
  },
});
```

This is wrapped in a `$transaction` to ensure atomicity under concurrent requests.

---

## 7. Cascade & Referential Actions

| Relation                     | On Delete    | Reasoning                                       |
|------------------------------|--------------|-------------------------------------------------|
| Workspace → all children     | `Cascade`    | Deleting a workspace removes everything          |
| User → WorkspaceMembership   | `Cascade`    | Removing user removes their memberships          |
| Department → Teams           | `SetNull`    | Teams can exist without a department             |
| Team → Projects              | `Cascade`    | Projects belong to teams                         |
| Project → Issues             | `Cascade`    | Issues belong to projects                        |
| Issue → Subtasks/Comments    | `Cascade`    | Children die with the issue                      |
| User → assigned issues       | `SetNull`    | Unassign if user is removed                      |
| User → created issues        | No action    | Creator is historical record, user must exist    |
| Comment → replies (self-ref) | `Cascade`    | Deleting parent deletes thread                   |

---

## 8. Migration Workflow

### 8.1 Commands

```bash
# Generate Prisma client after schema changes
npx prisma generate

# Create a migration (development)
npx prisma migrate dev --name <migration_name>

# Apply migrations (production)
npx prisma migrate deploy

# Reset database (development only — destroys all data)
npx prisma migrate reset

# View migration status
npx prisma migrate status

# Open Prisma Studio (visual DB browser)
npx prisma studio
```

### 8.2 Migration Naming Convention

Use descriptive, kebab-case names:

```
init-core-models
add-billing-tables
add-issue-relations
add-activity-indexes
```

### 8.3 Migration Order

Since models have dependencies, the initial migration should create everything in one shot. For future changes, create focused migrations:

1. `init` — All models, enums, indexes, and relations
2. Future migrations as features are built/changed

---

## 9. Environment Setup

### 9.1 Required Environment Variables

```env
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/linearis_dev"

# Clerk (auth provider)
CLERK_PUBLISHABLE_KEY="pk_test_..."
CLERK_SECRET_KEY="sk_test_..."
CLERK_WEBHOOK_SECRET="whsec_..."   # For verifying Clerk webhook signatures

# App
PORT=8000
NODE_ENV="development"
FRONTEND_URL="http://localhost:3000"
```

**Note:** OAuth (Google, GitHub), email verification, password reset, 2FA, and SSO are all configured in the **Clerk Dashboard** — not in our env vars. Clerk handles these entirely.

### 9.2 Local Development Setup

```bash
# 1. Clone and install
git clone <repo>
npm install

# 2. Copy environment template and fill in values
cp .env.example .env

# 3. Generate Prisma client
npx prisma generate

# 4. Run migrations
npx prisma migrate dev

# 5. Start development server
npm run dev
```

---

## 10. Performance Considerations

### 10.1 Query Optimization

- **Pagination:** All list endpoints use cursor-based pagination (Prisma's `cursor` + `take` + `skip`)
- **Select fields:** Use `select` or `include` to avoid over-fetching relations
- **Connection pooling:** Prisma handles connection pooling automatically. For serverless, configure `connection_limit` in the connection string

### 10.2 Expensive Queries to Watch

| Query                              | Mitigation                            |
|------------------------------------|---------------------------------------|
| Dashboard stats (counts, trends)   | Cache with short TTL or materialized  |
| Activity feed (full workspace)     | Paginate, index on `createdAt`        |
| Analytics/reports                  | Background job aggregation            |
| Full-text issue search             | PostgreSQL `tsvector` or external search engine |

### 10.3 Database Scaling Path

1. **Connection pooling** — PgBouncer or Prisma Accelerate
2. **Read replicas** — Route read-heavy queries (dashboards, reports)
3. **Partitioning** — Partition `Issue`, `Activity`, `Notification` by `workspaceId` for large tenants
4. **Full-text search** — Move to Elasticsearch/Meilisearch when PG search becomes a bottleneck
