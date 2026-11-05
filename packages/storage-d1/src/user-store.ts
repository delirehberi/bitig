import { and, eq, isNull, ne } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  IdSchema,
  NotFoundError,
  ValidationError,
  applyUserPatch,
  buildUser,
  cloneUser,
  compareUsers,
  defaultRuntimeDeps,
  parseOrThrow,
  type CreateUserInput,
  type RuntimeDeps,
  type UpdateUserInput,
  type User,
  type UserListFilter,
  type UserStore,
} from "@bitig/core";
import * as schema from "./schema";
import { accessTokens, memberships, sessions, users, type InsertUserRecord, type UserRecord } from "./schema";

function isD1Database(db: unknown): db is D1Database {
  return typeof db === "object" && db !== null && "prepare" in db && typeof db.prepare === "function";
}

function throwCustomValidation(context: string, field: string, message: string, input: unknown): never {
  throw new ValidationError(context, [{ code: "custom", path: [field], message, input }]);
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
  if (row.avatarUrl !== null) user.avatarUrl = row.avatarUrl;
  if (row.emailVerifiedAt !== null) user.emailVerifiedAt = new Date(row.emailVerifiedAt).toISOString();
  if (row.lastLoginAt !== null) user.lastLoginAt = new Date(row.lastLoginAt).toISOString();
  return user;
}

function userToRecord(user: User): InsertUserRecord {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? null,
    platformRole: user.platformRole,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt !== undefined ? Date.parse(user.emailVerifiedAt) : null,
    createdAt: Date.parse(user.createdAt),
    updatedAt: Date.parse(user.updatedAt),
    lastLoginAt: user.lastLoginAt !== undefined ? Date.parse(user.lastLoginAt) : null,
    deletedAt: null,
  };
}

export class D1UserStore implements UserStore {
  readonly #db: DrizzleD1Database<typeof schema>;
  readonly #deps: RuntimeDeps;

  constructor(
    db: D1Database | DrizzleD1Database<typeof schema>,
    deps: RuntimeDeps = defaultRuntimeDeps,
  ) {
    this.#db = isD1Database(db) ? drizzle(db, { schema }) : db;
    this.#deps = deps;
  }

