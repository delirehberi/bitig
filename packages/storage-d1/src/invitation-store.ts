import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  defaultRuntimeDeps,
  normalizeEmail,
  throwIfAborted,
  type OperationOptions,
  type OrganisationRole,
  type RuntimeDeps,
} from "@bitig/core";
import * as schema from "./schema";
import { invitations, organisations, type InvitationRecord } from "./schema";

export const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InvitationInfo {
  id: string;
  orgId: string;
  email: string;
  role: OrganisationRole;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string | undefined;
  revokedAt?: string | undefined;
}

export interface InvitationWithOrg extends InvitationInfo {
  orgName: string;
  orgSlug: string;
}

export interface CreateInvitationRecordInput {
  orgId: string;
  email: string;
  role: OrganisationRole;
  tokenHash: string;
  invitedBy: string;
  ttlMs?: number | undefined;
}

function isD1Database(db: unknown): db is D1Database {
  return typeof db === "object" && db !== null && "prepare" in db && typeof db.prepare === "function";
}

function recordToInvitation(row: InvitationRecord): InvitationInfo {
  const info: InvitationInfo = {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedBy,
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
  if (row.acceptedAt !== null) {
    info.acceptedAt = new Date(row.acceptedAt).toISOString();
  }
  if (row.revokedAt !== null) {
    info.revokedAt = new Date(row.revokedAt).toISOString();
  }
  return info;
}

export class D1InvitationStore {
  readonly #db: DrizzleD1Database<typeof schema>;
  readonly #deps: RuntimeDeps;

  constructor(db: D1Database | DrizzleD1Database<typeof schema>, deps: RuntimeDeps = defaultRuntimeDeps) {
    this.#db = isD1Database(db) ? drizzle(db, { schema }) : db;
    this.#deps = deps;
  }

  async create(input: CreateInvitationRecordInput, opts?: OperationOptions): Promise<InvitationInfo> {
    throwIfAborted(opts?.signal);
    const email = normalizeEmail(input.email);
    const nowMs = this.#deps.clock().getTime();
    const ttlMs = input.ttlMs ?? DEFAULT_INVITATION_TTL_MS;

    // Revoke any existing pending invitations for the same email in this org
    await this.#db
      .update(invitations)
      .set({ revokedAt: nowMs })
      .where(
        and(
          eq(invitations.orgId, input.orgId),
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );

    const row: InvitationRecord = {
      id: this.#deps.generateId(),
      orgId: input.orgId,
      email,
      role: input.role,
      tokenHash: input.tokenHash,
      invitedBy: input.invitedBy,
      createdAt: nowMs,
      expiresAt: nowMs + ttlMs,
      acceptedAt: null,
      revokedAt: null,
    };
    await this.#db.insert(invitations).values(row);
    throwIfAborted(opts?.signal);
    return recordToInvitation(row);
  }

  async getByTokenHash(tokenHash: string, opts?: OperationOptions): Promise<InvitationWithOrg | null> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    const row = await this.#db
      .select({
        invitation: invitations,
        orgName: organisations.name,
        orgSlug: organisations.slug,
      })
      .from(invitations)
      .innerJoin(organisations, eq(invitations.orgId, organisations.id))
      .where(
        and(
          eq(invitations.tokenHash, tokenHash),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, nowMs),
        ),
      )
      .get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    return {
      ...recordToInvitation(row.invitation),
      orgName: row.orgName,
      orgSlug: row.orgSlug,
    };
  }

  async listPendingForOrg(orgId: string, opts?: OperationOptions): Promise<InvitationInfo[]> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    const rows = await this.#db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, orgId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, nowMs),
        ),
      )
      .orderBy(desc(invitations.createdAt))
      .all();
    throwIfAborted(opts?.signal);
    return rows.map(recordToInvitation);
  }

  async accept(id: string, opts?: OperationOptions): Promise<InvitationInfo | null> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    const updated = await this.#db
      .update(invitations)
      .set({ acceptedAt: nowMs })
      .where(
        and(
          eq(invitations.id, id),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, nowMs),
        ),
      )
      .returning();
    const row = updated[0];
    return row ? recordToInvitation(row) : null;
  }

  async revoke(id: string, orgId: string, opts?: OperationOptions): Promise<boolean> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    const updated = await this.#db
      .update(invitations)
      .set({ revokedAt: nowMs })
      .where(
        and(
          eq(invitations.id, id),
          eq(invitations.orgId, orgId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .returning({ id: invitations.id });
    return updated.length > 0;
  }
}
