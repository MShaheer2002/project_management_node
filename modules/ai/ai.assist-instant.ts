/**
 * Instant help requests: the few questions AI Assistance answers itself,
 * without the model ("take me to billing", "what is my role", "which page am I
 * on", "how many issues are assigned to me").
 *
 * A shortcut only fires when the WHOLE question is that request, after
 * politeness and punctuation are removed. A question that merely mentions a
 * page ("where do I upload project documents") is a real question and goes to
 * the model, which can still offer a navigation button. Matching on keywords
 * anywhere in the sentence answered the wrong question with confidence.
 */

export type WorkspaceRoleName = "OWNER" | "ADMIN" | "MEMBER" | "GUEST";

export const ALL_ROLES: WorkspaceRoleName[] = ["OWNER", "ADMIN", "MEMBER", "GUEST"];
const ADMIN_ROLES: WorkspaceRoleName[] = ["OWNER", "ADMIN"];
const LEAD_ROLES: WorkspaceRoleName[] = ["OWNER", "ADMIN", "MEMBER"];

export interface GuideRoute {
  route: string;
  label: string;
  description: string;
  /** What people call this page, normalized (see normalizeQuestion). Matched whole, never as a substring. */
  names: string[];
  allowedRoles?: WorkspaceRoleName[];
}

export const GUIDE_ROUTES: GuideRoute[] = [
  { route: "/dashboard", label: "Dashboard", description: "Workspace overview and recent activity.", names: ["dashboard", "home", "home page", "homepage", "overview"] },
  { route: "/issues/my", label: "My Issues", description: "Issues assigned to you or created by you.", names: ["my issues", "my assigned issues", "assigned issues", "issues assigned to me", "my tasks", "my work"] },
  { route: "/issues", label: "Issues", description: "Browse, search, and filter workspace issues.", names: ["issues", "all issues", "issue list", "tickets", "tasks"] },
  { route: "/issues/create", label: "Create Issue", description: "Create a new issue when your role allows it.", names: ["create issue", "create an issue", "new issue", "issue form"], allowedRoles: LEAD_ROLES },
  { route: "/projects", label: "Projects", description: "Project list, project details, and project work.", names: ["projects", "all projects", "project list"] },
  { route: "/teams", label: "Teams", description: "Team overview and team details.", names: ["teams", "team directory", "team list"] },
  { route: "/departments", label: "Departments", description: "Department overview.", names: ["departments", "department list"] },
  { route: "/members", label: "Members", description: "Workspace people, profiles, and roles.", names: ["members", "member list", "people", "users", "team members", "workspace members"] },
  { route: "/cycles", label: "Cycles", description: "Sprint/cycle planning, progress, and completion.", names: ["cycles", "sprints", "cycle list"] },
  { route: "/roadmap", label: "Roadmap", description: "Longer-term planning views.", names: ["roadmap", "roadmaps"] },
  { route: "/activity", label: "Activity", description: "Workspace activity feed.", names: ["activity", "activity feed", "activity log", "audit log"] },
  { route: "/analytics", label: "Analytics", description: "Analytics views for owners, admins, and members. Some workspace-wide analytics data may require owner/admin access.", names: ["analytics", "reports", "metrics"], allowedRoles: LEAD_ROLES },
  { route: "/integrations", label: "Integrations", description: "Connected apps and integrations.", names: ["integrations", "connected apps", "apps"], allowedRoles: LEAD_ROLES },
  { route: "/templates", label: "Templates", description: "Reusable issue templates.", names: ["templates", "issue templates"], allowedRoles: ADMIN_ROLES },
  { route: "/settings", label: "Settings", description: "Workspace settings and workflow configuration.", names: ["settings", "workspace settings"], allowedRoles: ADMIN_ROLES },
  { route: "/billing", label: "Billing", description: "Plan, payment, and workspace usage.", names: ["billing", "subscription", "plan", "plans", "payments", "invoices"], allowedRoles: ADMIN_ROLES },
  { route: "/ai-connections", label: "AI Connections", description: "Connect AI apps like Claude or ChatGPT and manage API keys.", names: ["ai connections", "api keys", "api key", "personal access tokens", "access tokens", "tokens", "mcp"], allowedRoles: ADMIN_ROLES },
  { route: "/ai-usage", label: "AI Usage", description: "How much AI the workspace and each person used.", names: ["ai usage", "ai limits"], allowedRoles: ADMIN_ROLES },
  { route: "/inbox", label: "Inbox", description: "Your notifications: mentions, assignments, and updates.", names: ["inbox", "notifications", "mentions"] },
  { route: "/help", label: "Help", description: "Help articles on how to use Trussen, for your role and plan.", names: ["help", "help center", "help articles", "help docs", "documentation", "user guide"] },
];

