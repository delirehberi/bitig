import { and, desc, eq, isNull, or, gt } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  defaultRuntimeDeps,
  throwIfAborted,
  type OperationOptions,
  type OrganisationRole,
  type RuntimeDeps,
  type User,
} from "@bitig/core";
import * as schema from "./schema";
import {
  accessTokens,
  memberships,
  organisations,
  users,
  type AccessTokenRecord,
  type UserRecord,
} from "./schema";

export interface AccessTokenInfo {
  id: string;
  userId: string;
  orgId: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string | undefined;
  expiresAt?: string | undefined;
  revokedAt?: string | undefined;
}

export interface AccessTokenWithOrg extends AccessTokenInfo {
  orgName: string;
  orgSlug: string;
}

export interface CreateAccessTokenRecordInput {
  userId: string;
  orgId: string;
  name: string;
  tokenHash: string;
  prefix: string;
  expiresAt?: number | string | null | undefined;
}

export interface VerifiedAccessToken {
  token: AccessTokenInfo;
  user: User;
  orgId: string;
  orgRole: OrganisationRole;
}

function isD1Database(db: unknown): db is D1Database {
  return typeof db === "object" && db !== null && "prepare" in db && typeof db.prepare === "function";
}

function recordToAccessToken(row: AccessTokenRecord): AccessTokenInfo {
  const info: AccessTokenInfo = {
    id: row.id,
    userId: row.userId,
    orgId: row.orgId,
    name: row.name,
    prefix: row.prefix,
    createdAt: new Date(row.createdAt).toISOString(),
  };
  if (row.lastUsedAt !== null) {
    info.lastUsedAt = new Date(row.lastUsedAt).toISOString();
  }
  if (row.expiresAt !== null) {
    info.expiresAt = new Date(row.expiresAt).toISOString();
  }
  if (row.revokedAt !== null) {
    info.revokedAt = new Date(row.revokedAt).toISOString();
  }
  return info;
}

function recordToUser(row: UserRecord): User {
  const user: User = {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.displayName,
    platformRole: row.platformRole,
    status: row.status,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
  if (row.emailVerifiedAt !== null) {
    user.emailVerifiedAt = new Date(row.emailVerifiedAt).toISOString();
  }
  if (row.avatarUrl !== null) {
    user.avatarUrl = row.avatarUrl;
  }
  if (row.nip05 !== null) {
    user.nip05 = row.nip05;
  }
  if (row.lastLoginAt !== null) {
    user.lastLoginAt = new Date(row.lastLoginAt).toISOString();
  }
  return user;
}

export class D1AccessTokenStore {
  readonly #db: DrizzleD1Database<typeof schema>;
  readonly #deps: RuntimeDeps;

  constructor(db: D1Database | DrizzleD1Database<typeof schema>, deps: RuntimeDeps = defaultRuntimeDeps) {
    this.#db = isD1Database(db) ? drizzle(db, { schema }) : db;
    this.#deps = deps;
  }

  async create(input: CreateAccessTokenRecordInput, opts?: OperationOptions): Promise<AccessTokenInfo> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    const expiresAtMs =
      input.expiresAt === undefined || input.expiresAt === null
        ? null
        : typeof input.expiresAt === "number"
          ? input.expiresAt
          : Date.parse(input.expiresAt);
    const row: AccessTokenRecord = {
      id: this.#deps.generateId(),
      userId: input.userId,
      orgId: input.orgId,
      name: input.name.trim(),
      tokenHash: input.tokenHash,
      prefix: input.prefix,
      createdAt: nowMs,
      lastUsedAt: null,
      expiresAt: expiresAtMs,
      revokedAt: null,
    };
    await this.#db.insert(accessTokens).values(row);
    throwIfAborted(opts?.signal);
    return recordToAccessToken(row);
  }

  async verifyByHash(tokenHash: string, opts?: OperationOptions): Promise<VerifiedAccessToken | null> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    const row = await this.#db
      .select({
        token: accessTokens,
        user: users,
        membership: memberships,
      })
      .from(accessTokens)
      .innerJoin(users, eq(accessTokens.userId, users.id))
      .innerJoin(
        memberships,
        and(eq(memberships.orgId, accessTokens.orgId), eq(memberships.userId, accessTokens.userId)),
      )
      .where(
        and(
          eq(accessTokens.tokenHash, tokenHash),
          isNull(accessTokens.revokedAt),
          or(isNull(accessTokens.expiresAt), gt(accessTokens.expiresAt, nowMs)),
        ),
      )
      .get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    if (row.user.status !== "active" || row.user.deletedAt !== null) return null;

    await this.#db
      .update(accessTokens)
      .set({ lastUsedAt: nowMs })
      .where(eq(accessTokens.id, row.token.id));

    return {
      token: recordToAccessToken({ ...row.token, lastUsedAt: nowMs }),
      user: recordToUser(row.user),
      orgId: row.token.orgId,
      orgRole: row.membership.role,
    };
  }

  async listForUser(userId: string, opts?: OperationOptions): Promise<AccessTokenWithOrg[]> {
    throwIfAborted(opts?.signal);
    const rows = await this.#db
      .select({
        token: accessTokens,
        orgName: organisations.name,
        orgSlug: organisations.slug,
      })
      .from(accessTokens)
      .innerJoin(organisations, eq(accessTokens.orgId, organisations.id))
      .where(and(eq(accessTokens.userId, userId), isNull(accessTokens.revokedAt)))
      .orderBy(desc(accessTokens.createdAt))
      .all();
    throwIfAborted(opts?.signal);
    return rows.map((row) => ({
      ...recordToAccessToken(row.token),
      orgName: row.orgName,
      orgSlug: row.orgSlug,
    }));
  }

  async revoke(id: string, userId: string, opts?: OperationOptions): Promise<boolean> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    const updated = await this.#db
      .update(accessTokens)
      .set({ revokedAt: nowMs })
      .where(and(eq(accessTokens.id, id), eq(accessTokens.userId, userId), isNull(accessTokens.revokedAt)))
      .returning({ id: accessTokens.id });
    return updated.length > 0;
  }

  async revokeAllForUser(userId: string, opts?: OperationOptions): Promise<number> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    const updated = await this.#db
      .update(accessTokens)
      .set({ revokedAt: nowMs })
      .where(and(eq(accessTokens.userId, userId), isNull(accessTokens.revokedAt)))
      .returning({ id: accessTokens.id });
    return updated.length;
  }

  async revokeAllForUserInOrg(userId: string, orgId: string, opts?: OperationOptions): Promise<number> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    const updated = await this.#db
      .update(accessTokens)
      .set({ revokedAt: nowMs })
      .where(
        and(eq(accessTokens.userId, userId), eq(accessTokens.orgId, orgId), isNull(accessTokens.revokedAt)),
      )
      .returning({ id: accessTokens.id });
    return updated.length;
  }
}
