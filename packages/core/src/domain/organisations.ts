import { z } from "zod";
import { parseOrThrow, NotFoundError } from "./errors";
import { IdSchema, TimestampSchema } from "./schemas";
import { defaultRuntimeDeps, toTimestamp, type RuntimeDeps } from "../runtime/ids";

export const ORGANISATION_ROLES = ["viewer", "editor", "owner"] as const;
export const OrganisationRoleSchema = z.enum(ORGANISATION_ROLES);
export type OrganisationRole = z.output<typeof OrganisationRoleSchema>;

export const ORGANISATION_ROLE_WEIGHT: Record<OrganisationRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export function hasMinimumOrgRole(actual: OrganisationRole, minimum: OrganisationRole): boolean {
  return ORGANISATION_ROLE_WEIGHT[actual] >= ORGANISATION_ROLE_WEIGHT[minimum];
}

export const ORGANISATION_NAME_MAX = 120;
export const ORGANISATION_SLUG_MIN = 2;
export const ORGANISATION_SLUG_MAX = 60;
export const ORGANISATION_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

export const DEFAULT_ORGANISATION_ID = "01a10000-0000-7000-8000-000000000001";
export const DEFAULT_ORGANISATION_SLUG = "default";
export const DEFAULT_ORGANISATION_NAME = "Default Organisation";
export const BOOTSTRAP_ADMIN_USER_ID = "01a10000-0000-7000-8000-000000000000";

export const OrganisationNameSchema = z.string().trim().min(1).max(ORGANISATION_NAME_MAX);
export const OrganisationSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(ORGANISATION_SLUG_MIN)
  .max(ORGANISATION_SLUG_MAX)
  .regex(
    ORGANISATION_SLUG_PATTERN,
    "Organisation slug must be 2-60 lowercase letters, digits or hyphens, and start and end with a letter or digit",
  );

