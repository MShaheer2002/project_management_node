/**
 * Trussen AI Tool Definitions — Complete Tool Set
 *
 * SECURITY RULES (enforced in tool-executor.ts):
 *   1. ALL queries are workspace-scoped (workspaceId always applied)
 *   2. Private projects/teams only visible to their members
 *   3. GUEST = read-only. MEMBER = create + update own. ADMIN/OWNER = everything.
 *   4. NO DELETE operations — deleting is forbidden from AI
 *   5. Users can only update issues assigned to them (unless ADMIN/OWNER)
 *   6. Invite requires ADMIN/OWNER role
 *   7. Project/team creation requires ADMIN/OWNER role
 *
 * Tool naming: verb_noun (list_issues, create_project, get_cycle_progress)
 */

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required?: string[];
    };
  };
}

export const AI_TOOLS: ToolDefinition[] = [

  // ═══════════════════════════════════════════════════════════════
  // ISSUES
  // ═══════════════════════════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "list_issues",
      description: "List issues with filters. Use for 'show my issues', 'bugs in project X', 'urgent tasks', etc.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status", enum: ["backlog", "todo", "in-progress", "review", "done"] },
          priority: { type: "string", description: "Filter by priority", enum: ["low", "medium", "high", "urgent"] },
          type: { type: "string", description: "Filter by type", enum: ["task", "bug", "issue"] },
          assigneeId: { type: "string", description: "Filter by assignee. Use 'me' for current user." },
          projectId: { type: "string", description: "Filter by project ID" },
          teamId: { type: "string", description: "Filter by team ID" },
          q: { type: "string", description: "Search query" },
          limit: { type: "string", description: "Max results (default 10, max 25)" },
          sort: { type: "string", description: "Sort order: createdAt:desc (newest first), updatedAt:desc (recently updated), priority:desc (most urgent first)", enum: ["createdAt:desc", "updatedAt:desc", "priority:desc"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_issue",
      description: "Get full details of a specific issue by ID (e.g., FIS-5).",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID (e.g., FIS-5)" },
        },
        required: ["issueId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_issue",
      description: "Create a new issue. Requires project. Use for 'create task', 'new bug', etc. Always generate a meaningful description.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title" },
          type: { type: "string", description: "Issue type", enum: ["task", "bug", "issue"] },
          priority: { type: "string", description: "Priority", enum: ["low", "medium", "high", "urgent"] },
          description: { type: "string", description: "Description in markdown. Always provide a meaningful description even if user didn't specify one." },
          projectId: { type: "string", description: "Project ID" },
          assigneeId: { type: "string", description: "Assignee ID. 'me' for current user." },
          status: { type: "string", description: "Initial status key (default: todo). Use lowercase kebab-case: backlog, todo, in-progress, review, done" },
          dueDate: { type: "string", description: "Due date in YYYY-MM-DD format" },
        },
        required: ["title", "type", "projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_issue",
      description: "Update an issue's fields (title, description, priority, status, type, due date). User can only update issues assigned to them unless admin.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
          title: { type: "string", description: "New title" },
          description: { type: "string", description: "New description" },
          priority: { type: "string", description: "New priority", enum: ["low", "medium", "high", "urgent"] },
          status: { type: "string", description: "New status", enum: ["backlog", "todo", "in-progress", "review", "done"] },
          type: { type: "string", description: "New type", enum: ["task", "bug", "issue"] },
          dueDate: { type: "string", description: "Due date in YYYY-MM-DD format, or relative like 'tomorrow', '3 days', 'next week'" },
        },
        required: ["issueId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_issue_status",
      description: "Move an issue to another workflow status, for example todo, in-progress, review, or done.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
          status: { type: "string", description: "New status", enum: ["backlog", "todo", "in-progress", "review", "done"] },
        },
        required: ["issueId", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assign_issue",
      description: "Assign or reassign an issue to a member.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
          assigneeId: { type: "string", description: "User ID. 'me' for current user. Empty to unassign." },
        },
        required: ["issueId", "assigneeId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_comment",
      description: "Add a comment to an issue.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
          body: { type: "string", description: "Comment text" },
        },
        required: ["issueId", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_label_to_issue",
      description: "Add a label to an issue.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
          labelName: { type: "string", description: "Label name (must exist in workspace)" },
        },
        required: ["issueId", "labelName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_subtask",
      description: "Create a subtask/checklist item on an issue. No delete operations are available through AI.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
          title: { type: "string", description: "Subtask title" },
          order: { type: "string", description: "Optional sort order" },
        },
        required: ["issueId", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_subtask",
      description: "Update a subtask title, completed state, or order. Does not delete subtasks.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
          subtaskId: { type: "string", description: "Subtask ID" },
          title: { type: "string", description: "New title" },
          completed: { type: "string", description: "true or false" },
          order: { type: "string", description: "New order" },
        },
        required: ["issueId", "subtaskId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reorder_subtasks",
      description: "Reorder subtasks on an issue by subtask ID and order.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
          itemsJson: { type: "string", description: "JSON array of {id, order} objects" },
        },
        required: ["issueId", "itemsJson"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_issue_watchers",
      description: "Add watchers to an issue. Does not remove watchers.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
          userIdsJson: { type: "string", description: "JSON array of user IDs to add as watchers" },
        },
        required: ["issueId", "userIdsJson"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_issue_watchers",
      description: "List watchers on an issue.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
        },
        required: ["issueId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_issue_dependency",
      description: "Add an issue dependency/relation. Does not remove dependencies.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Source issue ID" },
          relatedIssueId: { type: "string", description: "Related issue ID" },
          relation: { type: "string", description: "Relation type", enum: ["blocks", "blocked-by", "related"] },
        },
        required: ["issueId", "relatedIssueId", "relation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_issue_integration_ref",
      description: "Link or update an external integration reference on an issue. Does not unlink or delete references.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Issue ID" },
          provider: { type: "string", description: "Provider", enum: ["github", "jira", "slack", "notion", "figma", "custom"] },
          label: { type: "string", description: "Display label" },
          externalId: { type: "string", description: "External object ID" },
          url: { type: "string", description: "External URL" },
        },
        required: ["issueId", "provider"],
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // PROJECTS
  // ═══════════════════════════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "list_projects",
      description: "List projects. Respects visibility — private projects only shown to members.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter", enum: ["ACTIVE", "ARCHIVED", "COMPLETED"] },
          teamId: { type: "string", description: "Filter by team" },
          q: { type: "string", description: "Search by name" },
          limit: { type: "string", description: "Max results (default 10)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_project_summary",
      description: "Get project details with issue stats (open, in progress, done counts).",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
        },
        required: ["projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_project",
      description: "Create a new project. Requires MEMBER role or higher.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project name" },
          teamId: { type: "string", description: "Team ID that owns this project" },
          description: { type: "string", description: "Project description" },
        },
        required: ["name", "teamId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_project_members",
      description: "List members of a project.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
        },
        required: ["projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_project_members",
      description: "Add members to a project. Requires project-management permission.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
          userIdsJson: { type: "string", description: "JSON array of user IDs to add" },
        },
        required: ["projectId", "userIdsJson"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_project_member",
      description: "Remove a member from a project. Requires explicit confirmation.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
          userId: { type: "string", description: "User ID to remove" },
        },
        required: ["projectId", "userId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_project",
      description: "Update project details. Requires ADMIN/OWNER or project lead.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
          name: { type: "string", description: "New name" },
          description: { type: "string", description: "New description" },
          status: { type: "string", description: "New status", enum: ["ACTIVE", "ARCHIVED", "COMPLETED"] },
        },
        required: ["projectId"],
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // TEAMS & MEMBERS
  // ═══════════════════════════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "list_teams",
      description: "List teams in the workspace.",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string", description: "Search by name" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_team",
      description: "Get full details for a specific team by ID.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" },
        },
        required: ["teamId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_team",
      description: "Create a new team. Requires member or above. AI does not support initial document uploads here.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Team name" },
          leadId: { type: "string", description: "Lead user ID" },
          departmentId: { type: "string", description: "Optional department ID" },
          description: { type: "string", description: "Optional description" },
          visibility: { type: "string", description: "Team visibility", enum: ["PUBLIC", "PRIVATE"] },
          memberIdsJson: { type: "string", description: "Optional JSON array of user IDs to add initially" },
        },
        required: ["name", "leadId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_team",
      description: "Update an existing team. Requires ownership-based permission.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" },
          name: { type: "string", description: "New team name" },
          leadId: { type: "string", description: "New lead user ID" },
          departmentId: { type: "string", description: "New department ID or empty to clear" },
          description: { type: "string", description: "New description or empty to clear" },
          visibility: { type: "string", description: "Team visibility", enum: ["PUBLIC", "PRIVATE"] },
        },
        required: ["teamId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_team_members",
      description: "Add members to a team. Requires team-management permission.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" },
          userIdsJson: { type: "string", description: "JSON array of user IDs to add" },
        },
        required: ["teamId", "userIdsJson"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_team_member",
      description: "Remove a member from a team. Requires team-management permission and explicit confirmation.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" },
          userId: { type: "string", description: "User ID to remove" },
        },
        required: ["teamId", "userId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_team_members",
      description: "List members of a specific team.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" },
        },
        required: ["teamId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_members",
      description: "List all workspace members with their roles.",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string", description: "Search by name or email" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_team_workload",
      description: "Get issue distribution across members. Shows open issue count per person.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID. Omit for all workspace members." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_departments",
      description: "List departments in the workspace.",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string", description: "Search by name" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_department",
      description: "Get full details for a specific department by ID.",
      parameters: {
        type: "object",
        properties: {
          departmentId: { type: "string", description: "Department ID" },
        },
        required: ["departmentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_department",
      description: "Create a department. Requires admin or owner.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Department name" },
          headId: { type: "string", description: "Optional department head user ID" },
          description: { type: "string", description: "Optional description" },
          color: { type: "string", description: "Optional hex color such as #5f72ea" },
          visibility: { type: "string", description: "Department visibility", enum: ["PUBLIC", "PRIVATE"] },
          isDefault: { type: "string", description: "true or false" },
          memberIdsJson: { type: "string", description: "Optional JSON array of user IDs to add initially" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_department",
      description: "Update a department. Requires ownership-based permission.",
      parameters: {
        type: "object",
        properties: {
          departmentId: { type: "string", description: "Department ID" },
          name: { type: "string", description: "New department name" },
          headId: { type: "string", description: "New head user ID or empty to clear" },
          description: { type: "string", description: "New description or empty to clear" },
          color: { type: "string", description: "Hex color or empty to clear" },
          visibility: { type: "string", description: "Department visibility", enum: ["PUBLIC", "PRIVATE"] },
          isDefault: { type: "string", description: "true or false" },
        },
        required: ["departmentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_department_members",
      description: "Add members to a department. Requires department-management permission.",
      parameters: {
        type: "object",
        properties: {
          departmentId: { type: "string", description: "Department ID" },
          userIdsJson: { type: "string", description: "JSON array of user IDs to add" },
        },
        required: ["departmentId", "userIdsJson"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_department_member",
      description: "Remove a member from a department. Requires department-management permission and explicit confirmation.",
      parameters: {
        type: "object",
        properties: {
          departmentId: { type: "string", description: "Department ID" },
          userId: { type: "string", description: "User ID to remove" },
        },
        required: ["departmentId", "userId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_workspace",
      description: "Get current workspace details and counts.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_workspace",
      description: "Update current workspace settings. Requires admin or owner.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Workspace name" },
          logo: { type: "string", description: "Workspace logo URL" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_workspace_members",
      description: "List members in the current workspace.",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string", description: "Search by name or email" },
          role: { type: "string", description: "Filter by role", enum: ["OWNER", "ADMIN", "MEMBER", "GUEST"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "change_workspace_member_role",
      description: "Change a workspace member role. Requires explicit confirmation and admin or owner.",
      parameters: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to update" },
          role: { type: "string", description: "New role", enum: ["ADMIN", "MEMBER", "GUEST"] },
        },
        required: ["userId", "role"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_workspace_member",
      description: "Remove a member from the current workspace. Requires explicit confirmation and admin or owner.",
      parameters: {
        type: "object",
        properties: {
          userId: { type: "string", description: "User ID to remove" },
        },
        required: ["userId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_workspace_statuses",
      description: "Replace the workspace custom statuses array. Requires explicit confirmation and admin or owner.",
      parameters: {
        type: "object",
        properties: {
          statusesJson: { type: "string", description: "JSON array of status objects with key, label, color, and isFinal" },
        },
        required: ["statusesJson"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_user_workspaces",
      description: "List all workspaces accessible to the current user.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_workspace_access_summary",
      description: "Summarize the current workspace, all accessible workspaces, and any pending invites for the authenticated user. Use for workspace switching, confirming the active workspace, or cross-workspace access questions.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_pending_workspace_invites",
      description: "List pending invitations sent to the current authenticated user across workspaces.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "accept_workspace_invite",
      description: "Accept a pending workspace invitation sent to the current authenticated user.",
      parameters: {
        type: "object",
        properties: {
          invitationId: { type: "string", description: "Invitation ID from list_pending_workspace_invites" },
        },
        required: ["invitationId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_workspace_invitations",
      description: "List invitations for the current workspace. Admins and owners only.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_department_members",
      description: "List members of a department.",
      parameters: {
        type: "object",
        properties: {
          departmentId: { type: "string", description: "Department ID" },
        },
        required: ["departmentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "invite_member",
      description: "Send a workspace invitation. Requires ADMIN or OWNER role. Never invite as OWNER — a workspace has exactly one owner.",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string", description: "Email to invite" },
          role: { type: "string", description: "Role to assign — never OWNER", enum: ["ADMIN", "MEMBER", "GUEST"] },
          designation: { type: "string", description: "Their job title/role label, e.g. \"Frontend Engineer\"" },
          teamId: { type: "string", description: "Team to add them to" },
        },
        required: ["email", "role", "designation", "teamId"],
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // CYCLES / SPRINTS
  // ═══════════════════════════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "get_cycle",
      description: "Get full cycle details by ID.",
      parameters: {
        type: "object",
        properties: {
          cycleId: { type: "string", description: "Cycle ID" },
        },
        required: ["cycleId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_cycle",
      description: "Create a new cycle for a team. Requires member or above.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" },
          name: { type: "string", description: "Cycle name" },
          description: { type: "string", description: "Optional description" },
          goal: { type: "string", description: "Optional goal" },
          startsAt: { type: "string", description: "Start timestamp in ISO format" },
          endsAt: { type: "string", description: "End timestamp in ISO format" },
          status: { type: "string", description: "Initial cycle status", enum: ["UPCOMING", "CURRENT", "COMPLETED"] },
        },
        required: ["teamId", "name", "startsAt", "endsAt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_cycle",
      description: "Update a cycle. Requires cycle-management permission.",
      parameters: {
        type: "object",
        properties: {
          cycleId: { type: "string", description: "Cycle ID" },
          name: { type: "string", description: "New cycle name" },
          description: { type: "string", description: "New description or empty to clear" },
          goal: { type: "string", description: "New goal or empty to clear" },
          startsAt: { type: "string", description: "Start timestamp in ISO format" },
          endsAt: { type: "string", description: "End timestamp in ISO format" },
          status: { type: "string", description: "Cycle status", enum: ["UPCOMING", "CURRENT", "COMPLETED"] },
        },
        required: ["cycleId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_cycle",
      description: "Complete a cycle. Requires member or above and explicit confirmation.",
      parameters: {
        type: "object",
        properties: {
          cycleId: { type: "string", description: "Cycle ID" },
        },
        required: ["cycleId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reopen_cycle",
      description: "Reopen a completed cycle. Requires admin or owner and explicit confirmation.",
      parameters: {
        type: "object",
        properties: {
          cycleId: { type: "string", description: "Cycle ID" },
        },
        required: ["cycleId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "carry_over_cycle",
      description: "Carry unfinished issues from a completed cycle to another cycle or backlog. Requires explicit confirmation.",
      parameters: {
        type: "object",
        properties: {
          cycleId: { type: "string", description: "Source cycle ID" },
          mode: { type: "string", description: "Carry-over mode", enum: ["nextCycle", "backlog"] },
          targetCycleId: { type: "string", description: "Required when mode is nextCycle" },
        },
        required: ["cycleId", "mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_active_templates",
      description: "List active templates, optionally filtered by issue type.",
      parameters: {
        type: "object",
        properties: {
          issueType: { type: "string", description: "Issue type", enum: ["task", "bug", "issue"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_templates",
      description: "List issue templates in the workspace.",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string", description: "Search by name or description" },
          issueType: { type: "string", description: "Issue type", enum: ["task", "bug", "issue"] },
          lifecycle: { type: "string", description: "Lifecycle filter", enum: ["ACTIVE", "INACTIVE", "ARCHIVED"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_template",
      description: "Get a template by ID.",
      parameters: {
        type: "object",
        properties: {
          templateId: { type: "string", description: "Template ID" },
        },
        required: ["templateId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_template",
      description: "Create a template. Requires admin or owner.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Template name" },
          description: { type: "string", description: "Template description" },
          issueType: { type: "string", description: "Issue type", enum: ["task", "bug", "issue"] },
          category: { type: "string", description: "Template category" },
          titleTemplate: { type: "string", description: "Issue title template" },
          contentTemplate: { type: "string", description: "Issue content template" },
          defaultPriority: { type: "string", description: "Default priority" },
          defaultStatus: { type: "string", description: "Default status" },
          defaultAssigneeType: { type: "string", description: "Default assignee type", enum: ["UNASSIGNED", "CREATOR", "SPECIFIC_USER"] },
          defaultAssigneeId: { type: "string", description: "Specific default assignee ID" },
          acceptanceCriteriaTemplate: { type: "string", description: "Required for issue-type templates" },
        },
        required: ["name", "description", "issueType", "category", "titleTemplate", "contentTemplate", "defaultPriority", "defaultStatus", "defaultAssigneeType"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_template",
      description: "Update a template. Requires admin or owner.",
      parameters: {
        type: "object",
        properties: {
          templateId: { type: "string", description: "Template ID" },
          name: { type: "string", description: "Template name" },
          description: { type: "string", description: "Template description" },
          titleTemplate: { type: "string", description: "Issue title template" },
          contentTemplate: { type: "string", description: "Issue content template" },
          defaultPriority: { type: "string", description: "Default priority" },
          defaultStatus: { type: "string", description: "Default status" },
          defaultAssigneeType: { type: "string", description: "Default assignee type", enum: ["UNASSIGNED", "CREATOR", "SPECIFIC_USER"] },
          defaultAssigneeId: { type: "string", description: "Specific default assignee ID" },
          acceptanceCriteriaTemplate: { type: "string", description: "Acceptance criteria template" },
        },
        required: ["templateId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "duplicate_template",
      description: "Duplicate a template. Requires admin or owner.",
      parameters: {
        type: "object",
        properties: {
          templateId: { type: "string", description: "Template ID" },
        },
        required: ["templateId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "activate_template",
      description: "Activate a template. Requires explicit confirmation and admin or owner.",
      parameters: {
        type: "object",
        properties: {
          templateId: { type: "string", description: "Template ID" },
        },
        required: ["templateId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deactivate_template",
      description: "Deactivate a template. Requires explicit confirmation and admin or owner.",
      parameters: {
        type: "object",
        properties: {
          templateId: { type: "string", description: "Template ID" },
        },
        required: ["templateId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_cycles",
      description: "List sprints/cycles for a team.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" },
          status: { type: "string", description: "Filter", enum: ["UPCOMING", "CURRENT", "COMPLETED"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cycle_progress",
      description: "Get sprint/cycle progress with issue breakdown by status.",
      parameters: {
        type: "object",
        properties: {
          cycleId: { type: "string", description: "Cycle ID" },
        },
        required: ["cycleId"],
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // LABELS
  // ═══════════════════════════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "list_labels",
      description: "List all labels in the workspace.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "list_notifications",
      description: "List notifications for the current user in the current workspace.",
      parameters: {
        type: "object",
        properties: {
          unreadOnly: { type: "string", description: "true or false" },
          category: { type: "string", description: "Notification category", enum: ["mention", "assignment", "update", "membership", "comment"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_notification_read",
      description: "Mark a notification as read.",
      parameters: {
        type: "object",
        properties: {
          notificationId: { type: "string", description: "Notification ID" },
        },
        required: ["notificationId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_all_notifications_read",
      description: "Mark all current-workspace notifications as read.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_document",
      description: "Create a document from an already-uploaded file reference for a workspace, team, or project scope.",
      parameters: {
        type: "object",
        properties: {
          scopeType: { type: "string", description: "Scope type", enum: ["WORKSPACE", "TEAM", "PROJECT"] },
          teamId: { type: "string", description: "Required for TEAM scope" },
          projectId: { type: "string", description: "Required for PROJECT scope" },
          name: { type: "string", description: "Document name" },
          description: { type: "string", description: "Optional description" },
          folderId: { type: "string", description: "Optional folder ID" },
          fileKey: { type: "string", description: "Uploaded file storage key" },
          fileName: { type: "string", description: "Original file name" },
          contentType: { type: "string", description: "File MIME type" },
          sizeBytes: { type: "string", description: "File size in bytes" },
          assetUrl: { type: "string", description: "Optional public asset URL for the uploaded file" },
        },
        required: ["scopeType", "name", "fileKey", "fileName", "contentType", "sizeBytes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_documents",
      description: "List documents for a workspace, team, or project scope.",
      parameters: {
        type: "object",
        properties: {
          scopeType: { type: "string", description: "Scope type", enum: ["WORKSPACE", "TEAM", "PROJECT"] },
          teamId: { type: "string", description: "Required for TEAM scope" },
          projectId: { type: "string", description: "Required for PROJECT scope" },
          folderId: { type: "string", description: "Optional folder ID filter" },
        },
        required: ["scopeType"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_document_folders",
      description: "List document folders for a workspace, team, or project scope.",
      parameters: {
        type: "object",
        properties: {
          scopeType: { type: "string", description: "Scope type", enum: ["WORKSPACE", "TEAM", "PROJECT"] },
          teamId: { type: "string", description: "Required for TEAM scope" },
          projectId: { type: "string", description: "Required for PROJECT scope" },
          parentId: { type: "string", description: "Optional parent folder ID" },
        },
        required: ["scopeType"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_document_folder",
      description: "Create a document folder. Requires the same permission as the underlying scope.",
      parameters: {
        type: "object",
        properties: {
          scopeType: { type: "string", description: "Scope type", enum: ["WORKSPACE", "TEAM", "PROJECT"] },
          teamId: { type: "string", description: "Required for TEAM scope" },
          projectId: { type: "string", description: "Required for PROJECT scope" },
          name: { type: "string", description: "Folder name" },
          parentId: { type: "string", description: "Optional parent folder ID" },
        },
        required: ["scopeType", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_document_folder",
      description: "Rename a document folder.",
      parameters: {
        type: "object",
        properties: {
          scopeType: { type: "string", description: "Scope type", enum: ["WORKSPACE", "TEAM", "PROJECT"] },
          teamId: { type: "string", description: "Required for TEAM scope" },
          projectId: { type: "string", description: "Required for PROJECT scope" },
          folderId: { type: "string", description: "Folder ID" },
          name: { type: "string", description: "New folder name" },
        },
        required: ["scopeType", "folderId", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_document_folder",
      description: "Move a document folder to a new parent folder.",
      parameters: {
        type: "object",
        properties: {
          scopeType: { type: "string", description: "Scope type", enum: ["WORKSPACE", "TEAM", "PROJECT"] },
          teamId: { type: "string", description: "Required for TEAM scope" },
          projectId: { type: "string", description: "Required for PROJECT scope" },
          folderId: { type: "string", description: "Folder ID" },
          parentId: { type: "string", description: "New parent folder ID or empty for root" },
        },
        required: ["scopeType", "folderId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_document",
      description: "Move a document to another folder.",
      parameters: {
        type: "object",
        properties: {
          scopeType: { type: "string", description: "Scope type", enum: ["WORKSPACE", "TEAM", "PROJECT"] },
          teamId: { type: "string", description: "Required for TEAM scope" },
          projectId: { type: "string", description: "Required for PROJECT scope" },
          documentId: { type: "string", description: "Document ID" },
          folderId: { type: "string", description: "Destination folder ID or empty for root" },
        },
        required: ["scopeType", "documentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_document",
      description: "Update document metadata such as name or description.",
      parameters: {
        type: "object",
        properties: {
          scopeType: { type: "string", description: "Scope type", enum: ["WORKSPACE", "TEAM", "PROJECT"] },
          teamId: { type: "string", description: "Required for TEAM scope" },
          projectId: { type: "string", description: "Required for PROJECT scope" },
          documentId: { type: "string", description: "Document ID" },
          name: { type: "string", description: "New document name" },
          description: { type: "string", description: "New description or empty to clear" },
        },
        required: ["scopeType", "documentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_roadmap",
      description: "List roadmap items across the workspace or scoped by team, department, or project.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Optional team filter" },
          departmentId: { type: "string", description: "Optional department filter" },
          projectId: { type: "string", description: "Optional project filter" },
          health: { type: "string", description: "Health filter", enum: ["ON_TRACK", "AT_RISK", "OFF_TRACK", "BLOCKED", "NO_SIGNAL"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_project_roadmap",
      description: "Get detailed roadmap information for a single project.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
        },
        required: ["projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_project_schedule",
      description: "Update project roadmap schedule. Requires explicit confirmation when conflicts or force changes apply.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
          startDate: { type: "string", description: "Start date in YYYY-MM-DD" },
          targetDate: { type: "string", description: "Target date in YYYY-MM-DD" },
          reason: { type: "string", description: "Reason for the schedule change" },
          force: { type: "string", description: "true or false" },
        },
        required: ["projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_milestone",
      description: "Create a roadmap milestone for a project.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
          name: { type: "string", description: "Milestone name" },
          dueDate: { type: "string", description: "Due timestamp in ISO format" },
          ownerId: { type: "string", description: "Optional milestone owner user ID" },
          description: { type: "string", description: "Optional description" },
          status: { type: "string", description: "Milestone status", enum: ["PLANNED", "IN_PROGRESS", "COMPLETED", "MISSED"] },
        },
        required: ["projectId", "name", "dueDate"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_milestone",
      description: "Update a roadmap milestone.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
          milestoneId: { type: "string", description: "Milestone ID" },
          name: { type: "string", description: "Milestone name" },
          dueDate: { type: "string", description: "Due timestamp in ISO format" },
          ownerId: { type: "string", description: "Milestone owner user ID or empty to clear" },
          description: { type: "string", description: "Description or empty to clear" },
          status: { type: "string", description: "Milestone status", enum: ["PLANNED", "IN_PROGRESS", "COMPLETED", "MISSED"] },
        },
        required: ["projectId", "milestoneId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_roadmap_dependency",
      description: "Create a roadmap dependency between two projects.",
      parameters: {
        type: "object",
        properties: {
          blockingProjectId: { type: "string", description: "Blocking project ID" },
          blockedProjectId: { type: "string", description: "Blocked project ID" },
          note: { type: "string", description: "Optional dependency note" },
        },
        required: ["blockingProjectId", "blockedProjectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reorder_milestones",
      description: "Reorder roadmap milestones for a project.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
          orderedIdsJson: { type: "string", description: "JSON array of milestone IDs in order" },
        },
        required: ["projectId", "orderedIdsJson"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_roadmap_dependency",
      description: "Resolve a roadmap dependency without deleting it.",
      parameters: {
        type: "object",
        properties: {
          dependencyId: { type: "string", description: "Dependency ID" },
          note: { type: "string", description: "Optional resolution note" },
        },
        required: ["dependencyId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_roadmap_dependency",
      description: "Cancel a roadmap dependency without deleting it.",
      parameters: {
        type: "object",
        properties: {
          dependencyId: { type: "string", description: "Dependency ID" },
          note: { type: "string", description: "Optional cancellation note" },
        },
        required: ["dependencyId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_api_keys",
      description: "List API keys for the current workspace. Returns masked prefixes only.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_api_key",
      description: "Create a new API key for the current workspace. Admins and owners only. The raw key is shown once and is not available again on replay.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Human-readable API key name" },
          expiresAt: { type: "string", description: "Optional future ISO-8601 expiry timestamp" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_api_key",
      description: "Get a single API key by ID. Returns masked prefix only.",
      parameters: {
        type: "object",
        properties: {
          keyId: { type: "string", description: "API key ID" },
        },
        required: ["keyId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_integrations",
      description: "List integration connection status for the current workspace.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_integration_status",
      description: "Get integration status and settings for a single provider.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", description: "Provider name", enum: ["github", "slack", "discord", "figma"] },
        },
        required: ["provider"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_workspace_analytics",
      description: "Get workspace-level analytics. Requires admin or owner. Use for workspace health, top blockers, urgent open work, and workspace trends.",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", description: "Reporting period", enum: ["7d", "30d", "90d", "custom"] },
          from: { type: "string", description: "Custom range start date in YYYY-MM-DD" },
          to: { type: "string", description: "Custom range end date in YYYY-MM-DD" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_project_analytics",
      description: "Get project analytics: progress, timeline health, burndown, scope growth, priority/status breakdown, and project workload.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project ID" },
          period: { type: "string", description: "Reporting period", enum: ["7d", "30d", "90d", "custom"] },
          from: { type: "string", description: "Custom range start date in YYYY-MM-DD" },
          to: { type: "string", description: "Custom range end date in YYYY-MM-DD" },
        },
        required: ["projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_team_analytics",
      description: "Get team analytics: velocity, workload distribution, overdue work, member performance, and recent cycle comparison.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" },
          period: { type: "string", description: "Reporting period", enum: ["7d", "30d", "90d", "custom"] },
          from: { type: "string", description: "Custom range start date in YYYY-MM-DD" },
          to: { type: "string", description: "Custom range end date in YYYY-MM-DD" },
        },
        required: ["teamId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_member_analytics",
      description: "Get member analytics: assigned, completed, overdue, project/team breakdown, and recent activity. Members can view only their own analytics unless admin/owner.",
      parameters: {
        type: "object",
        properties: {
          memberId: { type: "string", description: "Member user ID. Use 'me' for current user." },
          period: { type: "string", description: "Reporting period", enum: ["7d", "30d", "90d", "custom"] },
          from: { type: "string", description: "Custom range start date in YYYY-MM-DD" },
          to: { type: "string", description: "Custom range end date in YYYY-MM-DD" },
        },
        required: ["memberId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cycle_analytics",
      description: "Get cycle analytics: current progress, remaining work, burndown, overdue/blocked work, and sprint health.",
      parameters: {
        type: "object",
        properties: {
          cycleId: { type: "string", description: "Cycle ID" },
          period: { type: "string", description: "Reporting period", enum: ["7d", "30d", "90d", "custom"] },
          from: { type: "string", description: "Custom range start date in YYYY-MM-DD" },
          to: { type: "string", description: "Custom range end date in YYYY-MM-DD" },
        },
        required: ["cycleId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_cycle_for_team",
      description: "Resolve the current cycle for a team before getting cycle analytics or sprint progress.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team ID" },
        },
        required: ["teamId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "export_analytics_report",
      description: "Export analytics for a workspace, project, team, member, or cycle as json, csv, or pdf. Use when the user explicitly asks to export or download a report.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", description: "Analytics scope", enum: ["workspace", "project", "team", "member", "cycle"] },
          scopeId: { type: "string", description: "Required for non-workspace exports" },
          period: { type: "string", description: "Reporting period", enum: ["7d", "30d", "90d", "custom"] },
          from: { type: "string", description: "Custom range start date in YYYY-MM-DD" },
          to: { type: "string", description: "Custom range end date in YYYY-MM-DD" },
          format: { type: "string", description: "Export format", enum: ["json", "csv", "pdf"] },
        },
        required: ["scope", "format"],
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // SEARCH
  // ═══════════════════════════════════════════════════════════════

  {
    type: "function",
    function: {
      name: "search_issues",
      description: "Full-text search across issue titles and descriptions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "string", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
  },
];

export function getToolDefinitions(): ToolDefinition[] {
  return AI_TOOLS;
}

// The free-form tool-calling loop previously sent all ~100 tool schemas on every call,
// which alone can consume the majority of MAX_TOKENS_PER_TURN before the model does any
// real work. This groups tools by domain so a turn can request only the
// domains it actually needs. CORE_TOOL_NAMES covers the highest-frequency actions and is
// always included so a domain-detection miss degrades gracefully instead of breaking.
export type ToolDomain =
  | "issues"
  | "projects"
  | "teams"
  | "departments"
  | "workspace"
  | "cycles"
  | "templates"
  | "notifications"
  | "documents"
  | "roadmap"
  | "integrations"
  | "analytics";

export const ALL_TOOL_DOMAINS: ToolDomain[] = [
  "issues", "projects", "teams", "departments", "workspace", "cycles",
  "templates", "notifications", "documents", "roadmap", "integrations", "analytics",
];

const CORE_TOOL_NAMES: string[] = [
  "list_issues", "get_issue", "search_issues", "add_comment",
  "update_issue_status", "assign_issue", "list_projects", "list_members",
];

const TOOL_DOMAIN_MAP: Record<ToolDomain, string[]> = {
  issues: [
    "create_issue", "update_issue", "add_label_to_issue", "create_subtask", "update_subtask",
    "reorder_subtasks", "add_issue_watchers", "list_issue_watchers", "add_issue_dependency",
    "update_issue_integration_ref", "list_labels",
  ],
  projects: [
    "get_project_summary", "create_project", "list_project_members", "add_project_members",
    "remove_project_member", "update_project",
  ],
  teams: [
    "list_teams", "get_team", "create_team", "update_team", "add_team_members",
    "remove_team_member", "list_team_members", "get_team_workload",
  ],
  departments: [
    "list_departments", "get_department", "create_department", "update_department",
    "add_department_members", "remove_department_member", "list_department_members",
  ],
  workspace: [
    "get_workspace", "update_workspace", "list_workspace_members", "change_workspace_member_role",
    "remove_workspace_member", "update_workspace_statuses", "list_user_workspaces",
    "get_workspace_access_summary", "list_pending_workspace_invites", "accept_workspace_invite",
    "list_workspace_invitations", "invite_member",
  ],
  cycles: [
    "get_cycle", "create_cycle", "update_cycle", "complete_cycle", "reopen_cycle",
    "carry_over_cycle", "list_cycles", "get_cycle_progress", "get_current_cycle_for_team",
  ],
  templates: [
    "list_active_templates", "list_templates", "get_template", "create_template",
    "update_template", "duplicate_template", "activate_template", "deactivate_template",
  ],
  notifications: ["list_notifications", "mark_notification_read", "mark_all_notifications_read"],
  documents: [
    "create_document", "list_documents", "list_document_folders", "create_document_folder",
    "rename_document_folder", "move_document_folder", "move_document", "update_document",
  ],
  roadmap: [
    "list_roadmap", "get_project_roadmap", "update_project_schedule", "create_milestone",
    "update_milestone", "create_roadmap_dependency", "reorder_milestones",
    "resolve_roadmap_dependency", "cancel_roadmap_dependency",
  ],
  integrations: ["list_api_keys", "create_api_key", "get_api_key", "list_integrations", "get_integration_status"],
  analytics: [
    "get_workspace_analytics", "get_project_analytics", "get_team_analytics",
    "get_member_analytics", "get_cycle_analytics", "export_analytics_report",
  ],
};

/**
 * Returns only the tools needed for the given domains (plus the always-included core set).
 * Callers should fall back to getToolDefinitions() when domain detection finds no signal at
 * all, rather than risk under-provisioning a legitimately domain-spanning request.
 */
export function getScopedToolDefinitions(domains: ToolDomain[]): ToolDefinition[] {
  const names = new Set(CORE_TOOL_NAMES);
  for (const domain of domains) {
    for (const name of TOOL_DOMAIN_MAP[domain] ?? []) names.add(name);
  }
  return AI_TOOLS.filter((tool) => names.has(tool.function.name));
}
