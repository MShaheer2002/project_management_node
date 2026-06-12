# Linearis Documents — Scope

## Purpose

Documents should give each workspace, team, and project a clear place to keep important operating context.

The goal is simple:

- workspace docs keep shared company or workspace knowledge in one place
- team docs keep team-specific operating context close to the team
- project docs keep delivery context attached directly to the project

This feature exists so important files do not stay scattered across chat threads, random drives, and issue comments.

---

## Phase Alignment

This scope is for **Phase 16 — Docs** from [build-phases.md](../../setup/build-phases.md).

Phase 16 must deliver first-class document management for:

- `WORKSPACE`
- `TEAM`
- `PROJECT`

Dependency:

- Phase 15 complete

Reason:

- documents should attach naturally to the workspace, teams, projects, and planning structure already in the product

---

## Core Product Rules

Documents always belong to one parent scope only.

A document must belong to exactly one of:

- workspace
- team
- project

Documents must never appear as one flat mixed global list.

Users should always find documents inside the entity they belong to:

- workspace docs inside workspace experience
- team docs inside team detail experience
- project docs inside project detail experience

---

## Supported Scopes

## 1. Workspace Docs

Workspace docs are for shared reference material across the whole workspace.

Examples:

- handbook
- onboarding material
- policies
- process docs
- shared references

Rules:

- workspace docs are added only after workspace creation
- workspace docs can be uploaded and managed only by `OWNER` and `ADMIN`
- workspace members can view workspace docs
- guests do not get workspace docs access

Expected user understanding copy:

`Workspace docs keep policies, onboarding, and shared references in one place.`

## 2. Team Docs

Team docs are for team-specific operating material.

Examples:

- team brief
- working agreements
- rituals
- SOPs
- planning notes

Rules:

- team docs can be added during team creation
- team docs can also be added after team creation
- skipping docs during team creation must never block team creation
- owner and admin can manage team docs
- team lead should also be allowed to manage team docs

Expected user understanding copy:

`Team docs keep operating notes, rituals, and working agreements close to the team.`

## 3. Project Docs

Project docs are for delivery-specific context.

Examples:

- PRD
- technical spec
- kickoff doc
- delivery notes
- scope notes

Rules:

- project docs can be added during project creation
- project docs can also be added after project creation
- skipping docs during project creation must never block project creation
- owner and admin can manage project docs
- project lead should also be allowed to manage project docs

Expected user understanding copy:

`Project docs keep specs, plans, and delivery context attached to the work.`

---

## Roles and Permissions

The user requirement for this phase is:

- `OWNER` and `ADMIN` can add docs to workspace, team, and project

To keep behavior production-ready and consistent with the rest of the app, the scope should also support contextual managers where appropriate.

Final expected permissions:

| Action | OWNER | ADMIN | MEMBER | GUEST |
|--------|-------|-------|--------|-------|
| View workspace docs | Yes | Yes | Yes | No |
| Upload workspace docs | Yes | Yes | No | No |
| Edit/delete workspace docs | Yes | Yes | No | No |
| View team docs | Yes | Yes | Visible team/workspace members | No |
| Upload team docs | Yes | Yes | Team lead | No |
| Edit/delete team docs | Yes | Yes | Team lead | No |
| View project docs | Yes | Yes | Members with project visibility | No |
| Upload project docs | Yes | Yes | Project lead | No |
| Edit/delete project docs | Yes | Yes | Project lead | No |

Important:

- if product wants stricter behavior for first release, owner/admin-only writes across all scopes is acceptable
- but read/write behavior must remain explicit and consistent
- permission helpers should follow the same style already used for team and project leadership flows

---

## Document Lifecycle

Every document should support these lifecycle steps:

1. user chooses a file
2. system uploads file through approved storage flow
3. document record is created with metadata
4. document appears inside the correct entity scope
5. metadata can be edited later
6. document can be deleted by authorized users

The binary file may live in external storage.

The application database must still store file metadata and scope ownership.

---

## Required Document Metadata

Each document should store and return:

- `id`
- `name`
- `description`
- `scope`
- `fileName`
- `fileUrl`
- `mimeType`
- `sizeBytes`
- `uploadedBy`
- `createdAt`
- `updatedAt`

