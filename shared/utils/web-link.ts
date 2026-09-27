import { z } from "zod/v4";

/** Only web links, so a saved link can never run code when clicked (F-46, N-06). */
export function isWebLink(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export const webLinkSchema = z.string().trim().max(2000).refine(isWebLink, "Link must start with http or https");
