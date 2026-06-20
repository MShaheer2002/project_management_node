/**
 * AI Rule-Based Detection — FREE, No AI Call
 *
 * Extracts structured data from user text using regex and keyword matching.
 * This runs BEFORE any AI call to save tokens and money.
 *
 * What it detects:
 *   - Issue type (bug/task/issue) from keywords
 *   - Priority (urgent/high/medium/low) from language cues
 *   - @mentions → resolved to user IDs
 *   - Issue references (e.g., VAT-42)
 *
 * If rule-based detection succeeds → that field is passed to AI as a hint (not re-detected).
 * If rule-based detection fails → AI handles it (paid call).
 */

/**
 * Detect issue type from user text. Returns null if ambiguous.
 */
export function detectType(text: string): "bug" | "task" | "issue" | null {
  const lower = text.toLowerCase();

  // Bug indicators — strong signals
  if (/\bbug\b|crash|error|broken|fix\b|doesn.?t work|regression|exception|fail|500|404|timeout|hang|freeze|data.?loss/.test(lower)) {
    return "bug";
  }

  // Task indicators — action-oriented language
  if (/\btask\b|add\b|create\b|build\b|implement|set.?up|configure|install|migrate|refactor|update\b|upgrade/.test(lower)) {
    return "task";
  }

  // Feature/issue indicators
  if (/feature|enhance|improve|request|design|propose|plan|research|investigate/.test(lower)) {
    return "issue";
  }

  return null; // Ambiguous — let AI decide
}

/**
 * Detect priority from language cues. Returns null if no strong signal.
 */
export function detectPriority(text: string): "urgent" | "high" | "medium" | "low" | null {
  const lower = text.toLowerCase();

  // Urgent — critical, production, immediate
  if (/\burgent\b|asap|critical|production.?down|data.?loss|security.?breach|immediately|p0\b|blocker/.test(lower)) {
    return "urgent";
  }

  // High — broken, failing, crashes
  if (/\bhigh\b|crash|broken|fail|doesn.?t work|can.?t|blocking|p1\b|major/.test(lower)) {
    return "high";
  }

  // Low — nice to have, enhancement
  if (/\blow\b|nice.?to.?have|enhancement|minor|trivial|cosmetic|eventually|when.?possible|p3\b/.test(lower)) {
    return "low";
  }

  // Medium — explicitly stated or no strong signal
  if (/\bmedium\b|moderate|p2\b/.test(lower)) {
    return "medium";
  }

  return null; // No strong signal — let AI decide or use default
}

/**
 * Detect severity from text (bug-specific). Returns null if no signal.
 */
export function detectSeverity(text: string): "low" | "medium" | "high" | null {
  const lower = text.toLowerCase();

  if (/data.?loss|security|production|crash|unrecoverable/.test(lower)) return "high";
  if (/broken|fail|error|incorrect|wrong/.test(lower)) return "medium";
  if (/cosmetic|typo|visual|minor|ui.?glitch/.test(lower)) return "low";

  return null;
}

/**
 * Extract @mentions from text. Supports three formats:
 *   @sarah           → person mention
 *   @team:backend    → team mention
 *   @project:mobile  → project mention
 *
 * Returns structured mentions.
 */
export interface ParsedMentions {
  people: string[];   // ["sarah", "john"]
  teams: string[];    // ["backend", "frontend"]
  projects: string[]; // ["mobile-app"]
}

