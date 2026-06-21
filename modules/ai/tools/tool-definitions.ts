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
      description: "Create a new project. Requires ADMIN or OWNER role.",
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
      name: "invite_member",
      description: "Send a workspace invitation. Requires ADMIN or OWNER role.",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string", description: "Email to invite" },
          role: { type: "string", description: "Role to assign", enum: ["ADMIN", "MEMBER", "GUEST"] },
          teamId: { type: "string", description: "Team to add them to" },
        },
        required: ["email", "role", "teamId"],
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // CYCLES / SPRINTS
  // ═══════════════════════════════════════════════════════════════

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
      name: "get_analytics",
      description: "Get workspace analytics: issue counts by status, priority, type. Completion rate. Use for 'how are we doing', 'velocity', 'stats'.",
      parameters: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Scope to team (optional)" },
          projectId: { type: "string", description: "Scope to project (optional)" },
          days: { type: "string", description: "Lookback period in days (default 30)" },
        },
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
