import type { StorageMode } from "@bitig/core";

export interface ModeCopy {
  label: string;
  summary: string;
}

export const DEFAULT_MODE: StorageMode = "cloudflare";

export const MODE_COPY: Record<StorageMode, ModeCopy> = {
  cloudflare: {
    label: "Cloudflare",
    summary: "Projects and tasks live in D1 behind this Worker. Sign-in uses Basic Auth.",
  },
  nostr: {
    label: "Nostr",
    summary:
      "Runs in your browser only. You sign with a NIP-07 extension, and private tasks are NIP-44 encrypted.",
  },
  local: {
    label: "Local",
    summary:
      "Markdown files in a folder you choose. Needs a Chromium browser for the File System Access API.",
  },
};
