import type { ProjectResource, ResourceType } from "@bitig/core";

/** A form row: the URL may still be blank or invalid while the user types. */
export interface ResourceDraft {
  type: ResourceType;
  label: string;
  url: string;
}

/**
 * Turns form rows into resources: rows without a URL are dropped and a blank
 * label falls back to the URL's host. Returns an error message for the first
 * URL that is not a web address.
 */
export function toResources(
  drafts: readonly ResourceDraft[],
): { ok: true; resources: ProjectResource[] } | { ok: false; error: string } {
  const resources: ProjectResource[] = [];
  for (const draft of drafts) {
    const url = draft.url.trim();
    if (!url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: `"${url}" is not a valid link` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, error: `"${url}" must start with http:// or https://` };
    }
    resources.push({ type: draft.type, label: draft.label.trim() || parsed.host, url });
  }
  return { ok: true, resources };
}
