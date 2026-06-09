# Phase 16 Frontend Documents Integration Guide

This guide defines the frontend integration for Documents (Phase 16), including workspace docs, team docs, project docs, S3 presigned uploads, create-flow attachments, metadata editing, and document open/download behavior.

Backend references:
- [build-phases.md](./build-phases.md)
- [documents-scope.md](../feature/documents/documents-scope.md)
- [modules/upload/docs/frontend-integration.md](../../modules/upload/docs/frontend-integration.md)

Backend implementation references:
- [documents.routes.ts](../../modules/documents/documents.routes.ts)
- [documents.schemas.ts](../../modules/documents/documents.schemas.ts)
- [documents.service.ts](../../modules/documents/documents.service.ts)
- [upload.schemas.ts](../../modules/upload/upload.schemas.ts)
- [upload.service.ts](../../modules/upload/upload.service.ts)

Frontend files likely impacted:
- [CreateTeamModal.tsx](</Users/shaheer/Documents/personal/project_management_react/src/components/modals/CreateTeamModal.tsx>)
- [CreateProjectModal.tsx](</Users/shaheer/Documents/personal/project_management_react/src/components/modals/CreateProjectModal.tsx>)
- [TeamDetailPage.tsx](</Users/shaheer/Documents/personal/project_management_react/src/features/team/pages/TeamDetailPage.tsx>)
- [ProjectDetailPage.tsx](</Users/shaheer/Documents/personal/project_management_react/src/features/projects/pages/ProjectDetailPage.tsx>)
- [SettingsPage.tsx](</Users/shaheer/Documents/personal/project_management_react/src/pages/SettingsPage.tsx>)
- [workspace.ts](</Users/shaheer/Documents/personal/project_management_react/src/shared/permissions/workspace.ts>)
- [privateApi.ts](</Users/shaheer/Documents/personal/project_management_react/src/shared/services/privateApi.ts>)

Recommended new frontend area:

```txt
src/features/documents/
├── services/documentsService.ts
├── hooks/useDocumentsData.ts
├── types.ts
├── components/DocumentsPanel.tsx
├── components/DocumentUploadComposer.tsx
├── components/DocumentList.tsx
└── components/DocumentEmptyState.tsx
```

## Preconditions

- authenticated frontend flow is stable
- `privateApi` is already injecting `Authorization` and `X-Workspace-Id`
- upload integration from [modules/upload/docs/frontend-integration.md](../../modules/upload/docs/frontend-integration.md) is understood
- team detail, project detail, and workspace settings pages are already working

## Backend Routes To Use

```txt
POST   /uploads/presigned-url
GET    /uploads/view-url

GET    /workspaces/:workspaceId/documents
POST   /workspaces/:workspaceId/documents
PATCH  /workspaces/:workspaceId/documents/:documentId
DELETE /workspaces/:workspaceId/documents/:documentId

POST   /teams                                 // now supports optional docs[]
GET    /teams/:id/documents
POST   /teams/:id/documents
PATCH  /teams/:id/documents/:documentId
DELETE /teams/:id/documents/:documentId

POST   /projects                              // now supports optional docs[]
GET    /projects/:id/documents
POST   /projects/:id/documents
PATCH  /projects/:id/documents/:documentId
DELETE /projects/:id/documents/:documentId
```

## Important Current Backend Behavior

This is the shipped backend behavior. Frontend must follow this, even where it is stricter than earlier planning docs.

- workspace document list: `MEMBER`, `ADMIN`, `OWNER`
- workspace document create/update/delete: `ADMIN`, `OWNER`
- team document list: `MEMBER`, `ADMIN`, `OWNER`
- team document create/update/delete: `ADMIN`, `OWNER`
- project document list: `MEMBER`, `ADMIN`, `OWNER`
- project document create/update/delete: `ADMIN`, `OWNER`
- guests cannot use documents routes
- member users may still create teams/projects, but they must not send `docs[]` in create payloads
- if a member includes `docs[]` while creating a team or project, backend returns `DOCUMENT_UPLOAD_FORBIDDEN`

Frontend rule:

- only show upload, edit, and delete actions for `owner` and `admin`
- keep view-only lists available to normal members where the parent entity is already visible

## Upload Contract

Documents use the existing upload module. Frontend never sends the binary file to the documents endpoint.

Required upload request:

`POST /uploads/presigned-url`

```json
{
  "fileName": "project-spec.pdf",
  "contentType": "application/pdf",
  "size": 234567,
  "kind": "document"
}
```

Current document upload rules:

- max file size: `10 MB`
- `kind` must be exactly `document`
- allowed document MIME types:
  - `application/pdf`
  - `application/msword`
  - `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
  - `application/vnd.ms-excel`
  - `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
  - `application/vnd.ms-powerpoint`
  - `application/vnd.openxmlformats-officedocument.presentationml.presentation`
  - `text/plain`
  - `text/markdown`
  - `text/csv`

Frontend validation should mirror this before the request is made.

## Upload Flow

Use this exact flow for all workspace, team, and project document uploads:

1. user selects a file
2. frontend validates type and size
3. frontend requests `POST /uploads/presigned-url` with `kind: "document"`
4. frontend uploads the file directly to S3 using the returned `uploadUrl`, `method`, and `headers`
5. after S3 upload succeeds, frontend submits the real document create request with document metadata and stored file reference
6. frontend refreshes the relevant document list

Do not call the document create endpoint before S3 upload succeeds.

## Document Create Payload

The document create body is the same across workspace, team, and project endpoints.

```ts
type DocumentFileRef = {
  key: string;
  fileName: string;
  contentType: string;
  size: number;
  kind: 'document';
  assetUrl?: string | null;
};

type CreateDocumentInput = {
  name: string;
  description?: string | null;
  file: DocumentFileRef;
};
```

Example:

```json
{
  "name": "Kickoff brief",
  "description": "Initial project brief and working assumptions.",
  "file": {
    "key": "uploads/workspaces/123/document/2026/06/abc.pdf",
    "fileName": "kickoff-brief.pdf",
    "contentType": "application/pdf",
    "size": 234567,
    "kind": "document",
    "assetUrl": null
  }
}
```

## Team And Project Create Payload Additions

Team and project creation now support optional initial documents.

Use this exact shape:

```ts
type CreateTeamInput = {
  name: string;
  description?: string;
  leadId: string;
  departmentId?: string | null;
  visibility?: 'PUBLIC' | 'PRIVATE';
  memberIds?: string[];
  docs?: CreateDocumentInput[];
};

type CreateProjectInput = {
  name: string;
  slug?: string;
  description?: string;
  teamId: string;
  departmentId?: string | null;
  leadId?: string;
  memberIds?: string[];
  visibility?: 'PUBLIC' | 'PRIVATE';
  startDate?: string;
  targetDate?: string;
  features?: {
    roadmap?: boolean;
    cycles?: boolean;
    issueTracking?: boolean;
  };
  docs?: CreateDocumentInput[];
};
```

Important:

- create response for team/project does not include the created docs list
- after successful creation, navigate as normal
- if the UI wants to show the uploaded docs immediately, fetch the entity documents list after the new entity is opened
- if current user is not `owner` or `admin`, omit `docs` from the create payload entirely

## Document Response Shape

Single create/update response:

```ts
type DocumentRecord = {
  id: string;
  workspaceId: string;
  scope: 'WORKSPACE' | 'TEAM' | 'PROJECT';
  teamId: string | null;
  projectId: string | null;
  name: string;
  description: string | null;
  key: string;
  fileName: string;
  fileUrl: string | null;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: {
    id: string;
    name: string;
    email: string;
    avatar: string | null;
  };
  createdAt: string;
  updatedAt: string;
};
```

List response:

```ts
type DocumentListResponse = {
  data: DocumentRecord[];
  meta: {
    total: number;
    cursor: string | null;
    hasMore: boolean;
  };
};
```

Supported list query params:

- `q?: string`
- `cursor?: string`
- `limit?: number`
- `sort?: 'createdAt:desc' | 'createdAt:asc' | 'name:asc' | 'name:desc'`

Use cursor pagination only.

## Open / Download Flow

This is the most important document rendering detail.

`fileUrl` may be `null`.

Use this rule:

- if `fileUrl` exists, use it directly for open/download
- if `fileUrl` is `null`, call `GET /uploads/view-url?key=<document.key>` to get a temporary signed read URL

Recommended helper:

```ts
async function resolveDocumentUrl(document: DocumentRecord): Promise<string> {
  if (document.fileUrl) return document.fileUrl;
  const response = await privateApi.get('/uploads/view-url', {
    params: { key: document.key },
  });
  return response.data.data.url;
}
```

Frontend must not assume uploaded S3 objects are public.

## Recommended Frontend Service Contract

Suggested feature service:

```ts
documentsService = {
  listWorkspace: (workspaceId, params) => GET /workspaces/:workspaceId/documents
  createWorkspace: (workspaceId, input) => POST /workspaces/:workspaceId/documents
  updateWorkspace: (workspaceId, documentId, input) => PATCH /workspaces/:workspaceId/documents/:documentId
  deleteWorkspace: (workspaceId, documentId) => DELETE /workspaces/:workspaceId/documents/:documentId

  listTeam: (teamId, params) => GET /teams/:id/documents
  createTeam: (teamId, input) => POST /teams/:id/documents
  updateTeam: (teamId, documentId, input) => PATCH /teams/:id/documents/:documentId
  deleteTeam: (teamId, documentId) => DELETE /teams/:id/documents/:documentId

  listProject: (projectId, params) => GET /projects/:id/documents
  createProject: (projectId, input) => POST /projects/:id/documents
  updateProject: (projectId, documentId, input) => PATCH /projects/:id/documents/:documentId
  deleteProject: (projectId, documentId) => DELETE /projects/:id/documents/:documentId
}
```

Suggested query keys:

```ts
documentsQueryKeys = {
  all: ['documents'],
  workspace: (workspaceId) => ['documents', 'workspace', workspaceId],
  team: (workspaceId, teamId) => ['documents', 'team', workspaceId, teamId],
  project: (workspaceId, projectId) => ['documents', 'project', workspaceId, projectId],
}
```

Invalidate after create/update/delete:

- relevant documents query key
- team detail query when team docs change
- project detail query when project docs change
- sidebar/workspace settings queries only if the screen depends on document counts or summary state

## Recommended Hooks

Suggested hooks:

- `useWorkspaceDocuments(workspaceId, params)`
- `useCreateWorkspaceDocument(workspaceId)`
- `useUpdateWorkspaceDocument(workspaceId)`
- `useDeleteWorkspaceDocument(workspaceId)`
- `useTeamDocuments(teamId, params)`
- `useCreateTeamDocument(teamId)`
- `useUpdateTeamDocument(teamId)`
- `useDeleteTeamDocument(teamId)`
- `useProjectDocuments(projectId, params)`
- `useCreateProjectDocument(projectId)`
- `useUpdateProjectDocument(projectId)`
- `useDeleteProjectDocument(projectId)`

Use `useInfiniteQuery` for lists to match current team/project patterns.

## Workspace UI Integration

Current app does not appear to have a dedicated workspace overview page for docs.

Recommended first integration:

- add a `Workspace Documents` section inside [SettingsPage.tsx](</Users/shaheer/Documents/personal/project_management_react/src/pages/SettingsPage.tsx>)
- place it below workspace profile, not inside a generic upload area
- keep the section simple and clearly scoped

Required copy:

`Workspace docs keep policies, onboarding, and shared references in one place.`

Recommended behavior:

- list all documents visible to workspace members
- show upload button only for `owner` and `admin`
- show edit/delete actions only for `owner` and `admin`
- open/download action visible for viewers

## Team UI Integration

Team detail currently has:

- overview
- members
- projects
- issues
- activity
- settings

Add a new `Docs` tab to [TeamDetailPage.tsx](</Users/shaheer/Documents/personal/project_management_react/src/features/team/pages/TeamDetailPage.tsx>).

Recommended placement:

- after `Projects`
- before `Issues`

Required copy:

`Team docs keep operating notes, rituals, and working agreements close to the team.`

Behavior:

- members can view the list
- only `owner` and `admin` can upload, rename, edit description, and delete
- show file type, uploader, upload date, description, and open/download action

## Project UI Integration

Project detail currently already has a tab system and a working roadmap panel.

Add a `Docs` tab to [ProjectDetailPage.tsx](</Users/shaheer/Documents/personal/project_management_react/src/features/projects/pages/ProjectDetailPage.tsx>).

Recommended placement:

- after `Roadmap`
- before `Members`

Required copy:

`Project docs keep specs, plans, and delivery context attached to the work.`

Behavior:

- members with project access can view
- only `owner` and `admin` can upload, rename, edit description, and delete
- use the same list/panel component as team/workspace with scope-specific copy

## Team Create Modal Integration

[CreateTeamModal.tsx](</Users/shaheer/Documents/personal/project_management_react/src/components/modals/CreateTeamModal.tsx>) should gain an optional docs step or inline section.

Rules:

- docs are optional
- skipping docs must not block team creation
- only show the docs section for `owner` and `admin`
- for members, do not show the section and do not send `docs`

Recommended UX:

- keep the current modal lightweight
- do not turn this into a file manager
- use a compact “Attach starting docs” block near the end of the form
- allow adding multiple selected docs before submit

Submission flow:

1. user selects one or more files
2. frontend uploads each file to S3 first
3. frontend builds `docs[]`
4. frontend submits `POST /teams`

If any upload fails:

