import { z } from "zod";
import { parseOrThrow, NotFoundError } from "./errors";
import { IdSchema, TimestampSchema } from "./schemas";
import { defaultRuntimeDeps, toTimestamp, type RuntimeDeps } from "../runtime/ids";

export const PLATFORM_ROLES = ["admin", "user"] as const;
export const PlatformRoleSchema = z.enum(PLATFORM_ROLES);
export type PlatformRole = z.output<typeof PlatformRoleSchema>;
export const DEFAULT_PLATFORM_ROLE: PlatformRole = "user";

export const USER_STATUSES = ["active", "disabled"] as const;
export const UserStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.output<typeof UserStatusSchema>;
export const DEFAULT_USER_STATUS: UserStatus = "active";

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 40;
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;
export const DISPLAY_NAME_MAX = 120;
export const EMAIL_MAX = 320;
export const AVATAR_URL_MAX = 2048;
export const NIP05_MAX = 320;
/** NIP-05 identifier `<local-part>@<domain>`; the local part is limited to a-z0-9-_. per the NIP. */
export const NIP05_PATTERN =
  /^[a-z0-9._-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX)
  .pipe(z.email());

export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(USERNAME_MIN)
  .max(USERNAME_MAX)
  .regex(
    USERNAME_PATTERN,
    "Username must be 2-40 lowercase letters, digits, hyphens or underscores, and start and end with a letter or digit",
  );

export const DisplayNameSchema = z.string().trim().min(1).max(DISPLAY_NAME_MAX);

export const AvatarUrlSchema = z.url({ protocol: /^https?$/ }).max(AVATAR_URL_MAX);

export const Nip05Schema = z
  .string()
  .trim()
  .toLowerCase()
  .max(NIP05_MAX)
  .regex(NIP05_PATTERN, "NIP-05 identifier must look like name@example.com");

export const UserSchema = z.strictObject({
  id: IdSchema,
  email: EmailSchema,
  username: UsernameSchema,
  displayName: DisplayNameSchema,
  avatarUrl: AvatarUrlSchema.exactOptional(),
  nip05: Nip05Schema.exactOptional(),
  platformRole: PlatformRoleSchema,
  status: UserStatusSchema,
  emailVerifiedAt: TimestampSchema.exactOptional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  lastLoginAt: TimestampSchema.exactOptional(),
});

export type User = z.output<typeof UserSchema>;

export const CreateUserInputSchema = z.strictObject({
  id: IdSchema.optional(),
  email: EmailSchema,
  username: UsernameSchema,
  displayName: DisplayNameSchema,
  avatarUrl: AvatarUrlSchema.optional(),
  nip05: Nip05Schema.optional(),
  platformRole: PlatformRoleSchema.default(DEFAULT_PLATFORM_ROLE),
  status: UserStatusSchema.default(DEFAULT_USER_STATUS),
  emailVerifiedAt: TimestampSchema.optional(),
  lastLoginAt: TimestampSchema.optional(),
});

export type CreateUserInput = z.input<typeof CreateUserInputSchema>;

export const UpdateUserInputSchema = z
  .strictObject({
    email: EmailSchema.optional(),
    username: UsernameSchema.optional(),
    displayName: DisplayNameSchema.optional(),
    avatarUrl: AvatarUrlSchema.nullable().optional(),
    nip05: Nip05Schema.nullable().optional(),
    platformRole: PlatformRoleSchema.optional(),
    status: UserStatusSchema.optional(),
    emailVerifiedAt: TimestampSchema.nullable().optional(),
    lastLoginAt: TimestampSchema.nullable().optional(),
  })
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
    message: "Patch must contain at least one field",
  });

export type UpdateUserInput = z.input<typeof UpdateUserInputSchema>;