  async create(input: CreateUserInput): Promise<User> {
    const user = buildUser(input, this.#deps);
    const existingEmail = await this.#db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, user.email), isNull(users.deletedAt)))
      .get();
    if (existingEmail) {
      throwCustomValidation("createUser", "email", "email already taken", user.email);
    }
    const existingUsername = await this.#db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.username, user.username), isNull(users.deletedAt)))
      .get();
    if (existingUsername) {
      throwCustomValidation("createUser", "username", "username already taken", user.username);
    }
    await this.#db.insert(users).values(userToRecord(user));
    return cloneUser(user);
  }

  async getById(id: string): Promise<User | null> {
    const validId = parseOrThrow(IdSchema, id, "getUserById");
    const row = await this.#db
      .select()
      .from(users)
      .where(and(eq(users.id, validId), isNull(users.deletedAt)))
      .get();
    return row ? cloneUser(recordToUser(row)) : null;
  }

  async getByEmail(email: string): Promise<User | null> {
    const normalized = email.trim().toLowerCase();
    const row = await this.#db
      .select()
      .from(users)
      .where(and(eq(users.email, normalized), isNull(users.deletedAt)))
      .get();
    return row ? cloneUser(recordToUser(row)) : null;
  }

  async getByUsername(username: string): Promise<User | null> {
    const normalized = username.trim().toLowerCase();
    const row = await this.#db
      .select()
      .from(users)
      .where(and(eq(users.username, normalized), isNull(users.deletedAt)))
      .get();
    return row ? cloneUser(recordToUser(row)) : null;
  }

  async list(filter?: UserListFilter): Promise<User[]> {
    const rows = await this.#db.select().from(users).where(isNull(users.deletedAt)).all();
    let result = rows.map(recordToUser).sort(compareUsers);
    if (filter?.platformRole !== undefined) {
      result = result.filter((u) => u.platformRole === filter.platformRole);
    }
    if (filter?.status !== undefined) {
      result = result.filter((u) => u.status === filter.status);
    }
    if (filter?.search !== undefined && filter.search.trim().length > 0) {
      const q = filter.search.trim().toLowerCase();
      result = result.filter(
        (u) =>
          u.email.toLowerCase().includes(q) ||
          u.username.toLowerCase().includes(q) ||
          u.displayName.toLowerCase().includes(q),
      );
    }
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit;
    const sliced = limit !== undefined ? result.slice(offset, offset + limit) : result.slice(offset);
    return sliced.map(cloneUser);
  }

  async update(id: string, patch: UpdateUserInput): Promise<User> {
    const validId = parseOrThrow(IdSchema, id, "updateUser");
    const existingRow = await this.#db
      .select()
      .from(users)
      .where(and(eq(users.id, validId), isNull(users.deletedAt)))
      .get();
    if (!existingRow) throw new NotFoundError("user", validId);
    const existing = recordToUser(existingRow);

    if (
      (patch.platformRole !== undefined && existing.platformRole === "admin" && patch.platformRole !== "admin") ||
      (patch.status === "disabled" && existing.platformRole === "admin" && existing.status === "active")
    ) {
      const allAdmins = await this.#db
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(and(eq(users.platformRole, "admin"), isNull(users.deletedAt)))
        .all();
      const activeAdmins = allAdmins.filter((a) => a.status === "active");
      if (activeAdmins.length <= 1 && activeAdmins.some((a) => a.id === validId)) {
        throwCustomValidation("updateUser", "platformRole", "cannot demote or disable the last platform admin", validId);
      }
    }

    const next = applyUserPatch(existing, patch, this.#deps.clock());
    if (next.email !== existing.email) {
      const otherEmail = await this.#db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, next.email), isNull(users.deletedAt)))
        .get();
      if (otherEmail && otherEmail.id !== validId) {
        throwCustomValidation("updateUser", "email", "email already taken", next.email);
      }
    }
    if (next.username !== existing.username) {
      const otherUsername = await this.#db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.username, next.username), isNull(users.deletedAt)))
        .get();
      if (otherUsername && otherUsername.id !== validId) {
        throwCustomValidation("updateUser", "username", "username already taken", next.username);
      }
    }

    await this.#db.update(users).set(userToRecord(next)).where(eq(users.id, validId));
    return cloneUser(next);
  }

  async delete(id: string): Promise<void> {
    const validId = parseOrThrow(IdSchema, id, "deleteUser");
    const existingRow = await this.#db
      .select()
      .from(users)
      .where(and(eq(users.id, validId), isNull(users.deletedAt)))
      .get();
    if (!existingRow) throw new NotFoundError("user", validId);
    if (existingRow.platformRole === "admin" && existingRow.status === "active") {
      const otherAdmins = await this.#db
        .select({ id: users.id, status: users.status, platformRole: users.platformRole })
        .from(users)
        .where(and(ne(users.id, validId), isNull(users.deletedAt)))
        .all();
      const activeOtherAdmins = otherAdmins.filter((a) => a.platformRole === "admin" && a.status === "active");
      if (activeOtherAdmins.length === 0) {
        throwCustomValidation("deleteUser", "id", "cannot delete the last platform admin", validId);
      }
    }
    const now = this.#deps.clock().getTime();
    await this.#db.delete(sessions).where(eq(sessions.userId, validId));
    await this.#db
      .update(accessTokens)
      .set({ revokedAt: now })
      .where(and(eq(accessTokens.userId, validId), isNull(accessTokens.revokedAt)));
    await this.#db.delete(memberships).where(eq(memberships.userId, validId));
    await this.#db
      .update(users)
      .set({
        status: "disabled",
        deletedAt: now,
        updatedAt: now,
        email: `${existingRow.email}#deleted-${validId}`,
        username: `${existingRow.username.slice(0, 20)}-del-${validId.slice(0, 8)}`,
      })
      .where(eq(users.id, validId));
  }
}
