import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  DEFAULT_ORGANISATION_ID,
  FEEDBACK_DUPLICATE_WINDOW_MS,
  FEEDBACK_PURGE_RETENTION_MS,
  FeedbackBlockedIpHashSchema,
  FeedbackEntryOutcomeSchema,
  FeedbackEntrySchema,
  FeedbackFieldsSchema,
  FeedbackFormSchema,
  FeedbackPublicIdSchema,
  IdSchema,
  NotFoundError,
  TaskActorSchema,
  ValidationError,
  applyFeedbackFormPatch,
  buildFeedbackEntry,
  buildFeedbackForm,
  cloneFeedbackEntry,
  cloneFeedbackForm,
  defaultRuntimeDeps,
  generateFeedbackPublicId,
  isFeedbackIpHashBlocked,
  parseOrThrow,
  throwIfAborted,
  toTimestamp,
  type CreateFeedbackEntryInput,
  type CreateFeedbackFormInput,
  type FeedbackEntry,
  type FeedbackEntryOutcome,
  type FeedbackForm,
  type OperationOptions,
  type RuntimeDeps,
  type UpdateFeedbackFormInput,
} from "@bitig/core";
import * as schema from "./schema";
import {
  feedbackEntries,
  feedbackForms,
  projects,
  tasks,
  type FeedbackEntryRecord,
  type FeedbackFormRecord,
  type InsertFeedbackEntryRecord,
  type InsertFeedbackFormRecord,
} from "./schema";

export interface D1FeedbackStoreOptions {
  readonly db: D1Database | DrizzleD1Database<typeof schema>;
  readonly orgId?: string | undefined;
  readonly deps?: RuntimeDeps | undefined;
}

export interface SetFeedbackEntryOutcomeOptions extends OperationOptions {
  readonly reviewedBy?: string | null | undefined;
  readonly reviewedAt?: Date | string | number | undefined;
  readonly clearTaskId?: boolean | undefined;
}

const PUBLIC_ID_COLLISION_MAX_RETRIES = 5;

function isD1Database(db: unknown): db is D1Database {
  return (
    typeof db === "object" &&
    db !== null &&
    "prepare" in db &&
    typeof db.prepare === "function"
  );
}

function isPublicIdConflict(err: unknown): boolean {
  for (
    let current: unknown = err, depth = 0;
    current instanceof Error && depth < 5;
    current = current.cause, depth++
  ) {
    const msg = current.message;
    if (
      msg.includes("UNIQUE constraint failed: feedback_forms.public_id") ||
      msg.includes("feedback_forms_public_id_unique")
    ) {
      return true;
    }
  }
  return false;
}

function throwCustomValidation(
  context: string,
  field: string,
  message: string,
  input: unknown,
): never {
  throw new ValidationError(context, [
    { code: "custom", path: [field], message, input },
  ]);
}

function recordToFeedbackForm(row: FeedbackFormRecord): FeedbackForm {
  const fields = FeedbackFieldsSchema.parse(row.fields);
  const form: FeedbackForm = {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    publicId: row.publicId,
    name: row.name,
    title: row.title,
    intro: row.intro,
    enabled: row.enabled,
    fields,
    allowedOrigins: Array.isArray(row.allowedOrigins) ? [...row.allowedOrigins] : [],
    turnstile: row.turnstile,
    thankYouText: row.thankYouText,
    submissionCount: row.submissionCount,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
  if (row.defaultLabels !== null && row.defaultLabels.length > 0) {
    form.defaultLabels = [...row.defaultLabels];
  }
  if (row.defaultPriority !== null) {
    form.defaultPriority = row.defaultPriority;
  }
  if (row.accentColor !== null) {
    form.accentColor = row.accentColor;
  }
  if (row.bannedWords !== null && row.bannedWords.length > 0) {
    form.bannedWords = [...row.bannedWords];
  }
  if (fields.blockedIpHashes !== undefined && fields.blockedIpHashes.length > 0) {
    form.blockedIpHashes = [...fields.blockedIpHashes];
  }
  if (row.lastSubmittedAt !== null) {
    form.lastSubmittedAt = new Date(row.lastSubmittedAt).toISOString();
  }
  if (row.createdBy !== null) {
    form.createdBy = row.createdBy;
  }
  return FeedbackFormSchema.parse(form);
}

function feedbackFormToRecord(form: FeedbackForm): InsertFeedbackFormRecord {
  const blockedIpHashes = form.blockedIpHashes ?? form.fields.blockedIpHashes;
  return {
    id: form.id,
    orgId: form.orgId,
    projectId: form.projectId,
    publicId: form.publicId,
    name: form.name,
    title: form.title,
    intro: form.intro,
    enabled: form.enabled,
    fields: {
      email: form.fields.email,
      name: form.fields.name,
      categories: [...form.fields.categories],
      ...(form.fields.bannedWords !== undefined && form.fields.bannedWords.length > 0
        ? { bannedWords: [...form.fields.bannedWords] }
        : {}),
      ...(blockedIpHashes !== undefined && blockedIpHashes.length > 0
        ? { blockedIpHashes: [...blockedIpHashes] }
        : {}),
    },
    allowedOrigins: [...form.allowedOrigins],
    turnstile: form.turnstile,
    defaultLabels:
      form.defaultLabels !== undefined && form.defaultLabels.length > 0
        ? [...form.defaultLabels]
        : null,
    defaultPriority: form.defaultPriority ?? null,
    thankYouText: form.thankYouText,
    accentColor: form.accentColor ?? null,
    bannedWords:
      form.bannedWords !== undefined && form.bannedWords.length > 0
        ? [...form.bannedWords]
        : null,
    submissionCount: form.submissionCount,
    lastSubmittedAt:
      form.lastSubmittedAt !== undefined ? Date.parse(form.lastSubmittedAt) : null,
    createdBy: form.createdBy ?? null,
    createdAt: Date.parse(form.createdAt),
    updatedAt: Date.parse(form.updatedAt),
  };
}

function recordToFeedbackEntry(row: FeedbackEntryRecord): FeedbackEntry {
  const entry: FeedbackEntry = {
    id: row.id,
    taskId: row.taskId,
    formId: row.formId,
    orgId: row.orgId,
    projectId: row.projectId,
    outcome: row.outcome,
    spamScore: row.spamScore,
    createdAt: new Date(row.createdAt).toISOString(),
  };
  if (row.category !== null) {
    entry.category = row.category;
  }
  if (row.submitterEmail !== null) {
    entry.submitterEmail = row.submitterEmail;
  }
  if (row.submitterName !== null) {
    entry.submitterName = row.submitterName;
  }
  if (row.pageUrl !== null) {
    entry.pageUrl = row.pageUrl;
  }
  if (row.ipHash !== null) {
    entry.ipHash = row.ipHash;
  }
  if (row.bodyHash !== null) {
    entry.bodyHash = row.bodyHash;
  }
  if (row.userAgent !== null) {
    entry.userAgent = row.userAgent;
  }
  if (row.reviewedBy !== null) {
    entry.reviewedBy = row.reviewedBy;
  }
  if (row.reviewedAt !== null) {
    entry.reviewedAt = new Date(row.reviewedAt).toISOString();
  }
  return FeedbackEntrySchema.parse(entry);
}

function feedbackEntryToRecord(entry: FeedbackEntry): InsertFeedbackEntryRecord {
  return {
    id: entry.id,
    taskId: entry.taskId,
    formId: entry.formId,
    orgId: entry.orgId,
    projectId: entry.projectId,
    outcome: entry.outcome,
    category: entry.category ?? null,
    submitterEmail: entry.submitterEmail ?? null,
    submitterName: entry.submitterName ?? null,
    pageUrl: entry.pageUrl ?? null,
    ipHash: entry.ipHash ?? null,
    bodyHash: entry.bodyHash ?? null,
    userAgent: entry.userAgent ?? null,
    spamScore: entry.spamScore,
    reviewedBy: entry.reviewedBy ?? null,
    reviewedAt: entry.reviewedAt !== undefined ? Date.parse(entry.reviewedAt) : null,
    createdAt: Date.parse(entry.createdAt),
  };
}

function compareFeedbackForms(a: FeedbackForm, b: FeedbackForm): number {
  return (
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)
  );
}