export interface UserListFilter {
  readonly search?: string | undefined;
  readonly platformRole?: PlatformRole | undefined;
  readonly status?: UserStatus | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface UserStore {
  create(input: CreateUserInput): Promise<User>;
  getById(id: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>;
  getByUsername(username: string): Promise<User | null>;
  list(filter?: UserListFilter): Promise<User[]>;
  update(id: string, patch: UpdateUserInput): Promise<User>;
  delete(id: string): Promise<void>;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function cloneUser(user: User): User {
  return { ...user };
}

export function buildUser(input: CreateUserInput, deps: RuntimeDeps = defaultRuntimeDeps): User {
  const parsed = parseOrThrow(CreateUserInputSchema, input, "createUser");
  const now = toTimestamp(deps.clock());
  const user: User = {
    id: parsed.id ?? deps.generateId(),
    email: parsed.email,
    username: parsed.username,
    displayName: parsed.displayName,
    platformRole: parsed.platformRole,
    status: parsed.status,
    createdAt: now,
    updatedAt: now,
  };
  if (parsed.avatarUrl !== undefined) user.avatarUrl = parsed.avatarUrl;
  if (parsed.nip05 !== undefined) user.nip05 = parsed.nip05;
  if (parsed.emailVerifiedAt !== undefined) user.emailVerifiedAt = parsed.emailVerifiedAt;
  if (parsed.lastLoginAt !== undefined) user.lastLoginAt = parsed.lastLoginAt;
  return parseOrThrow(UserSchema, user, "createUser result");
}

export function applyUserPatch(user: User, patch: UpdateUserInput, now: Date): User {
  const parsed = parseOrThrow(UpdateUserInputSchema, patch, "updateUser");
  const candidate = toTimestamp(now);
  const updatedAt = Date.parse(candidate) >= Date.parse(user.updatedAt) ? candidate : user.updatedAt;
  const avatarUrl =
    parsed.avatarUrl === undefined ? user.avatarUrl : (parsed.avatarUrl ?? undefined);
  const nip05 = parsed.nip05 === undefined ? user.nip05 : (parsed.nip05 ?? undefined);
  const emailVerifiedAt =
    parsed.emailVerifiedAt === undefined
      ? user.emailVerifiedAt
      : (parsed.emailVerifiedAt ?? undefined);
  const lastLoginAt =
    parsed.lastLoginAt === undefined ? user.lastLoginAt : (parsed.lastLoginAt ?? undefined);

  const next: User = {
    id: user.id,
    email: parsed.email ?? user.email,
    username: parsed.username ?? user.username,
    displayName: parsed.displayName ?? user.displayName,
    platformRole: parsed.platformRole ?? user.platformRole,
    status: parsed.status ?? user.status,
    createdAt: user.createdAt,
    updatedAt,
  };
  if (avatarUrl !== undefined) next.avatarUrl = avatarUrl;
  if (nip05 !== undefined) next.nip05 = nip05;
  if (emailVerifiedAt !== undefined) next.emailVerifiedAt = emailVerifiedAt;
  if (lastLoginAt !== undefined) next.lastLoginAt = lastLoginAt;
  return parseOrThrow(UserSchema, next, "updateUser result");
}

export function compareUsers(a: User, b: User): number {
  if (a.createdAt !== b.createdAt) return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export class InMemoryUserStore implements UserStore {
  readonly #users = new Map<string, User>();
  readonly #deps: RuntimeDeps;

  constructor(deps: RuntimeDeps = defaultRuntimeDeps) {
    this.#deps = deps;
  }

  create(input: CreateUserInput): Promise<User> {
    return new Promise((resolve) => {
      const user = buildUser(input, this.#deps);
      for (const existing of this.#users.values()) {
        if (existing.email === user.email) {
          parseOrThrow(
            z.never(),
            user.email,
            "createUser: email already taken",
          );
        }
        if (existing.username === user.username) {
          parseOrThrow(
            z.never(),
            user.username,
            "createUser: username already taken",
          );
        }
      }
      this.#users.set(user.id, user);
      resolve(cloneUser(user));
    });
  }

  getById(id: string): Promise<User | null> {
    return new Promise((resolve) => {
      const validId = parseOrThrow(IdSchema, id, "getUserById");
      const user = this.#users.get(validId);
      resolve(user === undefined ? null : cloneUser(user));
    });
  }

  getByEmail(email: string): Promise<User | null> {
    return new Promise((resolve) => {
      const normalized = email.trim().toLowerCase();
      for (const user of this.#users.values()) {
        if (user.email === normalized) {
          resolve(cloneUser(user));
          return;
        }
      }
      resolve(null);
    });
  }

  getByUsername(username: string): Promise<User | null> {
    return new Promise((resolve) => {
      const normalized = username.trim().toLowerCase();
      for (const user of this.#users.values()) {
        if (user.username === normalized) {
          resolve(cloneUser(user));
          return;
        }
      }
      resolve(null);
    });
  }

  list(filter?: UserListFilter): Promise<User[]> {
    return new Promise((resolve) => {
      let users = [...this.#users.values()].sort(compareUsers);
      if (filter?.platformRole !== undefined) {
        users = users.filter((u) => u.platformRole === filter.platformRole);
      }
      if (filter?.status !== undefined) {
        users = users.filter((u) => u.status === filter.status);
      }
      if (filter?.search !== undefined && filter.search.trim().length > 0) {
        const q = filter.search.trim().toLowerCase();
        users = users.filter(
          (u) =>
            u.email.toLowerCase().includes(q) ||
            u.username.toLowerCase().includes(q) ||
            u.displayName.toLowerCase().includes(q),
        );
      }
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit;
      const sliced = limit !== undefined ? users.slice(offset, offset + limit) : users.slice(offset);
      resolve(sliced.map(cloneUser));
    });
  }

  update(id: string, patch: UpdateUserInput): Promise<User> {
    return new Promise((resolve) => {
      const validId = parseOrThrow(IdSchema, id, "updateUser");
      const existing = this.#users.get(validId);
      if (!existing) throw new NotFoundError("user", validId);
      if (patch.platformRole !== undefined && existing.platformRole === "admin" && patch.platformRole !== "admin") {
        const adminCount = [...this.#users.values()].filter((u) => u.platformRole === "admin" && u.status === "active").length;
        if (adminCount <= 1) {
          parseOrThrow(z.never(), patch.platformRole, "updateUser: cannot demote the last platform admin");
        }
      }
      if (patch.status === "disabled" && existing.platformRole === "admin" && existing.status === "active") {
        const adminCount = [...this.#users.values()].filter((u) => u.platformRole === "admin" && u.status === "active").length;
        if (adminCount <= 1) {
          parseOrThrow(z.never(), patch.status, "updateUser: cannot disable the last platform admin");
        }
      }
      const next = applyUserPatch(existing, patch, this.#deps.clock());
      for (const other of this.#users.values()) {
        if (other.id === validId) continue;
        if (other.email === next.email) {
          parseOrThrow(z.never(), next.email, "updateUser: email already taken");
        }
        if (other.username === next.username) {
          parseOrThrow(z.never(), next.username, "updateUser: username already taken");
        }
      }
      this.#users.set(validId, next);
      resolve(cloneUser(next));
    });
  }

  delete(id: string): Promise<void> {
    return new Promise((resolve) => {
      const validId = parseOrThrow(IdSchema, id, "deleteUser");
      const existing = this.#users.get(validId);
      if (!existing) throw new NotFoundError("user", validId);
      if (existing.platformRole === "admin" && existing.status === "active") {
        const adminCount = [...this.#users.values()].filter((u) => u.platformRole === "admin" && u.status === "active").length;
        if (adminCount <= 1) {
          parseOrThrow(z.never(), validId, "deleteUser: cannot delete the last platform admin");
        }
      }
      this.#users.delete(validId);
      resolve();
    });
  }
}
