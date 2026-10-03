/**
 * Reads AI Assistance's streamed reply as it arrives.
 *
 * The model is asked to write, in order:
 *
 *   {"basis":"help","sources":[1],"confidence":"high","intent":"feature","title":"…"}
 *   @@ANSWER@@
 *   …the answer, in markdown…
 *   @@END@@
 *   {"followUps":[…],"navigation":{…},"facts":[…]}
 *
 * The header comes first so the server can check the answer is grounded
 * BEFORE any of it is shown. Only then is the answer streamed, piece by piece.
 * Markers may be split across network chunks, so the end of the answer is held
 * back until it's certain it isn't the start of a marker.
 *
 * If the model ignores the format, the parser switches to "raw": nothing is
 * streamed and the whole reply is parsed at the end, the old way.
 */
export const ANSWER_MARKER = "@@ANSWER@@";
export const END_MARKER = "@@END@@";
/** A header longer than this means the model isn't following the format. */
const MAX_HEADER_CHARS = 1_500;

type State = "header" | "answer" | "footer" | "raw";

export interface StreamPush {
  /** Set once, when the header has been read. */
  header?: unknown;
  /** Answer text that is safe to show now. */
  delta?: string;
}

export class AssistStreamParser {
  private state: State = "header";
  private buffer = "";
  private answer = "";
  private footer = "";
  private all = "";
  private atAnswerStart = true;

  get mode(): State {
    return this.state;
  }

  push(chunk: string): StreamPush {
    this.all += chunk;
    if (this.state === "raw") return {};
    if (this.state === "footer") {
      this.footer += chunk;
      return {};
    }

    this.buffer += chunk;
    const result: StreamPush = {};

    if (this.state === "header") {
      const at = this.buffer.indexOf(ANSWER_MARKER);
      if (at === -1) {
        if (this.buffer.length > MAX_HEADER_CHARS) this.state = "raw";
        return {};
      }
      const header = parseJsonObject(this.buffer.slice(0, at));
      if (header === null) {
        this.state = "raw";
        return {};
      }
      result.header = header;
      this.buffer = this.buffer.slice(at + ANSWER_MARKER.length);
      this.state = "answer";
    }

    // state === "answer"
    const end = this.buffer.indexOf(END_MARKER);
    let ready: string;
    if (end !== -1) {
      ready = this.buffer.slice(0, end);
      this.footer = this.buffer.slice(end + END_MARKER.length);
      this.buffer = "";
      this.state = "footer";
    } else {
      // Hold back anything that could be the start of the end marker.
      const keep = partialMarkerLength(this.buffer, END_MARKER);
      ready = this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
    }

    if (this.atAnswerStart) {
      ready = ready.replace(/^\s+/, "");
      if (ready) this.atAnswerStart = false;
    }
    if (ready) {
      this.answer += ready;
      result.delta = ready;
    }
    return result;
  }

  /** Everything once the model has finished (or was stopped). */
  end(): { mode: "structured"; answer: string; footer: unknown } | { mode: "raw"; text: string } {
    if (this.state === "raw" || this.state === "header") return { mode: "raw", text: this.all };
    if (this.state === "answer") {
      // No end marker: the rest of the buffer is answer text.
      this.answer += this.buffer;
      this.buffer = "";
    }
    return { mode: "structured", answer: this.answer.trim(), footer: parseJsonObject(this.footer) ?? {} };
  }
}

/** How many trailing characters of `text` could be the beginning of `marker`. */
export function partialMarkerLength(text: string, marker: string): number {
  for (let length = Math.min(marker.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(trimmed.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