export function extractMentions(text: string): ParsedMentions {
  const result: ParsedMentions = { people: [], teams: [], projects: [] };

  // Track positions consumed by @team: and @project: to avoid double-matching as people
  const consumedPositions = new Set<number>();

  // @team:name — capture word chars + hyphens (no spaces, stops at whitespace)
  const teamRegex = /@team[:\s]([\w][\w-]*)/gi;
  let teamMatch: RegExpExecArray | null;
  while ((teamMatch = teamRegex.exec(text)) !== null) {
    const name = teamMatch[1]!.trim().toLowerCase();
    if (name) {
      result.teams.push(name);
      consumedPositions.add(teamMatch.index);
    }
  }

  // @project:name — capture word chars + hyphens (no spaces)
  const projectRegex = /@project[:\s]([\w][\w-]*)/gi;
  let projectMatch: RegExpExecArray | null;
  while ((projectMatch = projectRegex.exec(text)) !== null) {
    const name = projectMatch[1]!.trim().toLowerCase();
    if (name) {
      result.projects.push(name);
      consumedPositions.add(projectMatch.index);
    }
  }

  // @person — plain @mention, excluding positions already consumed by @team:/@project:
  const personRegex = /@([\w][\w.-]*)/g;
  let personMatch: RegExpExecArray | null;
  while ((personMatch = personRegex.exec(text)) !== null) {
    // Skip if this position was already consumed by team/project
    if (consumedPositions.has(personMatch.index)) continue;

    const raw = personMatch[1]!.toLowerCase();
    // Skip bare "team" and "project" keywords (leftover from @team:x patterns)
    if (raw === "team" || raw === "project") continue;

    if (!result.people.includes(raw)) {
      result.people.push(raw);
    }
  }

  return result;
}

/**
 * Extract issue references from text (e.g., VAT-42, LIN-105).
 * Returns array of issue ID strings.
 */
export function extractIssueRefs(text: string): string[] {
  const matches = text.match(/\b[A-Z]{2,10}-\d{1,6}\b/g);
  return matches ?? [];
}

/**
 * Detect if the prompt is gibberish / not meaningful text.
 * Returns true if the text appears to be random characters.
 */
