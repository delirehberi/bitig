import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  CreateFeedbackFormInputSchema,
  IdSchema,
  NotFoundError,
  UpdateFeedbackFormInputSchema,
  hasMinimumOrgRole,
  type FeedbackForm,
  type OrganisationRole,
} from "@bitig/core";
import { D1FeedbackStore } from "@bitig/storage-d1";
import type { Context } from "hono";
import { ForbiddenRoleError } from "../auth";
import type { AppEnv } from "../index";

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;

export interface FeedbackFormResponse extends FeedbackForm {
  readonly publicPath: string;
  readonly publicUrl: string;
  readonly publicLink: string;
  readonly pendingCount: number;
}

const CreateProjectFeedbackFormBodySchema = CreateFeedbackFormInputSchema.omit({
  projectId: true,
  orgId: true,
});

function assertFeedbackRole(c: Context<AppEnv>, minRole: OrganisationRole): void {
  const role = c.get("orgRole");
  if (!role || !hasMinimumOrgRole(role, minRole)) {
    throw new ForbiddenRoleError(`Forbidden: ${minRole} role required`);
  }
}

function createScopedFeedbackStore(c: Context<AppEnv>): D1FeedbackStore {
  return new D1FeedbackStore({
    db: c.env.DB,
    orgId: c.get("orgId"),
  });
}

function resolveFeedbackActor(c: Context<AppEnv>): string | undefined {
  const user = c.get("user");
  if (user) {
    return user.displayName || user.username;
  }
  return c.req.header("X-Bitig-Actor") ?? c.req.header("X-Bitig-Agent") ?? undefined;
}

export function buildFeedbackPublicPath(publicId: string): string {
  return `/f/${encodeURIComponent(publicId)}`;
}

export function buildFeedbackPublicUrl(c: Context<AppEnv>, publicId: string): string {
  const reqOrigin = new URL(c.req.url).origin;
  const publicPath = buildFeedbackPublicPath(publicId);
  return `${reqOrigin}${publicPath}`;
}

export function formatFeedbackFormResponse(
  c: Context<AppEnv>,
  form: FeedbackForm,
  pendingCount: number,
): FeedbackFormResponse {
  const publicPath = buildFeedbackPublicPath(form.publicId);
  const publicUrl = buildFeedbackPublicUrl(c, form.publicId);
  return {
    ...form,
    publicPath,
    publicUrl,
    publicLink: publicUrl,
    pendingCount,
  };
}

export const projectFeedbackFormsRouter = new Hono<AppEnv>()
  .get("/:id/feedback-forms", async (c) => {
    assertFeedbackRole(c, "viewer");
    const projectId = c.req.param("id");
    if (!IdSchema.safeParse(projectId).success) {
      throw new NotFoundError("project", projectId);
    }
    const project = await c.get("storage").getProject(projectId);
    if (!project) {
      throw new NotFoundError("project", projectId);
    }
    const store = createScopedFeedbackStore(c);
    const forms = await store.listFormsByProject(project.id, {
      signal: c.req.raw.signal,
    });
    const pendingCounts = await store.getPendingCountsByFormIds(
      forms.map((form) => form.id),
      { signal: c.req.raw.signal },
    );
    return c.json(
      forms.map((form) =>
        formatFeedbackFormResponse(c, form, pendingCounts.get(form.id) ?? 0),
      ),
    );
  })
  .post(
    "/:id/feedback-forms",
    zValidator("json", CreateProjectFeedbackFormBodySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "validation_error", details: result.error.issues },
          HTTP_BAD_REQUEST,
        );
      }
      return undefined;
    }),
    async (c) => {
      assertFeedbackRole(c, "editor");
      const projectId = c.req.param("id");
      if (!IdSchema.safeParse(projectId).success) {
        throw new NotFoundError("project", projectId);
      }
      const project = await c.get("storage").getProject(projectId);
      if (!project) {
        throw new NotFoundError("project", projectId);
      }
      const input = c.req.valid("json");
      const actor = resolveFeedbackActor(c);
      const store = createScopedFeedbackStore(c);
      const created = await store.createForm(
        {
          ...input,
          projectId: project.id,
        },
        {
          signal: c.req.raw.signal,
          ...(actor !== undefined ? { actor } : {}),
        },
      );
      return c.json(formatFeedbackFormResponse(c, created, 0), HTTP_CREATED);
    },
  );

