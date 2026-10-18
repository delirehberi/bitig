import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { BackupBundleSchema } from "@bitig/core";
import type { AppEnv } from "../index";

const HTTP_BAD_REQUEST = 400;
const HTTP_NO_CONTENT = 204;

export const backupRouter = new Hono<AppEnv>()
  .get("/", async (c) => {
    const storage = c.get("storage");
    const backup = await storage.exportAll();
    return c.json(backup);
  })
  .post(
    "/restore",
    zValidator("json", BackupBundleSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const storage = c.get("storage");
      const backup = c.req.valid("json");
      await storage.importBackup(backup);
      return c.body(null, HTTP_NO_CONTENT);
    },
  );