export const OrganisationSchema = z.strictObject({
  id: IdSchema,
  name: OrganisationNameSchema,
  slug: OrganisationSlugSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type Organisation = z.output<typeof OrganisationSchema>;

export const MembershipSchema = z.strictObject({
  orgId: IdSchema,
  userId: IdSchema,
  role: OrganisationRoleSchema,
  createdAt: TimestampSchema,
});

export type Membership = z.output<typeof MembershipSchema>;

export interface UserOrganisationMembership {
  readonly organisation: Organisation;
  readonly role: OrganisationRole;
  readonly joinedAt: string;
}

export const CreateOrganisationInputSchema = z.strictObject({
  id: IdSchema.optional(),
  name: OrganisationNameSchema,
  slug: OrganisationSlugSchema.optional(),
});

export type CreateOrganisationInput = z.input<typeof CreateOrganisationInputSchema>;

export const UpdateOrganisationInputSchema = z
  .strictObject({
    name: OrganisationNameSchema.optional(),
    slug: OrganisationSlugSchema.optional(),
  })
  .refine((patch) => patch.name !== undefined || patch.slug !== undefined, {
    message: "Patch must contain at least one field",
  });

export type UpdateOrganisationInput = z.input<typeof UpdateOrganisationInputSchema>;

export function deriveOrganisationSlug(name: string, takenSlugs: Iterable<string> = []): string {
  const taken = new Set(takenSlugs);
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const base = cleaned.length >= ORGANISATION_SLUG_MIN ? cleaned : "org";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${String(i)}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${String(Date.now()).slice(-6)}`;
}

export function cloneOrganisation(org: Organisation): Organisation {
  return { ...org };
}

export function cloneMembership(membership: Membership): Membership {
  return { ...membership };
}

export function buildOrganisation(
  input: CreateOrganisationInput,
  deps: RuntimeDeps = defaultRuntimeDeps,
  takenSlugs: Iterable<string> = [],
): Organisation {
  const parsed = parseOrThrow(CreateOrganisationInputSchema, input, "createOrganisation");
  const slug = parsed.slug ?? deriveOrganisationSlug(parsed.name, takenSlugs);
  if (new Set(takenSlugs).has(slug)) {
    parseOrThrow(z.never(), slug, "createOrganisation: slug already taken");
  }
  const now = toTimestamp(deps.clock());
  return parseOrThrow(
    OrganisationSchema,
    {
      id: parsed.id ?? deps.generateId(),
      name: parsed.name,
      slug,
      createdAt: now,
      updatedAt: now,
    },
    "createOrganisation result",
  );
}

export function applyOrganisationPatch(
  org: Organisation,
  patch: UpdateOrganisationInput,
  now: Date,
  otherSlugs: Iterable<string> = [],
): Organisation {
  const parsed = parseOrThrow(UpdateOrganisationInputSchema, patch, "updateOrganisation");
  const nextSlug = parsed.slug ?? org.slug;
  if (nextSlug !== org.slug && new Set(otherSlugs).has(nextSlug)) {
    parseOrThrow(z.never(), nextSlug, "updateOrganisation: slug already taken");
  }
  const candidate = toTimestamp(now);
  const updatedAt = Date.parse(candidate) >= Date.parse(org.updatedAt) ? candidate : org.updatedAt;
  return parseOrThrow(
    OrganisationSchema,
    {
      id: org.id,
      name: parsed.name ?? org.name,
      slug: nextSlug,
      createdAt: org.createdAt,
      updatedAt,
    },
    "updateOrganisation result",
  );
}

export interface OrganisationStore {
  create(input: CreateOrganisationInput, ownerUserId: string): Promise<Organisation>;
  getById(id: string): Promise<Organisation | null>;
  getBySlug(slug: string): Promise<Organisation | null>;
  listAll(): Promise<Organisation[]>;
  listForUser(userId: string): Promise<UserOrganisationMembership[]>;
  rename(id: string, patch: UpdateOrganisationInput): Promise<Organisation>;
  delete(id: string): Promise<void>;
  getMembership(orgId: string, userId: string): Promise<Membership | null>;
  addMember(orgId: string, userId: string, role: OrganisationRole): Promise<Membership>;
  updateMemberRole(orgId: string, userId: string, role: OrganisationRole): Promise<Membership>;
  removeMember(orgId: string, userId: string): Promise<void>;
  listMembers(orgId: string): Promise<Membership[]>;
}

export class InMemoryOrganisationStore implements OrganisationStore {
  readonly #orgs = new Map<string, Organisation>();
  readonly #memberships = new Map<string, Membership>();
  readonly #deps: RuntimeDeps;

  constructor(deps: RuntimeDeps = defaultRuntimeDeps) {
    this.#deps = deps;
  }

  #membershipKey(orgId: string, userId: string): string {
    return `${orgId}:${userId}`;
  }

  create(input: CreateOrganisationInput, ownerUserId: string): Promise<Organisation> {
    return new Promise((resolve) => {
      const validOwnerId = parseOrThrow(IdSchema, ownerUserId, "createOrganisation ownerUserId");
      const takenSlugs = [...this.#orgs.values()].map((o) => o.slug);
      const org = buildOrganisation(input, this.#deps, takenSlugs);
      const membership: Membership = parseOrThrow(
        MembershipSchema,
        {
          orgId: org.id,
          userId: validOwnerId,
          role: "owner",
          createdAt: org.createdAt,
        },
        "createOrganisation membership",
      );
      this.#orgs.set(org.id, org);
      this.#memberships.set(this.#membershipKey(org.id, validOwnerId), membership);
      resolve(cloneOrganisation(org));
    });
  }

  getById(id: string): Promise<Organisation | null> {
    return new Promise((resolve) => {
      const validId = parseOrThrow(IdSchema, id, "getOrganisationById");
      const org = this.#orgs.get(validId);
      resolve(org === undefined ? null : cloneOrganisation(org));
    });
  }

  getBySlug(slug: string): Promise<Organisation | null> {
    return new Promise((resolve) => {
      const normalized = slug.trim().toLowerCase();
      for (const org of this.#orgs.values()) {
        if (org.slug === normalized) {
          resolve(cloneOrganisation(org));
          return;
        }
      }
      resolve(null);
    });
  }

  listAll(): Promise<Organisation[]> {
    return new Promise((resolve) => {
      const orgs = [...this.#orgs.values()].sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
      );
      resolve(orgs.map(cloneOrganisation));
    });
  }

  listForUser(userId: string): Promise<UserOrganisationMembership[]> {
    return new Promise((resolve) => {
      const validUserId = parseOrThrow(IdSchema, userId, "listOrganisationsForUser");
      const results: UserOrganisationMembership[] = [];
      for (const m of this.#memberships.values()) {
        if (m.userId !== validUserId) continue;
        const org = this.#orgs.get(m.orgId);
        if (!org) continue;
        results.push({
          organisation: cloneOrganisation(org),
          role: m.role,
          joinedAt: m.createdAt,
        });
      }
      results.sort(
        (a, b) =>
          Date.parse(a.organisation.createdAt) - Date.parse(b.organisation.createdAt) ||
          a.organisation.id.localeCompare(b.organisation.id),
      );
      resolve(results);
    });
  }

  rename(id: string, patch: UpdateOrganisationInput): Promise<Organisation> {
    return new Promise((resolve) => {
      const validId = parseOrThrow(IdSchema, id, "renameOrganisation");
      const existing = this.#orgs.get(validId);
      if (!existing) throw new NotFoundError("organisation", validId);
      const otherSlugs = [...this.#orgs.values()].filter((o) => o.id !== validId).map((o) => o.slug);
      const next = applyOrganisationPatch(existing, patch, this.#deps.clock(), otherSlugs);
      this.#orgs.set(validId, next);
      resolve(cloneOrganisation(next));
    });
  }

  delete(id: string): Promise<void> {
    return new Promise((resolve) => {
      const validId = parseOrThrow(IdSchema, id, "deleteOrganisation");
      if (!this.#orgs.has(validId)) throw new NotFoundError("organisation", validId);
      this.#orgs.delete(validId);
      for (const [key, m] of this.#memberships.entries()) {
        if (m.orgId === validId) this.#memberships.delete(key);
      }
      resolve();
    });
  }

  getMembership(orgId: string, userId: string): Promise<Membership | null> {
    return new Promise((resolve) => {
      const validOrgId = parseOrThrow(IdSchema, orgId, "getMembership orgId");
      const validUserId = parseOrThrow(IdSchema, userId, "getMembership userId");
      const m = this.#memberships.get(this.#membershipKey(validOrgId, validUserId));
      resolve(m === undefined ? null : cloneMembership(m));
    });
  }

  addMember(orgId: string, userId: string, role: OrganisationRole): Promise<Membership> {
    return new Promise((resolve) => {
      const validOrgId = parseOrThrow(IdSchema, orgId, "addMember orgId");
      const validUserId = parseOrThrow(IdSchema, userId, "addMember userId");
      const validRole = parseOrThrow(OrganisationRoleSchema, role, "addMember role");
      if (!this.#orgs.has(validOrgId)) throw new NotFoundError("organisation", validOrgId);
      const key = this.#membershipKey(validOrgId, validUserId);
      if (this.#memberships.has(key)) {
        parseOrThrow(z.never(), validUserId, "addMember: user is already a member");
      }
      const membership: Membership = parseOrThrow(
        MembershipSchema,
        {
          orgId: validOrgId,
          userId: validUserId,
          role: validRole,
          createdAt: toTimestamp(this.#deps.clock()),
        },
        "addMember result",
      );
      this.#memberships.set(key, membership);
      resolve(cloneMembership(membership));
    });
  }

  updateMemberRole(orgId: string, userId: string, role: OrganisationRole): Promise<Membership> {
    return new Promise((resolve) => {
      const validOrgId = parseOrThrow(IdSchema, orgId, "updateMemberRole orgId");
      const validUserId = parseOrThrow(IdSchema, userId, "updateMemberRole userId");
      const validRole = parseOrThrow(OrganisationRoleSchema, role, "updateMemberRole role");
      const key = this.#membershipKey(validOrgId, validUserId);
      const existing = this.#memberships.get(key);
      if (!existing) throw new NotFoundError("membership", key);
      if (existing.role === "owner" && validRole !== "owner") {
        const ownerCount = [...this.#memberships.values()].filter(
          (m) => m.orgId === validOrgId && m.role === "owner",
        ).length;
        if (ownerCount <= 1) {
          parseOrThrow(
            z.never(),
            validRole,
            "updateMemberRole: organisation must have at least one owner",
          );
        }
      }
      const next: Membership = { ...existing, role: validRole };
      this.#memberships.set(key, next);
      resolve(cloneMembership(next));
    });
  }

  removeMember(orgId: string, userId: string): Promise<void> {
    return new Promise((resolve) => {
      const validOrgId = parseOrThrow(IdSchema, orgId, "removeMember orgId");
      const validUserId = parseOrThrow(IdSchema, userId, "removeMember userId");
      const key = this.#membershipKey(validOrgId, validUserId);
      const existing = this.#memberships.get(key);
      if (!existing) throw new NotFoundError("membership", key);
      if (existing.role === "owner") {
        const ownerCount = [...this.#memberships.values()].filter(
          (m) => m.orgId === validOrgId && m.role === "owner",
        ).length;
        if (ownerCount <= 1) {
          parseOrThrow(
            z.never(),
            validUserId,
            "removeMember: organisation must have at least one owner",
          );
        }
      }
      this.#memberships.delete(key);
      resolve();
    });
  }

  listMembers(orgId: string): Promise<Membership[]> {
    return new Promise((resolve) => {
      const validOrgId = parseOrThrow(IdSchema, orgId, "listMembers orgId");
      if (!this.#orgs.has(validOrgId)) throw new NotFoundError("organisation", validOrgId);
      const members = [...this.#memberships.values()]
        .filter((m) => m.orgId === validOrgId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.userId.localeCompare(b.userId));
      resolve(members.map(cloneMembership));
    });
  }
}