export const feedbackFormsRouter = new Hono<AppEnv>()
  .get("/", async (c) => {
    assertFeedbackRole(c, "viewer");
    const projectId = c.req.query("projectId")?.trim();
    if (projectId !== undefined && projectId !== "") {
      if (!IdSchema.safeParse(projectId).success) {
        throw new NotFoundError("project", projectId);
      }
      const project = await c.get("storage").getProject(projectId);
      if (!project) {
        throw new NotFoundError("project", projectId);
      }
    }
    const store = createScopedFeedbackStore(c);
    const forms = await store.listForms(
      projectId !== undefined && projectId !== "" ? { projectId } : undefined,
      { signal: c.req.raw.signal },
    );
    const pendingCounts = await store.getPendingCountsByFormIds(
      forms.map((form) => form.id),
      { signal: c.req.raw.signal },
    );
    return c.json(
      forms.map((form) =>
        formatFeedbackFormResponse(c, form, pendingCounts.get(form.id) ?? 0),
      ),
    );
  })
  .post(
    "/",
    zValidator("json", CreateFeedbackFormInputSchema.omit({ orgId: true }), (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "validation_error", details: result.error.issues },
          HTTP_BAD_REQUEST,
        );
      }
      return undefined;
    }),
    async (c) => {
      assertFeedbackRole(c, "editor");
      const input = c.req.valid("json");
      const project = await c.get("storage").getProject(input.projectId);
      if (!project) {
        throw new NotFoundError("project", input.projectId);
      }
      const actor = resolveFeedbackActor(c);
      const store = createScopedFeedbackStore(c);
      const created = await store.createForm(
        {
          ...input,
          projectId: project.id,
        },
        {
          signal: c.req.raw.signal,
          ...(actor !== undefined ? { actor } : {}),
        },
      );
      return c.json(formatFeedbackFormResponse(c, created, 0), HTTP_CREATED);
    },
  )
  .get("/:id", async (c) => {
    assertFeedbackRole(c, "viewer");
    const id = c.req.param("id");
    if (!IdSchema.safeParse(id).success) {
      return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    }
    const store = createScopedFeedbackStore(c);
    const form = await store.getForm(id, { signal: c.req.raw.signal });
    if (!form) {
      return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    }
    const pendingCount = await store.getPendingCount(form.id, {
      signal: c.req.raw.signal,
    });
    return c.json(formatFeedbackFormResponse(c, form, pendingCount));
  })
  .patch(
    "/:id",
    zValidator("json", UpdateFeedbackFormInputSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          { error: "validation_error", details: result.error.issues },
          HTTP_BAD_REQUEST,
        );
      }
      return undefined;
    }),
    async (c) => {
      assertFeedbackRole(c, "editor");
      const id = c.req.param("id");
      if (!IdSchema.safeParse(id).success) {
        throw new NotFoundError("feedback_form", id);
      }
      const store = createScopedFeedbackStore(c);
      const updated = await store.updateForm(id, c.req.valid("json"), {
        signal: c.req.raw.signal,
      });
      const pendingCount = await store.getPendingCount(updated.id, {
        signal: c.req.raw.signal,
      });
      return c.json(formatFeedbackFormResponse(c, updated, pendingCount));
    },
  )
  .delete("/:id", async (c) => {
    assertFeedbackRole(c, "editor");
    const id = c.req.param("id");
    if (!IdSchema.safeParse(id).success) {
      throw new NotFoundError("feedback_form", id);
    }
    const store = createScopedFeedbackStore(c);
    await store.deleteForm(id, { signal: c.req.raw.signal });
    return c.body(null, HTTP_NO_CONTENT);
  })
  .post("/:id/rotate", async (c) => {
    assertFeedbackRole(c, "editor");
    const id = c.req.param("id");
    if (!IdSchema.safeParse(id).success) {
      throw new NotFoundError("feedback_form", id);
    }
    const store = createScopedFeedbackStore(c);
    const rotated = await store.rotatePublicId(id, {
      signal: c.req.raw.signal,
    });
    const pendingCount = await store.getPendingCount(rotated.id, {
      signal: c.req.raw.signal,
    });
    return c.json(formatFeedbackFormResponse(c, rotated, pendingCount));
  });

export const feedbackRouter = new Hono<AppEnv>()
  .route("/projects", projectFeedbackFormsRouter)
  .route("/feedback-forms", feedbackFormsRouter);
