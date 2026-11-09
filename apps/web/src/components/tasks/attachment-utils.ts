import {
  inferAttachmentMimeType,
  normalizeAttachmentMimeType,
  type AttachmentMimeType,
} from "@bitig/core";

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

export function formatByteSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${String(bytes)} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

/**
 * Extracts `File` objects from a `ClipboardEvent`'s `clipboardData` (`files` list or `items`
 * of kind `"file"`, such as copy-pasted screenshots).
 */
export function extractFilesFromClipboard(clipboardData: DataTransfer | null | undefined): File[] {
  if (!clipboardData) return [];
  const filesList = clipboardData.files as FileList | undefined;
  if (filesList && filesList.length > 0) {
    return Array.from(filesList);
  }
  const itemsList = clipboardData.items as DataTransferItemList | undefined;
  if (itemsList && itemsList.length > 0) {
    const extracted: File[] = [];
    for (const item of Array.from(itemsList)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) extracted.push(file);
      }
    }
    return extracted;
  }
  return [];
}

export function shouldIgnoreGlobalPaste(e: ClipboardEvent): boolean {
  if (e.defaultPrevented) return true;
  const target = e.target;
  if (target instanceof Element && target.closest("[data-comment-composer]")) {
    return true;
  }
  return false;
}

/**
 * Reads a browser `File` into an attachment payload, normalizing its MIME type or falling back
 * to extension inference when the OS/browser reports a non-standard type (e.g. `video/mp2t` for `.ts`).
 */
export async function fileToAttachmentInput(file: File): Promise<{
  readonly name: string;
  readonly mimeType: AttachmentMimeType;
  readonly data: Uint8Array;
}> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fallbackExt = file.type.startsWith("image/")
    ? `.${file.type.slice("image/".length).split(";")[0] ?? "png"}`
    : "";
  const name =
    file.name && file.name.trim().length > 0
      ? file.name.trim()
      : `pasted-${String(Date.now())}${fallbackExt}`;
  let mimeType: AttachmentMimeType;
  if (file.type) {
    try {
      mimeType = normalizeAttachmentMimeType(file.type, name);
    } catch {
      mimeType = inferAttachmentMimeType(name);
    }
  } else {
    mimeType = inferAttachmentMimeType(name);
  }
  return { name, mimeType, data: bytes };
}