Why this matters:

- users need a meaningful document name
- users need to know what kind of file it is
- users need to know who uploaded it
- users need to know when it was added
- the UI needs safe metadata even if storage is external

Minimum user-facing document fields:

- `name`
- `document file`
- `description` optional

The first release should not make the form more complex than necessary.

---

## Creation Flows

## Team Creation Flow

Team creation may include optional initial docs.

Requirements:

- docs step is optional
- skipping docs does not fail the team create flow
- if docs are provided, they must attach to the newly created team
- the process should feel like one flow to the user, not two disconnected operations

## Project Creation Flow

Project creation may include optional initial docs.

Requirements:

- docs step is optional
- skipping docs does not fail the project create flow
- if docs are provided, they must attach to the newly created project

## Workspace Flow

Workspace docs are not part of workspace creation.

Requirements:

- workspace docs are added after workspace creation
- workspace docs should live in a dedicated workspace section, not hidden in a generic files area

---

## UI Behavior

The UI should feel consistent with the existing app.

That means:

- clean scoped sections, not cluttered file manager patterns
- the scope should be obvious from the page context
- the copy should explain what belongs here
- empty states should teach, not just report absence

Required list information:

- title
- optional description
- file type
- uploaded by
- uploaded date
- file size

Required states:

- loading
- empty
- error
- success after upload

Good empty state behavior:

- workspace: explain that policies, onboarding, and references belong here
- team: explain that team agreements and working notes belong here
- project: explain that specs and delivery context belong here

---

## Visibility Rules

Documents must stay scoped and isolated.

Required rules:

- all documents belong to the same workspace as the parent entity
- team docs must only appear in that team’s experience
- project docs must only appear in that project’s experience
- workspace docs must only appear in workspace-level experience
- document queries must always enforce workspace isolation

This is non-negotiable for production readiness.

---

## Upload and Storage Model

The documents feature must use a production-safe S3 upload flow with presigned URLs.

Expected model:

1. frontend requests a presigned upload URL for the document
2. backend validates file intent and returns an S3 presigned URL
3. frontend uploads the file directly to S3 using the presigned URL
4. frontend sends the stored file reference to the documents endpoint
5. documents endpoint creates the scoped document row
6. file metadata is persisted in DB

Important:

- backend should never rely on frontend-only metadata as source of truth
- document record creation should validate that the referenced file belongs to the same workspace context
- the backend should remain the source of truth for file key, file URL, mime type, and size metadata

Required storage direction:

- storage provider: `S3`
- upload method: `presigned URL`
- binary file must not be proxied through the normal app server request body when avoidable

---

## File Constraints

Document uploads must be bounded and explicit.

Required first-release rule:

- maximum file size: `10 MB`

Recommended validation set:

- reject files larger than `10 MB`
- store the actual file size in bytes
- validate mime type from the upload flow metadata
- return a clear validation error when file is too large

User-facing expectation:

- the UI should clearly say documents can be up to `10 MB`
- validation should happen before wasted upload work whenever possible

---

## Audit and Operations Expectations

Because documents are shared operational context, the product should be ready for:

- activity logging for uploads, edits, and deletes
- clear ownership visibility through uploader metadata
- safe deletion behavior
- consistent API response shapes

This phase does not need full collaborative editing.

The first production-ready version is file-backed scoped documents with reliable metadata and permissions.

---

## Out of Scope For This Phase

Do not expand Phase 16 into a full knowledge platform.

Out of scope:

- live collaborative rich-text editing
- version history UI
- comments on documents
- document sharing across workspaces
- public external document publishing
- full-text document search across all scopes
- nested folder systems
- document approval workflows

These can come later if needed.

---

## Success Criteria

This scope is correctly delivered when:

- workspace docs can be added after workspace creation
- team docs can be added during and after team creation
- project docs can be added during and after project creation
- owner and admin can manage docs across all required scopes
- scoped managers can be supported cleanly where allowed
- users always understand what each docs section is for
- docs remain visible only inside the correct workspace, team, or project context
- file metadata is stored and returned consistently
- empty states are useful and understandable
- the behavior is accurate to Phase 16 and safe for production use