export function isGibberish(text: string): boolean {
  const cleaned = text.replace(/[@#\s.,!?;:'"()\-]/g, ""); // Strip punctuation/spaces
  if (cleaned.length < 3) return true;

  // Check consonant-to-vowel ratio — gibberish has very few vowels
  const vowels = cleaned.match(/[aeiou]/gi)?.length ?? 0;
  const ratio = vowels / cleaned.length;
  if (ratio < 0.1 && cleaned.length > 5) return true; // Less than 10% vowels in 5+ chars = gibberish

  // Check for repeated characters (e.g., "aaaaaaa", "qqqqqq")
  if (/(.)\1{4,}/.test(cleaned)) return true;

  // Check if it has at least one real word (3+ letter sequence with vowels)
  const words = text.split(/\s+/).filter((w) => w.length >= 3);
  const realWords = words.filter((w) => /[aeiou]/i.test(w));
  if (words.length > 0 && realWords.length === 0) return true;

  return false;
}

/**
 * Detect if the prompt is off-topic (not related to issue creation).
 * Returns true for math questions, general knowledge, greetings, etc.
 */
export function isOffTopic(text: string): boolean {
  const lower = text.toLowerCase().trim();

  // Math / calculator
  if (/^\d+\s*[+\-*/]\s*\d+/.test(lower)) return true;
  if (/^what\s+is\s+\d+/.test(lower)) return true;

  // General knowledge questions not about project management
  if (/^(who|what|where|when|why|how)\s+(is|are|was|were|did)\s+(the|a)\s/i.test(lower) &&
      !/issue|bug|task|feature|project|sprint|team|assign|create|build|fix/i.test(lower)) {
    return true;
  }

  // Greetings / small talk
  if (/^(hi|hello|hey|sup|yo|good morning|good evening|how are you|thanks|thank you|bye|goodbye)\b/i.test(lower) &&
      lower.length < 30) {
    return true;
  }

  return false;
}

/**
 * Check if the prompt has enough context to generate a meaningful issue.
 * Returns list of missing fields that need clarification.
 */
export function getMissingContext(text: string): string[] {
  const missing: string[] = [];
  const lower = text.toLowerCase();

  // Must have at least some description of WHAT the issue is about
  const hasSubject = text.split(/\s+/).filter((w) => w.length >= 3).length >= 2; // At least 2 real words
  if (!hasSubject) {
    missing.push("description");
  }

  // Check if just a generic verb with no object ("build issue", "create task", "fix bug")
  if (/^(create|build|fix|add|make|implement|design)\s+(a\s+)?(issue|task|bug|feature)$/i.test(lower.trim())) {
    missing.push("details");
  }

  return missing;
}

/**
 * Extract relative due date from text.
 * "deadline is 2 days" → 2, "due in a week" → 7, "by next friday" → computed
 * Returns days offset from today, or null if no date detected.
 */
export function extractDueDateOffset(text: string): number | null {
  const lower = text.toLowerCase();

  // "X days" / "X day"
  const daysMatch = lower.match(/(\d+)\s*days?\b/);
  if (daysMatch) return parseInt(daysMatch[1]!, 10);

  // "a week" / "1 week" / "X weeks"
  const weeksMatch = lower.match(/(\d+)\s*weeks?\b/);
  if (weeksMatch) return parseInt(weeksMatch[1]!, 10) * 7;
  if (/\ba\s+week\b/.test(lower)) return 7;

  // "tomorrow"
  if (/\btomorrow\b/.test(lower)) return 1;

  // "today"
  if (/\btoday\b|due\s+now\b|asap\b/.test(lower)) return 0;

  // "end of week" / "this week"
  if (/\bend\s+of\s+(the\s+)?week\b|\bthis\s+week\b/.test(lower)) {
    const today = new Date();
    const daysUntilFriday = (5 - today.getDay() + 7) % 7;
    return daysUntilFriday || 5;
  }

  // "next week"
  if (/\bnext\s+week\b/.test(lower)) return 7;

  // "X months" / "a month"
  const monthsMatch = lower.match(/(\d+)\s*months?\b/);
  if (monthsMatch) return parseInt(monthsMatch[1]!, 10) * 30;
  if (/\ba\s+month\b/.test(lower)) return 30;

  return null;
}

/**
 * Extract estimate/complexity from text.
 * "simple" → 1, "complex" → 4, "huge" → 5, "small task" → 2
 * Returns story points 1-5, or null if no signal.
 */
export function extractEstimate(text: string): number | null {
  const lower = text.toLowerCase();

  if (/\btrivial\b|\bquick\b|\btiny\b|\b1\s*point\b|\bsimple\s+fix\b/.test(lower)) return 1;
  if (/\bsmall\b|\beasy\b|\bminor\b|\b2\s*points?\b|\bstraightforward\b/.test(lower)) return 2;
  if (/\bmedium\b|\bmoderate\b|\b3\s*points?\b/.test(lower)) return 3;
  if (/\blarge\b|\bcomplex\b|\bbig\b|\b4\s*points?\b|\bsignificant\b/.test(lower)) return 4;
  if (/\bhuge\b|\bmassive\b|\bepic\b|\b5\s*points?\b|\bvery\s+complex\b/.test(lower)) return 5;

  return null;
}

/**
 * Extract URLs from text. Categorizes them by type.
 */
export interface ExtractedUrls {
  figma: string[];   // Figma file/design/proto URLs
  general: string[]; // All other URLs
}

export function extractUrls(text: string): ExtractedUrls {
  const urlRegex = /https?:\/\/[^\s<>"']+/gi;
  const matches = text.match(urlRegex) ?? [];

  const figmaRegex = /^https?:\/\/(www\.)?figma\.com\/(file|design|proto|board)\/[a-zA-Z0-9]+/;

  const figma: string[] = [];
  const general: string[] = [];

  for (const url of matches) {
    if (figmaRegex.test(url)) {
      figma.push(url);
    } else {
      general.push(url);
    }
  }

  return { figma, general };
}

/**
 * Run all rule-based detections on user input text.
 * Returns a partial result — fields are null when detection was ambiguous.
 */
export function runRuleBasedDetection(text: string) {
  return {
    type: detectType(text),
    priority: detectPriority(text),
    severity: detectSeverity(text),
    mentions: extractMentions(text),
    issueRefs: extractIssueRefs(text),
    dueDateOffset: extractDueDateOffset(text),
    estimate: extractEstimate(text),
    urls: extractUrls(text),
    isGibberish: isGibberish(text),
    isOffTopic: isOffTopic(text),
    missingContext: getMissingContext(text),
  };
}