export type InstantRequest =
  | { kind: "greeting" }
  | { kind: "current-page" }
  | { kind: "role" }
  | { kind: "assigned" }
  | { kind: "navigate"; route: GuideRoute };

/**
 * Lowercase, curly quotes straightened, punctuation and politeness removed.
 * Letters of every script are kept, so a question in another language never
 * shrinks down to a bare English page name.
 */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\b(please|pls|plz|kindly)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(hey|hi|hello|ok|okay|so)\s+(?=\S)/, "")
    .replace(/^(can|could|would|will) you\s+(?=\S)/, "")
    .replace(/\s+(for me|now|right now|thanks|thank you)$/, "")
    .trim();
}

const GREETING = /^(hi|hello|hey|yo|salam|assalamualaikum|good (morning|afternoon|evening))( there)?$/;

const CURRENT_PAGE = [
  /^(on )?(which|what) (page|scre?en|view)( is (this|it)| am i( on| in| at)?| i am( on| in| at)?| i'm( on| in| at)?| im( on| in| at)?)$/,
  /^where am i( now| right now)?$/,
  /^(what|what's|whats) (is )?(this|the current|current) (page|scre?en|view)( for| about)?$/,
  /^how does this (page|scre?en|view) work$/,
  /^(explain|describe) this (page|scre?en|view)$/,
  /^what (can|do) i do (on|in|with) this (page|scre?en|view)$/,
];

const ROLE = [
  /^(what is|what's|whats|tell me) my (role|access|permissions)$/,
  /^my (role|access|permissions)$/,
  /^(what|which) role (am i|do i have)( here| in this workspace)?$/,
  /^what (are )?my permissions$/,
  /^what (permissions|access) do i have( here| in this workspace)?$/,
  /^what (can i|am i allowed to) do( here| in this workspace| with my role)?$/,
];

const ASSIGNED = [
  /^how many (open |assigned )?(issues|tasks) (are )?(assigned to me|do i have( open| assigned)?)$/,
  /^do i have any (open |assigned )?(issues|tasks)( assigned to me)?$/,
  /^(what|what's|whats) (are )?my (open )?(issues|tasks)$/,
];

/** Leading phrases that make a question a pure "show me this page" request. */
const NAVIGATION_LEAD = /^(take me to|bring me to|go to|navigate to|open|show me|show|find|link to|where is|where's|wheres|where are|where can i (find|see)|where do i (find|see)|how do i (get to|open|find)|how to (get to|open|find))\s+/;
const DETERMINER = /^(the|our|my)\s+/;
const PAGE_WORD = /\s+(page|screen|section|tab|area|view|link)$/;

const routeByName = new Map<string, GuideRoute>(
  GUIDE_ROUTES.flatMap((route) => route.names.map((name) => [name, route] as const)),
);

/** The page a phrase names, if the whole phrase is a page name ("my notifications" -> Inbox). */
function pageNamed(phrase: string): GuideRoute | undefined {
  const target = phrase.replace(PAGE_WORD, "").replace(/\s+(located|at)$/, "");
  return routeByName.get(target) ?? routeByName.get(target.replace(DETERMINER, ""));
}

export function matchInstantRequest(question: string): InstantRequest | null {
  const text = normalizeQuestion(question);
  if (!text) return null;

  if (GREETING.test(text)) return { kind: "greeting" };
  if (CURRENT_PAGE.some((pattern) => pattern.test(text))) return { kind: "current-page" };
  if (ROLE.some((pattern) => pattern.test(text))) return { kind: "role" };
  if (ASSIGNED.some((pattern) => pattern.test(text))) return { kind: "assigned" };

  // "billing" on its own, or "take me to the billing page".
  const lead = text.match(NAVIGATION_LEAD);
  const route = pageNamed(lead ? text.slice(lead[0].length) : text);
  return route ? { kind: "navigate", route } : null;
}