- do not submit create request with partial hidden failure
- show which file failed
- allow retry or remove failed file

## Project Create Modal Integration

[CreateProjectModal.tsx](</Users/shaheer/Documents/personal/project_management_react/src/components/modals/CreateProjectModal.tsx>) should follow the same pattern.

Rules:

- docs optional
- only `owner` and `admin` see the docs upload UI
- members can still create projects, but without docs

Recommended UX:

- place the docs block near roadmap/features settings, not at the top
- label it clearly as optional project reference material
- keep each pending document row simple:
  - name input
  - optional description
  - selected file label
  - remove action

## Editing Behavior

Current backend only supports metadata edit, not file replacement.

Frontend edit modal or inline edit should only allow:

- `name`
- `description`

Do not offer “replace file” in this phase.

If product wants file replacement later, that is a separate backend feature.

## Delete Behavior

Delete removes the document record and decrements tracked storage usage.

Frontend should:

- use confirmation before delete
- remove the item from the list after success
- show a focused success toast like `Document deleted.`

Delete response is `204 No Content`.

## Empty States

Do not use a flat `No documents found` empty state by itself.

Use scope-aware copy:

- workspace: `Add shared references, policies, and onboarding material for everyone in this workspace.`
- team: `Add briefs, rituals, and working agreements that help this team stay aligned.`
- project: `Add specs, plans, and delivery notes that keep project context close to the work.`

Show upload CTA only when the viewer can manage documents.

## Recommended List Row Content

Each row should show:

- document name
- optional description
- file extension or readable type label
- uploader avatar/name
- uploaded date
- file size
- actions:
  - open
  - download
  - edit metadata
  - delete

Avoid:

- drive-style dense tables
- overly technical S3 language
- raw MIME types in the main UI

Prefer:

- readable file badges like `PDF`, `DOCX`, `CSV`, `TXT`
- clean cards or low-density rows matching current team/project detail patterns

## Suggested Permission Helper Additions

Add a small helper near [workspace.ts](</Users/shaheer/Documents/personal/project_management_react/src/shared/permissions/workspace.ts>):

```ts
export const canManageDocuments = (role: UserRole | null | undefined): boolean =>
  role === 'owner' || role === 'admin';
```

Use this for:

- workspace upload button
- team docs create/edit/delete actions
- project docs create/edit/delete actions
- create-team docs block
- create-project docs block

Do not reuse `canManageTeam` or `canManageProject` for document writes in this phase because backend is stricter.

## Error Handling Rules

Map these backend codes to clear frontend behavior:

- `UPLOAD_TYPE_NOT_ALLOWED`
  - show `This file type is not supported.`
- `UPLOAD_FILE_TOO_LARGE`
  - show `Documents must be 10 MB or smaller.`
- `DOCUMENT_TYPE_NOT_ALLOWED`
  - show `This file type is not supported for documents.`
- `DOCUMENT_KEY_WORKSPACE_MISMATCH`
  - show generic upload retry message and discard stale upload reference
- `DOCUMENT_NOT_FOUND`
  - refetch list and show `This document no longer exists.`
- `DOCUMENT_UPLOAD_FORBIDDEN`
  - hide uploader UI on next render and show permission message
- `VALIDATION_ERROR`
  - map field errors to `name`, `description`, or file input row
- `CONFLICT`
  - show `This uploaded file was already attached. Please upload again.`

For signed read URL failures from `/uploads/view-url`:

- show `Could not open document right now. Please try again.`
- do not permanently mark the document broken from one failed signed URL call

## Loading State Rules

Keep upload and save states separate.

Recommended local states per pending file:

- `idle`
- `preparing`
- `uploading`
- `uploaded`
- `failed`

Recommended mutation states:

- list loading
- create saving
- metadata saving
- delete pending

Do not freeze the entire page while one file uploads.

## Production Notes

- backend post-create endpoints are single-document requests, not batch requests
- if the UI supports adding multiple docs after creation, upload and create them sequentially or with controlled concurrency
- keep per-file progress local in the component; it does not need to live in global state
- retain both `key` and `fileUrl` in frontend state after upload because `key` is required for signed-read fallback

## Done When

- workspace settings includes a real documents section
- team detail includes a real docs tab
- project detail includes a real docs tab
- team creation supports optional initial docs for admin/owner users
- project creation supports optional initial docs for admin/owner users
- member create flows omit `docs`
- document uploads use `kind: "document"`
- file open works when `fileUrl` exists
- file open also works when `fileUrl` is `null` by calling `/uploads/view-url`
- list pagination, loading, empty, and error states are handled
- document write actions are hidden for non-admin/non-owner users