function compareFeedbackEntries(a: FeedbackEntry, b: FeedbackEntry): number {
  return (
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)
  );
}

/**
 * Resolves the owning organisation ID for a feedback form by its `publicId`,
 * mirroring `findWebhookOrgId` for unauthenticated public submissions.
 */
export async function findFormByPublicId(
  dbInput: D1Database | DrizzleD1Database<typeof schema>,
  publicId: string,
): Promise<string | null> {
  const parsed = FeedbackPublicIdSchema.safeParse(publicId);
  if (!parsed.success) return null;
  const db = isD1Database(dbInput) ? drizzle(dbInput, { schema }) : dbInput;
  const row = await db
    .select({ orgId: feedbackForms.orgId, projectOrgId: projects.orgId })
    .from(feedbackForms)
    .innerJoin(projects, eq(feedbackForms.projectId, projects.id))
    .where(eq(feedbackForms.publicId, parsed.data))
    .get();
  if (!row) return null;
  return row.projectOrgId || row.orgId || null;
}

export const findFeedbackFormOrgId = findFormByPublicId;

/**
 * Worker-only D1 store for project feedback forms (`feedback_forms`) and
 * submission metadata (`feedback_entries`). Scoped by organisation like
 * `D1Storage` and kept separate from `StorageProvider` so Markdown/CLI
 * adapters remain untouched (#BIT-175).
 */
export class D1FeedbackStore {
  readonly #db: DrizzleD1Database<typeof schema>;
  readonly #deps: RuntimeDeps;
  readonly #orgId: string;

  constructor(
    dbOrOptions:
      | D1Database
      | DrizzleD1Database<typeof schema>
      | D1FeedbackStoreOptions,
    orgIdOrDeps?: string | RuntimeDeps,
    maybeDeps?: RuntimeDeps,
  ) {
    if ("db" in dbOrOptions) {
      this.#db = isD1Database(dbOrOptions.db)
        ? drizzle(dbOrOptions.db, { schema })
        : dbOrOptions.db;
      this.#orgId =
        dbOrOptions.orgId !== undefined
          ? parseOrThrow(IdSchema, dbOrOptions.orgId, "D1FeedbackStore orgId")
          : DEFAULT_ORGANISATION_ID;
      this.#deps = dbOrOptions.deps ?? defaultRuntimeDeps;
    } else {
      this.#db = isD1Database(dbOrOptions)
        ? drizzle(dbOrOptions, { schema })
        : dbOrOptions;
      if (typeof orgIdOrDeps === "string") {
        this.#orgId = parseOrThrow(IdSchema, orgIdOrDeps, "D1FeedbackStore orgId");
        this.#deps = maybeDeps ?? defaultRuntimeDeps;
      } else {
        this.#orgId = DEFAULT_ORGANISATION_ID;
        this.#deps = orgIdOrDeps ?? maybeDeps ?? defaultRuntimeDeps;
      }
    }
  }

