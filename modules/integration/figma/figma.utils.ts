/**
 * Figma Integration — Utilities
 *
 * URL parsing and Figma API helpers.
 */

/**
 * Extract a Figma file key from a Figma URL.
 *
 * Supported URL formats:
 *   https://www.figma.com/file/ABC123/Design-System
 *   https://www.figma.com/design/ABC123/Login-Flow?node-id=0-1
 *   https://www.figma.com/proto/ABC123/Prototype
 *   https://figma.com/file/ABC123/Name
 *   https://www.figma.com/board/ABC123/Board-Name
 *
 * Returns null if the URL doesn't match any known Figma pattern.
 */
export function extractFigmaFileKey(url: string): string | null {
  const match = url.match(
    /figma\.com\/(?:file|design|proto|board)\/([a-zA-Z0-9]+)/,
  );
  return match?.[1] ?? null;
}

/**
 * Extract the node ID from a Figma URL query parameter.
 * e.g., ?node-id=123-456 → "123-456"
 */
export function extractFigmaNodeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("node-id");
  } catch {
    return null;
  }
}

/**
 * Validate that a string looks like a Figma URL.
 */
export function isFigmaUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?figma\.com\/(file|design|proto|board)\//.test(url);
}

/**
 * Figma API response types.
 */
export interface FigmaFileMetadata {
  name: string;
  lastModified: string;
  thumbnailUrl: string;
  version: string;
  role: string;
  editorType: string;
}

export interface FigmaUserInfo {
  id: string;
  email: string;
  handle: string;
  imgUrl: string;
}
