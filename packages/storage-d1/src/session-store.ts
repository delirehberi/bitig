import { and, desc, eq, gt, lt, ne } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  defaultRuntimeDeps,
  throwIfAborted,
  type OperationOptions,
  type RuntimeDeps,
  type User,
} from "@bitig/core";
import * as schema from "./schema";
import { sessions, users, type SessionRecord, type UserRecord } from "./schema";

export interface SessionInfo {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent?: string | undefined;
  ip?: string | undefined;
}

export interface CreateSessionRecordInput {
  id: string;
  userId: string;
  expiresAt: number | string;
  userAgent?: string | undefined;
  ip?: string | undefined;
}

function isD1Database(db: unknown): db is D1Database {
  return typeof db === "object" && db !== null && "prepare" in db && typeof db.prepare === "function";
}

function recordToSession(row: SessionRecord): SessionInfo {
  const info: SessionInfo = {
    id: row.id,
    userId: row.userId,
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    lastSeenAt: new Date(row.lastSeenAt).toISOString(),
  };
  if (row.userAgent !== null) {
    info.userAgent = row.userAgent;
  }
  if (row.ip !== null) {
    info.ip = row.ip;
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
  if (row.lastLoginAt !== null) {
    user.lastLoginAt = new Date(row.lastLoginAt).toISOString();
  }
  return user;
}

export class D1SessionStore {
  readonly #db: DrizzleD1Database<typeof schema>;
  readonly #deps: RuntimeDeps;

  constructor(db: D1Database | DrizzleD1Database<typeof schema>, deps: RuntimeDeps = defaultRuntimeDeps) {
    this.#db = isD1Database(db) ? drizzle(db, { schema }) : db;
    this.#deps = deps;
  }

  async create(input: CreateSessionRecordInput, opts?: OperationOptions): Promise<SessionInfo> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    const expiresAtMs = typeof input.expiresAt === "number" ? input.expiresAt : Date.parse(input.expiresAt);
    const row: SessionRecord = {
      id: input.id,
      userId: input.userId,
      createdAt: nowMs,
      expiresAt: expiresAtMs,
      lastSeenAt: nowMs,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    };
    await this.#db.insert(sessions).values(row);
    throwIfAborted(opts?.signal);
    return recordToSession(row);
  }

  async get(id: string, opts?: OperationOptions): Promise<SessionInfo | null> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    const row = await this.#db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, nowMs)))
      .get();
    throwIfAborted(opts?.signal);
    return row ? recordToSession(row) : null;
  }

  async getWithUser(id: string, opts?: OperationOptions): Promise<{ session: SessionInfo; user: User } | null> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    const row = await this.#db
      .select({
        session: sessions,
        user: users,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, nowMs)))
      .get();
    throwIfAborted(opts?.signal);
    if (row?.user.status !== "active" || row.user.deletedAt !== null) return null;
    return {
      session: recordToSession(row.session),
      user: recordToUser(row.user),
    };
  }

  async touch(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    await this.#db.update(sessions).set({ lastSeenAt: nowMs }).where(eq(sessions.id, id));
  }

  async delete(id: string, opts?: OperationOptions): Promise<boolean> {
    throwIfAborted(opts?.signal);
    const deleted = await this.#db.delete(sessions).where(eq(sessions.id, id)).returning({ id: sessions.id });
    return deleted.length > 0;
  }

  async deleteForUser(id: string, userId: string, opts?: OperationOptions): Promise<boolean> {
    throwIfAborted(opts?.signal);
    const deleted = await this.#db
      .delete(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
      .returning({ id: sessions.id });
    return deleted.length > 0;
  }

  async deleteAllForUser(userId: string, exceptSessionId?: string, opts?: OperationOptions): Promise<number> {
    throwIfAborted(opts?.signal);
    const condition =
      exceptSessionId === undefined
        ? eq(sessions.userId, userId)
        : and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId));
    const deleted = await this.#db.delete(sessions).where(condition).returning({ id: sessions.id });
    return deleted.length;
  }

  async listForUser(userId: string, opts?: OperationOptions): Promise<SessionInfo[]> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    const rows = await this.#db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, nowMs)))
      .orderBy(desc(sessions.lastSeenAt))
      .all();
    throwIfAborted(opts?.signal);
    return rows.map(recordToSession);
  }

  async pruneExpired(opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const nowMs = this.#deps.clock().getTime();
    await this.#db.delete(sessions).where(lt(sessions.expiresAt, nowMs));
  }
}