  get orgId(): string {
    return this.#orgId;
  }

  #resolveOrgId(orgId?: string, context = "D1FeedbackStore orgId"): string {
    if (orgId === undefined) return this.#orgId;
    return parseOrThrow(IdSchema, orgId, context);
  }

  #generateDistinctPublicId(avoidPublicId?: string, attempt = 0): string {
    const raw = this.#deps.generateId().replaceAll("-", "");
    // Combine prefix + suffix of the 32-char UUID hex so both random UUIDv7
    // and sequential test ID generators (which increment the last 12 chars)
    // yield distinct 24-char URL-safe public IDs.
    let candidate =
      raw.length >= 24 ? `${raw.slice(0, 12)}${raw.slice(-12)}` : generateFeedbackPublicId(this.#deps);
    if (avoidPublicId !== undefined && candidate === avoidPublicId) {
      const suffix = (attempt + 1).toString(36).padStart(2, "0");
      candidate = `${candidate.slice(0, Math.max(16, candidate.length - suffix.length))}${suffix}`;
    }
    return candidate;
  }

  // ---------------------------------------------------------------------------
  // Public ID Lookup
  // ---------------------------------------------------------------------------

  async findFormByPublicId(
    publicId: string,
    opts?: OperationOptions,
  ): Promise<string | null> {
    throwIfAborted(opts?.signal);
    const parsed = FeedbackPublicIdSchema.safeParse(publicId);
    if (!parsed.success) return null;
    const row = await this.#db
      .select({ orgId: feedbackForms.orgId, projectOrgId: projects.orgId })
      .from(feedbackForms)
      .innerJoin(projects, eq(feedbackForms.projectId, projects.id))
      .where(eq(feedbackForms.publicId, parsed.data))
      .get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    return row.projectOrgId || row.orgId || null;
  }

  async findFormOrgId(
    publicId: string,
    opts?: OperationOptions,
  ): Promise<string | null> {
    return this.findFormByPublicId(publicId, opts);
  }

  // ---------------------------------------------------------------------------
  // Form CRUD (scoped by organisation)
  // ---------------------------------------------------------------------------

  async createForm(
    input: CreateFeedbackFormInput,
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm> {
    const opts = typeof orgIdOrOpts === "string" ? maybeOpts : orgIdOrOpts;
    throwIfAborted(opts?.signal);
    const targetOrgId = this.#resolveOrgId(
      typeof orgIdOrOpts === "string" ? orgIdOrOpts : input.orgId,
      "createFeedbackForm orgId",
    );

    if (input.orgId !== undefined && input.orgId !== targetOrgId) {
      throwCustomValidation(
        "createFeedbackForm",
        "orgId",
        "input.orgId does not match target organisation",
        input.orgId,
      );
    }

    const validProjectId = parseOrThrow(
      IdSchema,
      input.projectId,
      "createFeedbackForm projectId",
    );
    const projectRow = await this.#db
      .select({ id: projects.id, orgId: projects.orgId })
      .from(projects)
      .where(and(eq(projects.id, validProjectId), eq(projects.orgId, targetOrgId)))
      .get();
    throwIfAborted(opts?.signal);
    if (!projectRow) {
      throw new NotFoundError("project", validProjectId);
    }

    const explicitPublicId = input.publicId !== undefined;
    let form = buildFeedbackForm(
      {
        ...input,
        orgId: targetOrgId,
        ...(explicitPublicId
          ? {}
          : { publicId: this.#generateDistinctPublicId() }),
        ...(opts?.actor !== undefined && input.createdBy === undefined
          ? { createdBy: opts.actor }
          : {}),
      },
      targetOrgId,
      this.#deps,
    );

    for (let attempt = 0; ; attempt++) {
      try {
        await this.#db.insert(feedbackForms).values(feedbackFormToRecord(form));
        throwIfAborted(opts?.signal);
        return cloneFeedbackForm(form);
      } catch (err) {
        if (!isPublicIdConflict(err)) throw err;
        if (explicitPublicId || attempt >= PUBLIC_ID_COLLISION_MAX_RETRIES) {
          throwCustomValidation(
            "createFeedbackForm",
            "publicId",
            "publicId is already in use",
            form.publicId,
          );
        }
        form = {
          ...form,
          publicId: this.#generateDistinctPublicId(form.publicId, attempt + 1),
        };
      }
    }
  }

  async create(
    input: CreateFeedbackFormInput,
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm> {
    return this.createForm(input, orgIdOrOpts, maybeOpts);
  }

  async getForm(
    id: string,
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm | null> {
    const opts = typeof orgIdOrOpts === "string" ? maybeOpts : orgIdOrOpts;
    throwIfAborted(opts?.signal);
    const targetOrgId = this.#resolveOrgId(
      typeof orgIdOrOpts === "string" ? orgIdOrOpts : undefined,
      "getFeedbackForm orgId",
    );
    const validId = parseOrThrow(IdSchema, id, "getFeedbackForm");
    const row = await this.#db
      .select()
      .from(feedbackForms)
      .where(and(eq(feedbackForms.id, validId), eq(feedbackForms.orgId, targetOrgId)))
      .get();
    throwIfAborted(opts?.signal);
    return row ? cloneFeedbackForm(recordToFeedbackForm(row)) : null;
  }

  async getFormById(
    id: string,
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm | null> {
    return this.getForm(id, orgIdOrOpts, maybeOpts);
  }

  async getById(
    id: string,
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm | null> {
    return this.getForm(id, orgIdOrOpts, maybeOpts);
  }

  async getFormByPublicId(
    publicId: string,
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm | null> {
    const opts = typeof orgIdOrOpts === "string" ? maybeOpts : orgIdOrOpts;
    throwIfAborted(opts?.signal);
    const targetOrgId = this.#resolveOrgId(
      typeof orgIdOrOpts === "string" ? orgIdOrOpts : undefined,
      "getFeedbackFormByPublicId orgId",
    );
    const parsed = FeedbackPublicIdSchema.safeParse(publicId);
    if (!parsed.success) return null;
    const row = await this.#db
      .select()
      .from(feedbackForms)
      .where(
        and(
          eq(feedbackForms.publicId, parsed.data),
          eq(feedbackForms.orgId, targetOrgId),
        ),
      )
      .get();
    throwIfAborted(opts?.signal);
    return row ? cloneFeedbackForm(recordToFeedbackForm(row)) : null;
  }

  async getByPublicId(
    publicId: string,
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm | null> {
    return this.getFormByPublicId(publicId, orgIdOrOpts, maybeOpts);
  }

  async listForms(
    filterOrProjectId?: string | { projectId?: string | undefined; orgId?: string | undefined },
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm[]> {
    const opts = typeof orgIdOrOpts === "string" ? maybeOpts : orgIdOrOpts;
    throwIfAborted(opts?.signal);

    const explicitOrgId =
      typeof orgIdOrOpts === "string"
        ? orgIdOrOpts
        : typeof filterOrProjectId === "object"
          ? filterOrProjectId.orgId
          : undefined;
    const targetOrgId = this.#resolveOrgId(explicitOrgId, "listFeedbackForms orgId");

    const projectId =
      typeof filterOrProjectId === "string"
        ? filterOrProjectId
        : filterOrProjectId?.projectId;

    let rows: FeedbackFormRecord[];
    if (projectId !== undefined) {
      const validProjectId = parseOrThrow(
        IdSchema,
        projectId,
        "listFeedbackForms projectId",
      );
      rows = await this.#db
        .select()
        .from(feedbackForms)
        .where(
          and(
            eq(feedbackForms.orgId, targetOrgId),
            eq(feedbackForms.projectId, validProjectId),
          ),
        )
        .all();
    } else {
      rows = await this.#db
        .select()
        .from(feedbackForms)
        .where(eq(feedbackForms.orgId, targetOrgId))
        .all();
    }
    throwIfAborted(opts?.signal);
    return rows
      .map(recordToFeedbackForm)
      .sort(compareFeedbackForms)
      .map(cloneFeedbackForm);
  }

  async getForms(
    filterOrProjectId?: string | { projectId?: string | undefined; orgId?: string | undefined },
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm[]> {
    return this.listForms(filterOrProjectId, orgIdOrOpts, maybeOpts);
  }

  async listFormsByProject(
    projectId: string,
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm[]> {
    return this.listForms(projectId, orgIdOrOpts, maybeOpts);
  }

  async updateForm(
    id: string,
    patch: UpdateFeedbackFormInput,
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm> {
    const opts = typeof orgIdOrOpts === "string" ? maybeOpts : orgIdOrOpts;
    throwIfAborted(opts?.signal);
    const targetOrgId = this.#resolveOrgId(
      typeof orgIdOrOpts === "string" ? orgIdOrOpts : undefined,
      "updateFeedbackForm orgId",
    );
    const validId = parseOrThrow(IdSchema, id, "updateFeedbackForm");
    const existingRow = await this.#db
      .select()
      .from(feedbackForms)
      .where(and(eq(feedbackForms.id, validId), eq(feedbackForms.orgId, targetOrgId)))
      .get();
    throwIfAborted(opts?.signal);
    if (!existingRow) {
      throw new NotFoundError("feedback_form", validId);
    }

    const existing = recordToFeedbackForm(existingRow);
    const next = applyFeedbackFormPatch(existing, patch, this.#deps.clock());
    await this.#db
      .update(feedbackForms)
      .set(feedbackFormToRecord(next))
      .where(and(eq(feedbackForms.id, validId), eq(feedbackForms.orgId, targetOrgId)));
    throwIfAborted(opts?.signal);
    return cloneFeedbackForm(next);
  }

  async update(
    id: string,
    patch: UpdateFeedbackFormInput,
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm> {
    return this.updateForm(id, patch, orgIdOrOpts, maybeOpts);
  }

  async deleteForm(
    id: string,
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<void> {
    const opts = typeof orgIdOrOpts === "string" ? maybeOpts : orgIdOrOpts;
    throwIfAborted(opts?.signal);
    const targetOrgId = this.#resolveOrgId(
      typeof orgIdOrOpts === "string" ? orgIdOrOpts : undefined,
      "deleteFeedbackForm orgId",
    );
    const validId = parseOrThrow(IdSchema, id, "deleteFeedbackForm");
    const existingRow = await this.#db
      .select({ id: feedbackForms.id })
      .from(feedbackForms)
      .where(and(eq(feedbackForms.id, validId), eq(feedbackForms.orgId, targetOrgId)))
      .get();
    throwIfAborted(opts?.signal);
    if (!existingRow) {
      throw new NotFoundError("feedback_form", validId);
    }

    await this.#db
      .delete(feedbackEntries)
      .where(
        and(eq(feedbackEntries.formId, validId), eq(feedbackEntries.orgId, targetOrgId)),
      );
    await this.#db
      .delete(feedbackForms)
      .where(and(eq(feedbackForms.id, validId), eq(feedbackForms.orgId, targetOrgId)));
    throwIfAborted(opts?.signal);
  }

  async delete(
    id: string,
    orgIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<void> {
    return this.deleteForm(id, orgIdOrOpts, maybeOpts);
  }

  async rotatePublicId(
    id: string,
    newPublicIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm> {
    const explicitPublicId =
      typeof newPublicIdOrOpts === "string" ? newPublicIdOrOpts : undefined;
    const opts =
      typeof newPublicIdOrOpts === "string" ? maybeOpts : newPublicIdOrOpts;
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "rotateFeedbackFormPublicId");

    const existingRow = await this.#db
      .select()
      .from(feedbackForms)
      .where(
        and(eq(feedbackForms.id, validId), eq(feedbackForms.orgId, this.#orgId)),
      )
      .get();
    throwIfAborted(opts?.signal);
    if (!existingRow) {
      throw new NotFoundError("feedback_form", validId);
    }

    const existing = recordToFeedbackForm(existingRow);
    const candidateTime = toTimestamp(this.#deps.clock());
    const updatedAt =
      Date.parse(candidateTime) >= Date.parse(existing.updatedAt)
        ? candidateTime
        : existing.updatedAt;

    for (let attempt = 0; ; attempt++) {
      const nextPublicId =
        explicitPublicId !== undefined
          ? parseOrThrow(
              FeedbackPublicIdSchema,
              explicitPublicId,
              "rotateFeedbackFormPublicId publicId",
            )
          : this.#generateDistinctPublicId(existing.publicId, attempt);

      const next: FeedbackForm = parseOrThrow(
        FeedbackFormSchema,
        {
          ...existing,
          publicId: nextPublicId,
          updatedAt,
        },
        "rotateFeedbackFormPublicId result",
      );

      try {
        await this.#db
          .update(feedbackForms)
          .set({
            publicId: next.publicId,
            updatedAt: Date.parse(next.updatedAt),
          })
          .where(
            and(eq(feedbackForms.id, validId), eq(feedbackForms.orgId, this.#orgId)),
          );
        throwIfAborted(opts?.signal);
        return cloneFeedbackForm(next);
      } catch (err) {
        if (!isPublicIdConflict(err)) throw err;
        if (
          explicitPublicId !== undefined ||
          attempt >= PUBLIC_ID_COLLISION_MAX_RETRIES
        ) {
          throwCustomValidation(
            "rotateFeedbackFormPublicId",
            "publicId",
            "publicId is already in use",
            nextPublicId,
          );
        }
      }
    }
  }

  async rotateFormPublicId(
    id: string,
    newPublicIdOrOpts?: string | OperationOptions,
    maybeOpts?: OperationOptions,
  ): Promise<FeedbackForm> {
    return this.rotatePublicId(id, newPublicIdOrOpts, maybeOpts);
  }

  async recordFormSubmission(
    id: string,
    opts?: OperationOptions,
  ): Promise<FeedbackForm> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "recordFeedbackSubmission");
    const existingRow = await this.#db
      .select()
      .from(feedbackForms)
      .where(
        and(eq(feedbackForms.id, validId), eq(feedbackForms.orgId, this.#orgId)),
      )
      .get();
    throwIfAborted(opts?.signal);
    if (!existingRow) {
      throw new NotFoundError("feedback_form", validId);
    }

    const nowMs = this.#deps.clock().getTime();
    const updatedRows = await this.#db
      .update(feedbackForms)
      .set({
        submissionCount: sql`${feedbackForms.submissionCount} + 1`,
        lastSubmittedAt: nowMs,
        updatedAt: Math.max(nowMs, existingRow.updatedAt),
      })
      .where(
        and(eq(feedbackForms.id, validId), eq(feedbackForms.orgId, this.#orgId)),
      )
      .returning();
    throwIfAborted(opts?.signal);
    const updated = updatedRows[0];
    if (!updated) {
      throw new NotFoundError("feedback_form", validId);
    }
    return cloneFeedbackForm(recordToFeedbackForm(updated));
  }

  async recordSubmission(
    id: string,
    opts?: OperationOptions,
  ): Promise<FeedbackForm> {
    return this.recordFormSubmission(id, opts);
  }

  /**
   * Blocks an `ipHash` on the given form (idempotent).
   */
  async blockIpHash(
    formId: string,
    ipHash: string,
    opts?: OperationOptions,
  ): Promise<FeedbackForm> {
    throwIfAborted(opts?.signal);
    const validFormId = parseOrThrow(IdSchema, formId, "blockFeedbackIpHash formId");
    const validIpHash = parseOrThrow(
      FeedbackBlockedIpHashSchema,
      ipHash,
      "blockFeedbackIpHash ipHash",
    );
    const form = await this.getForm(validFormId, opts);
    if (!form) {
      throw new NotFoundError("feedback_form", validFormId);
    }
    const existing = form.blockedIpHashes ?? form.fields.blockedIpHashes ?? [];
    if (existing.includes(validIpHash)) {
      return form;
    }
    return this.updateForm(
      validFormId,
      { blockedIpHashes: [...existing, validIpHash] },
      opts,
    );
  }

  /**
   * Unblocks an `ipHash` on the given form (idempotent).
   */
  async unblockIpHash(
    formId: string,
    ipHash: string,
    opts?: OperationOptions,
  ): Promise<FeedbackForm> {
    throwIfAborted(opts?.signal);
    const validFormId = parseOrThrow(IdSchema, formId, "unblockFeedbackIpHash formId");
    const trimmed = ipHash.trim().toLowerCase();
    const form = await this.getForm(validFormId, opts);
    if (!form) {
      throw new NotFoundError("feedback_form", validFormId);
    }
    const existing = form.blockedIpHashes ?? form.fields.blockedIpHashes ?? [];
    if (!existing.some((h) => h.toLowerCase() === trimmed)) {
      return form;
    }
    const next = existing.filter((h) => h.toLowerCase() !== trimmed);
    return this.updateForm(
      validFormId,
      { blockedIpHashes: next.length > 0 ? next : null },
      opts,
    );
  }

  /**
   * Checks whether an `ipHash` is blocked on the given form.
   */
  async isIpHashBlocked(
    formId: string,
    ipHash: string,
    opts?: OperationOptions,
  ): Promise<boolean> {
    throwIfAborted(opts?.signal);
    const trimmed = ipHash.trim();
    if (trimmed.length === 0) return false;
    const form = await this.getForm(formId, opts);
    if (!form) return false;
    return isFeedbackIpHashBlocked(form, trimmed);
  }

  // ---------------------------------------------------------------------------
  // Feedback Entries
  // ---------------------------------------------------------------------------

  async createEntry(
    input: Omit<CreateFeedbackEntryInput, "orgId" | "projectId"> & {
      orgId?: string | undefined;
      projectId?: string | undefined;
    },
    opts?: OperationOptions,
  ): Promise<FeedbackEntry> {
    throwIfAborted(opts?.signal);
    const validFormId = parseOrThrow(
      IdSchema,
      input.formId,
      "createFeedbackEntry formId",
    );
    const targetOrgId = this.#resolveOrgId(input.orgId, "createFeedbackEntry orgId");
    if (input.orgId !== undefined && input.orgId !== this.#orgId) {
      throw new NotFoundError("feedback_form", validFormId);
    }

    const formRow = await this.#db
      .select()
      .from(feedbackForms)
      .where(
        and(
          eq(feedbackForms.id, validFormId),
          eq(feedbackForms.orgId, targetOrgId),
        ),
      )
      .get();
    throwIfAborted(opts?.signal);
    if (!formRow) {
      throw new NotFoundError("feedback_form", validFormId);
    }

    const projectId = input.projectId ?? formRow.projectId;
    if (projectId !== formRow.projectId) {
      throwCustomValidation(
        "createFeedbackEntry",
        "projectId",
        "entry projectId must match the form's projectId",
        projectId,
      );
    }

    if (input.taskId !== undefined && input.taskId !== null) {
      const validTaskId = parseOrThrow(
        IdSchema,
        input.taskId,
        "createFeedbackEntry taskId",
      );
      const taskRow = await this.#db
        .select({ id: tasks.id, projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, validTaskId))
        .get();
      throwIfAborted(opts?.signal);
      if (taskRow?.projectId !== formRow.projectId) {
        throw new NotFoundError("task", validTaskId);
      }
    }

    const entry = buildFeedbackEntry(
      {
        ...input,
        orgId: targetOrgId,
        projectId: formRow.projectId,
      },
      this.#deps,
    );

    await this.#db.insert(feedbackEntries).values(feedbackEntryToRecord(entry));
    throwIfAborted(opts?.signal);
    return cloneFeedbackEntry(entry);
  }

  async getEntry(
    id: string,
    opts?: OperationOptions,
  ): Promise<FeedbackEntry | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getFeedbackEntry");
    const row = await this.#db
      .select()
      .from(feedbackEntries)
      .where(
        and(eq(feedbackEntries.id, validId), eq(feedbackEntries.orgId, this.#orgId)),
      )
      .get();
    throwIfAborted(opts?.signal);
    return row ? cloneFeedbackEntry(recordToFeedbackEntry(row)) : null;
  }

  async getEntryById(
    id: string,
    opts?: OperationOptions,
  ): Promise<FeedbackEntry | null> {
    return this.getEntry(id, opts);
  }

  async getEntryByTaskId(
    taskId: string,
    opts?: OperationOptions,
  ): Promise<FeedbackEntry | null> {
    throwIfAborted(opts?.signal);
    const validTaskId = parseOrThrow(IdSchema, taskId, "getFeedbackEntryByTaskId");
    const row = await this.#db
      .select()
      .from(feedbackEntries)
      .where(
        and(
          eq(feedbackEntries.taskId, validTaskId),
          eq(feedbackEntries.orgId, this.#orgId),
        ),
      )
      .get();
    throwIfAborted(opts?.signal);
    return row ? cloneFeedbackEntry(recordToFeedbackEntry(row)) : null;
  }

  async getEntryByTask(
    taskId: string,
    opts?: OperationOptions,
  ): Promise<FeedbackEntry | null> {
    return this.getEntryByTaskId(taskId, opts);
  }

  async listEntries(
    filter?: {
      formId?: string | undefined;
      projectId?: string | undefined;
      outcome?: FeedbackEntryOutcome | undefined;
    },
    opts?: OperationOptions,
  ): Promise<FeedbackEntry[]> {
    throwIfAborted(opts?.signal);
    const conditions = [eq(feedbackEntries.orgId, this.#orgId)];

    if (filter?.formId !== undefined) {
      const validFormId = parseOrThrow(
        IdSchema,
        filter.formId,
        "listFeedbackEntries formId",
      );
      conditions.push(eq(feedbackEntries.formId, validFormId));
    }
    if (filter?.projectId !== undefined) {
      const validProjectId = parseOrThrow(
        IdSchema,
        filter.projectId,
        "listFeedbackEntries projectId",
      );
      conditions.push(eq(feedbackEntries.projectId, validProjectId));
    }
    if (filter?.outcome !== undefined) {
      const validOutcome = parseOrThrow(
        FeedbackEntryOutcomeSchema,
        filter.outcome,
        "listFeedbackEntries outcome",
      );
      conditions.push(eq(feedbackEntries.outcome, validOutcome));
    }

    const rows = await this.#db
      .select()
      .from(feedbackEntries)
      .where(and(...conditions))
      .all();
    throwIfAborted(opts?.signal);
    return rows
      .map(recordToFeedbackEntry)
      .sort(compareFeedbackEntries)
      .map(cloneFeedbackEntry);
  }

  async setEntryOutcome(
    id: string,
    outcome: FeedbackEntryOutcome,
    options?: SetFeedbackEntryOutcomeOptions,
  ): Promise<FeedbackEntry> {
    throwIfAborted(options?.signal);
    const validId = parseOrThrow(IdSchema, id, "setFeedbackEntryOutcome");
    const validOutcome = parseOrThrow(
      FeedbackEntryOutcomeSchema,
      outcome,
      "setFeedbackEntryOutcome outcome",
    );

    const existingRow = await this.#db
      .select()
      .from(feedbackEntries)
      .where(
        and(eq(feedbackEntries.id, validId), eq(feedbackEntries.orgId, this.#orgId)),
      )
      .get();
    throwIfAborted(options?.signal);
    if (!existingRow) {
      throw new NotFoundError("feedback_entry", validId);
    }

    return this.#applyEntryOutcomeUpdate(existingRow, validOutcome, options);
  }

  async setOutcome(
    id: string,
    outcome: FeedbackEntryOutcome,
    options?: SetFeedbackEntryOutcomeOptions,
  ): Promise<FeedbackEntry> {
    return this.setEntryOutcome(id, outcome, options);
  }

  async setEntryOutcomeByTaskId(
    taskId: string,
    outcome: FeedbackEntryOutcome,
    options?: SetFeedbackEntryOutcomeOptions,
  ): Promise<FeedbackEntry> {
    throwIfAborted(options?.signal);
    const validTaskId = parseOrThrow(
      IdSchema,
      taskId,
      "setFeedbackEntryOutcomeByTaskId",
    );
    const validOutcome = parseOrThrow(
      FeedbackEntryOutcomeSchema,
      outcome,
      "setFeedbackEntryOutcomeByTaskId outcome",
    );

    const existingRow = await this.#db
      .select()
      .from(feedbackEntries)
      .where(
        and(
          eq(feedbackEntries.taskId, validTaskId),
          eq(feedbackEntries.orgId, this.#orgId),
        ),
      )
      .get();
    throwIfAborted(options?.signal);
    if (!existingRow) {
      throw new NotFoundError("feedback_entry", validTaskId);
    }

    return this.#applyEntryOutcomeUpdate(existingRow, validOutcome, options);
  }

  async setEntryOutcomeByTask(
    taskId: string,
    outcome: FeedbackEntryOutcome,
    options?: SetFeedbackEntryOutcomeOptions,
  ): Promise<FeedbackEntry> {
    return this.setEntryOutcomeByTaskId(taskId, outcome, options);
  }

  async #applyEntryOutcomeUpdate(
    existingRow: FeedbackEntryRecord,
    outcome: FeedbackEntryOutcome,
    options?: SetFeedbackEntryOutcomeOptions,
  ): Promise<FeedbackEntry> {
    const rawReviewer =
      options?.reviewedBy !== undefined ? options.reviewedBy : options?.actor;
    const reviewedBy =
      rawReviewer === undefined
        ? existingRow.reviewedBy
        : rawReviewer === null
          ? null
          : parseOrThrow(
              TaskActorSchema,
              rawReviewer,
              "setFeedbackEntryOutcome reviewedBy",
            );

    let reviewedAtMs: number | null;
    if (options?.reviewedAt !== undefined) {
      reviewedAtMs =
        typeof options.reviewedAt === "number"
          ? options.reviewedAt
          : options.reviewedAt instanceof Date
            ? options.reviewedAt.getTime()
            : Date.parse(toTimestamp(new Date(options.reviewedAt)));
    } else if (outcome === "pending") {
      reviewedAtMs = null;
    } else {
      reviewedAtMs = this.#deps.clock().getTime();
    }

    const nextTaskId = options?.clearTaskId === true ? null : existingRow.taskId;

    await this.#db
      .update(feedbackEntries)
      .set({
        outcome,
        reviewedBy: outcome === "pending" && options?.reviewedBy === undefined ? null : reviewedBy,
        reviewedAt: reviewedAtMs,
        taskId: nextTaskId,
      })
      .where(
        and(
          eq(feedbackEntries.id, existingRow.id),
          eq(feedbackEntries.orgId, this.#orgId),
        ),
      );
    throwIfAborted(options?.signal);

    const updatedRecord: FeedbackEntryRecord = {
      ...existingRow,
      outcome,
      reviewedBy:
        outcome === "pending" && options?.reviewedBy === undefined
          ? null
          : reviewedBy,
      reviewedAt: reviewedAtMs,
      taskId: nextTaskId,
    };
    return cloneFeedbackEntry(recordToFeedbackEntry(updatedRecord));
  }

  // ---------------------------------------------------------------------------
  // Counts, Duplicate Lookup & Purge
  // ---------------------------------------------------------------------------

  async getPendingCount(
    formId: string,
    opts?: OperationOptions,
  ): Promise<number> {
    throwIfAborted(opts?.signal);
    const validFormId = parseOrThrow(IdSchema, formId, "getFeedbackPendingCount");
    const row = await this.#db
      .select({ total: count() })
      .from(feedbackEntries)
      .where(
        and(
          eq(feedbackEntries.formId, validFormId),
          eq(feedbackEntries.orgId, this.#orgId),
          eq(feedbackEntries.outcome, "pending"),
        ),
      )
      .get();
    throwIfAborted(opts?.signal);
    return row?.total ?? 0;
  }

  async countPendingForForm(
    formId: string,
    opts?: OperationOptions,
  ): Promise<number> {
    return this.getPendingCount(formId, opts);
  }

  async getPendingCountsByFormIds(
    formIds?: readonly string[],
    opts?: OperationOptions,
  ): Promise<Map<string, number>> {
    throwIfAborted(opts?.signal);
    if (formIds?.length === 0) {
      return new Map();
    }
    const validFormIds = formIds?.map((id) =>
      parseOrThrow(IdSchema, id, "getPendingCountsByFormIds"),
    );

    const conditions = [
      eq(feedbackEntries.orgId, this.#orgId),
      eq(feedbackEntries.outcome, "pending"),
    ];
    if (validFormIds !== undefined) {
      conditions.push(inArray(feedbackEntries.formId, validFormIds));
    }

    const rows = await this.#db
      .select({ formId: feedbackEntries.formId, total: count() })
      .from(feedbackEntries)
      .where(and(...conditions))
      .groupBy(feedbackEntries.formId)
      .all();
    throwIfAborted(opts?.signal);

    const counts = new Map<string, number>();
    if (validFormIds !== undefined) {
      for (const formId of validFormIds) {
        counts.set(formId, 0);
      }
    }
    for (const row of rows) {
      counts.set(row.formId, row.total);
    }
    return counts;
  }

  async findDuplicateEntry(
    input: {
      formId?: string | undefined;
      ipHash: string;
      bodyHash: string;
      windowMs?: number | undefined;
      now?: Date | number | string | undefined;
    },
    opts?: OperationOptions,
  ): Promise<FeedbackEntry | null> {
    throwIfAborted(opts?.signal);
    const ipHash = input.ipHash.trim();
    const bodyHash = input.bodyHash.trim();
    if (ipHash.length === 0 || bodyHash.length === 0) {
      return null;
    }

    const nowMs =
      input.now === undefined
        ? this.#deps.clock().getTime()
        : typeof input.now === "number"
          ? input.now
          : input.now instanceof Date
            ? input.now.getTime()
            : Date.parse(input.now);
    const windowMs = input.windowMs ?? FEEDBACK_DUPLICATE_WINDOW_MS;
    const cutoffMs = nowMs - windowMs;

    const conditions = [
      eq(feedbackEntries.orgId, this.#orgId),
      eq(feedbackEntries.ipHash, ipHash),
      eq(feedbackEntries.bodyHash, bodyHash),
      gte(feedbackEntries.createdAt, cutoffMs),
    ];
    if (input.formId !== undefined) {
      const validFormId = parseOrThrow(
        IdSchema,
        input.formId,
        "findDuplicateFeedbackEntry formId",
      );
      conditions.push(eq(feedbackEntries.formId, validFormId));
    }

    const row = await this.#db
      .select()
      .from(feedbackEntries)
      .where(and(...conditions))
      .get();
    throwIfAborted(opts?.signal);
    return row ? cloneFeedbackEntry(recordToFeedbackEntry(row)) : null;
  }

  async hasDuplicateEntry(
    input: {
      formId?: string | undefined;
      ipHash: string;
      bodyHash: string;
      windowMs?: number | undefined;
      now?: Date | number | string | undefined;
    },
    opts?: OperationOptions,
  ): Promise<boolean> {
    return (await this.findDuplicateEntry(input, opts)) !== null;
  }

  async findDuplicate(
    formId: string,
    ipHash: string,
    bodyHash: string,
    windowMs?: number,
    opts?: OperationOptions,
  ): Promise<FeedbackEntry | null> {
    return this.findDuplicateEntry(
      { formId, ipHash, bodyHash, windowMs },
      opts,
    );
  }

  /**
   * Purges `rejected` and `spam` feedback entries older than `retentionMs`
   * (defaults to `FEEDBACK_PURGE_RETENTION_MS`, i.e. 30 days).
   * Returns the number of deleted rows.
   */
  async purgeExpiredEntries(
    options?: {
      now?: Date | number | string | undefined;
      retentionMs?: number | undefined;
      allOrganisations?: boolean | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<number> {
    throwIfAborted(options?.signal);
    const nowMs =
      options?.now === undefined
        ? this.#deps.clock().getTime()
        : typeof options.now === "number"
          ? options.now
          : options.now instanceof Date
            ? options.now.getTime()
            : Date.parse(options.now);
    const retentionMs = options?.retentionMs ?? FEEDBACK_PURGE_RETENTION_MS;
    const cutoffMs = nowMs - retentionMs;

    const conditions = [
      inArray(feedbackEntries.outcome, ["rejected", "spam"]),
      lt(feedbackEntries.createdAt, cutoffMs),
    ];
    if (options?.allOrganisations === false) {
      conditions.push(eq(feedbackEntries.orgId, this.#orgId));
    }

    const deleted = await this.#db
      .delete(feedbackEntries)
      .where(and(...conditions))
      .returning({ id: feedbackEntries.id });
    throwIfAborted(options?.signal);
    return deleted.length;
  }

  async purgeRejectedAndSpamEntries(
    options?: {
      now?: Date | number | string | undefined;
      retentionMs?: number | undefined;
      allOrganisations?: boolean | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<number> {
    return this.purgeExpiredEntries(options);
  }
}
