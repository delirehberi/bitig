import { Hono } from "hono";
import { isImageAttachmentMimeType, isTextAttachmentMimeType, stripAttachmentData } from "@bitig/core";
import type { AppEnv } from "../index";

const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;

/** Attachments are listed and uploaded under their task (`/api/tasks/:id/attachments`); this downloads or deletes one by ID. */
export const attachmentsRouter = new Hono<AppEnv>()
  .get("/:id", async (c) => {
    const storage = c.get("storage");
    const attachment = await storage.getAttachment(c.req.param("id"));
    if (!attachment) {
      return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    }
    const meta = stripAttachmentData(attachment);
    const inlineSafe = isImageAttachmentMimeType(meta.mimeType) || isTextAttachmentMimeType(meta.mimeType);
    const safeAscii = meta.name.replace(/["\\\r\n]/g, "_");
    const disposition = `${inlineSafe ? "inline" : "attachment"}; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`;

    const body = new Uint8Array(attachment.data.byteLength);
    body.set(attachment.data);

    return new Response(body.buffer, {
      status: 200,
      headers: {
        "Content-Type": isTextAttachmentMimeType(meta.mimeType)
          ? `${meta.mimeType}; charset=utf-8`
          : meta.mimeType,
        "Content-Length": String(meta.size),
        "Content-Disposition": disposition,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "X-Bitig-Attachment": encodeURIComponent(JSON.stringify(meta)),
      },
    });
  })
  .delete("/:id", async (c) => {
    const storage = c.get("storage");
    await storage.deleteAttachment(c.req.param("id"));
    return c.body(null, HTTP_NO_CONTENT);
  });
