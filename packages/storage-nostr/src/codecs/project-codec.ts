import type { Project } from "@bitig/core";
import { ProjectSchema } from "@bitig/core";
import {
  NOSTR_KIND_PROJECT,
  NOSTR_TAG_ALT,
  NOSTR_TAG_D,
  NOSTR_TAG_KIND,
  NOSTR_TAG_NAME,
  NOSTR_TAG_RESOURCE,
} from "../kinds";

export interface NostrEventLike {
  readonly id?: string;
  readonly pubkey?: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig?: string;
}

export const NOSTR_TAG_CREATED_AT_ISO = "created_at_iso" as const;
export const NOSTR_TAG_UPDATED_AT_ISO = "updated_at_iso" as const;

/**
 * Encodes a Bitig Project domain entity into a Nostr event template.
 */
export function encodeProjectEvent(project: Project): {
  kind: typeof NOSTR_KIND_PROJECT;
  created_at: number;
  tags: string[][];
  content: string;
} {
  const createdUnix = Math.floor(Date.parse(project.updatedAt) / 1000);

  const tags: string[][] = [
    [NOSTR_TAG_D, project.id],
    [NOSTR_TAG_NAME, project.name],
    [NOSTR_TAG_KIND, project.kind],
    [NOSTR_TAG_CREATED_AT_ISO, project.createdAt],
    [NOSTR_TAG_UPDATED_AT_ISO, project.updatedAt],
    [NOSTR_TAG_ALT, `Bitig Project: ${project.name}`],
  ];
  for (const resource of project.resources ?? []) {
    tags.push([NOSTR_TAG_RESOURCE, resource.url, resource.type, resource.label]);
  }

  return {
    kind: NOSTR_KIND_PROJECT,
    created_at: Number.isFinite(createdUnix) ? createdUnix : Math.floor(Date.now() / 1000),
    tags,
    content: project.description,
  };
}

/**
 * Decodes a Nostr event into a Bitig Project domain entity.
 * Validates the parsed structure with ProjectSchema.
 */
export function decodeProjectEvent(event: NostrEventLike): Project {
  if (event.kind !== NOSTR_KIND_PROJECT) {
    throw new Error(`Expected kind ${String(NOSTR_KIND_PROJECT)}, received ${String(event.kind)}`);
  }

  let dTag: string | undefined;
  let nameTag: string | undefined;
  let kindTag: string | undefined;
  let createdAtIso: string | undefined;
  let updatedAtIso: string | undefined;
  const resources: { url: string; type: string | undefined; label: string | undefined }[] = [];

  for (const tag of event.tags) {
    const key = tag[0];
    const val = tag[1];
    if (!val) continue;

    if (key === NOSTR_TAG_D) {
      dTag = val;
    } else if (key === NOSTR_TAG_NAME) {
      nameTag = val;
    } else if (key === NOSTR_TAG_KIND) {
      kindTag = val;
    } else if (key === NOSTR_TAG_CREATED_AT_ISO) {
      createdAtIso = val;
    } else if (key === NOSTR_TAG_UPDATED_AT_ISO) {
      updatedAtIso = val;
    } else if (key === NOSTR_TAG_RESOURCE) {
      resources.push({ url: val, type: tag[2], label: tag[3] });
    }
  }

  if (!dTag) {
    throw new Error("Missing 'd' tag on project event");
  }

  const fallbackIso = new Date(event.created_at * 1000).toISOString();
  const rawProject = {
    id: dTag,
    name: nameTag ?? "",
    description: event.content,
    kind: kindTag ?? "hobby",
    createdAt: createdAtIso ?? fallbackIso,
    updatedAt: updatedAtIso ?? fallbackIso,
    ...(resources.length > 0 ? { resources } : {}),
  };

  return ProjectSchema.parse(rawProject);
}

