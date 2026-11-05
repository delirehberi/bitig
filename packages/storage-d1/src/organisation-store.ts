import { and, eq, isNull, ne } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  IdSchema,
  MembershipSchema,
  NotFoundError,
  OrganisationRoleSchema,
  ValidationError,
  applyOrganisationPatch,
  buildOrganisation,
  cloneMembership,
  cloneOrganisation,
  defaultRuntimeDeps,
  parseOrThrow,
  toTimestamp,
  type CreateOrganisationInput,
  type Membership,
  type Organisation,
  type OrganisationRole,
  type OrganisationStore,
  type RuntimeDeps,
  type UpdateOrganisationInput,
  type UserOrganisationMembership,
} from "@bitig/core";
import * as schema from "./schema";
import {
  accessTokens,
  memberships,
  organisations,
  projects,
  type InsertMembershipRecord,
  type InsertOrganisationRecord,
  type MembershipRecord,
  type OrganisationRecord,
} from "./schema";

function isD1Database(db: unknown): db is D1Database {
  return typeof db === "object" && db !== null && "prepare" in db && typeof db.prepare === "function";
}

function throwCustomValidation(context: string, field: string, message: string, input: unknown): never {
  throw new ValidationError(context, [{ code: "custom", path: [field], message, input }]);
}

function recordToOrganisation(row: OrganisationRecord): Organisation {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function organisationToRecord(org: Organisation): InsertOrganisationRecord {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: Date.parse(org.createdAt),
    updatedAt: Date.parse(org.updatedAt),
    deletedAt: null,
  };
}

function recordToMembership(row: MembershipRecord): Membership {
  return {
    orgId: row.orgId,
    userId: row.userId,
    role: row.role,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

function membershipToRecord(membership: Membership): InsertMembershipRecord {
  return {
    orgId: membership.orgId,
    userId: membership.userId,
    role: membership.role,
    createdAt: Date.parse(membership.createdAt),
  };
}

export class D1OrganisationStore implements OrganisationStore {
  readonly #db: DrizzleD1Database<typeof schema>;
  readonly #deps: RuntimeDeps;

  constructor(
    db: D1Database | DrizzleD1Database<typeof schema>,
    deps: RuntimeDeps = defaultRuntimeDeps,
  ) {
    this.#db = isD1Database(db) ? drizzle(db, { schema }) : db;
    this.#deps = deps;
  }

  async create(input: CreateOrganisationInput, ownerUserId: string): Promise<Organisation> {
    const validOwnerId = parseOrThrow(IdSchema, ownerUserId, "createOrganisation ownerUserId");
    const slugRows = await this.#db
      .select({ slug: organisations.slug })
      .from(organisations)
      .where(isNull(organisations.deletedAt))
      .all();
    const org = buildOrganisation(
      input,
      this.#deps,
      slugRows.map((r) => r.slug),
    );
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
    await this.#db.insert(organisations).values(organisationToRecord(org));
    await this.#db.insert(memberships).values(membershipToRecord(membership));
    return cloneOrganisation(org);
  }

  async getById(id: string): Promise<Organisation | null> {
    const validId = parseOrThrow(IdSchema, id, "getOrganisationById");
    const row = await this.#db
      .select()
      .from(organisations)
      .where(and(eq(organisations.id, validId), isNull(organisations.deletedAt)))
      .get();
    return row ? cloneOrganisation(recordToOrganisation(row)) : null;
  }

  async getBySlug(slug: string): Promise<Organisation | null> {
    const normalized = slug.trim().toLowerCase();
    const row = await this.#db
      .select()
      .from(organisations)
      .where(and(eq(organisations.slug, normalized), isNull(organisations.deletedAt)))
      .get();
    return row ? cloneOrganisation(recordToOrganisation(row)) : null;
  }

  async listAll(): Promise<Organisation[]> {
    const rows = await this.#db.select().from(organisations).where(isNull(organisations.deletedAt)).all();
    const orgs = rows
      .map(recordToOrganisation)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
    return orgs.map(cloneOrganisation);
  }

  async listForUser(userId: string): Promise<UserOrganisationMembership[]> {
    const validUserId = parseOrThrow(IdSchema, userId, "listOrganisationsForUser");
    const mRows = await this.#db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, validUserId))
      .all();
    if (mRows.length === 0) return [];
    const allOrgs = await this.#db.select().from(organisations).where(isNull(organisations.deletedAt)).all();
    const orgById = new Map(allOrgs.map((o) => [o.id, recordToOrganisation(o)]));
    const result: UserOrganisationMembership[] = [];
    for (const m of mRows) {
      const org = orgById.get(m.orgId);
      if (!org) continue;
      result.push({
        organisation: cloneOrganisation(org),
        role: m.role,
        joinedAt: new Date(m.createdAt).toISOString(),
      });
    }
    result.sort(
      (a, b) =>
        Date.parse(a.organisation.createdAt) - Date.parse(b.organisation.createdAt) ||
        a.organisation.id.localeCompare(b.organisation.id),
    );
    return result;
  }

  async rename(id: string, patch: UpdateOrganisationInput): Promise<Organisation> {
    const validId = parseOrThrow(IdSchema, id, "renameOrganisation");
    const existingRow = await this.#db
      .select()
      .from(organisations)
      .where(and(eq(organisations.id, validId), isNull(organisations.deletedAt)))
      .get();
    if (!existingRow) throw new NotFoundError("organisation", validId);
    const otherSlugs = await this.#db
      .select({ slug: organisations.slug })
      .from(organisations)
      .where(and(ne(organisations.id, validId), isNull(organisations.deletedAt)))
      .all();
    const next = applyOrganisationPatch(
      recordToOrganisation(existingRow),
      patch,
      this.#deps.clock(),
      otherSlugs.map((r) => r.slug),
    );
    await this.#db.update(organisations).set(organisationToRecord(next)).where(eq(organisations.id, validId));
    return cloneOrganisation(next);
  }

  async delete(id: string): Promise<void> {
    const validId = parseOrThrow(IdSchema, id, "deleteOrganisation");
    const existingRow = await this.#db
      .select()
      .from(organisations)
      .where(and(eq(organisations.id, validId), isNull(organisations.deletedAt)))
      .get();
    if (!existingRow) throw new NotFoundError("organisation", validId);
    const now = this.#deps.clock().getTime();
    await this.#db
      .update(accessTokens)
      .set({ revokedAt: now })
      .where(and(eq(accessTokens.orgId, validId), isNull(accessTokens.revokedAt)));
    await this.#db
      .update(projects)
      .set({ archived: true, key: null, updatedAt: now })
      .where(eq(projects.orgId, validId));
    await this.#db.delete(memberships).where(eq(memberships.orgId, validId));
    await this.#db
      .update(organisations)
      .set({
        deletedAt: now,
        updatedAt: now,
        slug: `${existingRow.slug.slice(0, 40)}-del-${validId.slice(0, 8)}`,
      })
      .where(eq(organisations.id, validId));
  }

  async getMembership(orgId: string, userId: string): Promise<Membership | null> {
    const validOrgId = parseOrThrow(IdSchema, orgId, "getMembership orgId");
    const validUserId = parseOrThrow(IdSchema, userId, "getMembership userId");
    const orgRow = await this.#db
      .select({ id: organisations.id })
      .from(organisations)
      .where(and(eq(organisations.id, validOrgId), isNull(organisations.deletedAt)))
      .get();
    if (!orgRow) return null;
    const row = await this.#db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, validOrgId), eq(memberships.userId, validUserId)))
      .get();
    return row ? cloneMembership(recordToMembership(row)) : null;
  }

  async addMember(orgId: string, userId: string, role: OrganisationRole): Promise<Membership> {
    const validOrgId = parseOrThrow(IdSchema, orgId, "addMember orgId");
    const validUserId = parseOrThrow(IdSchema, userId, "addMember userId");
    const validRole = parseOrThrow(OrganisationRoleSchema, role, "addMember role");
    const orgRow = await this.#db
      .select()
      .from(organisations)
      .where(and(eq(organisations.id, validOrgId), isNull(organisations.deletedAt)))
      .get();
    if (!orgRow) throw new NotFoundError("organisation", validOrgId);
    const existing = await this.#db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, validOrgId), eq(memberships.userId, validUserId)))
      .get();
    if (existing) {
      throwCustomValidation("addMember", "userId", "user is already a member", validUserId);
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
    await this.#db.insert(memberships).values(membershipToRecord(membership));
    return cloneMembership(membership);
  }

  async updateMemberRole(orgId: string, userId: string, role: OrganisationRole): Promise<Membership> {
    const validOrgId = parseOrThrow(IdSchema, orgId, "updateMemberRole orgId");
    const validUserId = parseOrThrow(IdSchema, userId, "updateMemberRole userId");
    const validRole = parseOrThrow(OrganisationRoleSchema, role, "updateMemberRole role");
    const existingRow = await this.#db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, validOrgId), eq(memberships.userId, validUserId)))
      .get();
    if (!existingRow) throw new NotFoundError("membership", `${validOrgId}:${validUserId}`);
    if (existingRow.role === "owner" && validRole !== "owner") {
      const owners = await this.#db
        .select()
        .from(memberships)
        .where(and(eq(memberships.orgId, validOrgId), eq(memberships.role, "owner")))
        .all();
      if (owners.length <= 1) {
        throwCustomValidation("updateMemberRole", "role", "organisation must have at least one owner", validRole);
      }
    }
    await this.#db
      .update(memberships)
      .set({ role: validRole })
      .where(and(eq(memberships.orgId, validOrgId), eq(memberships.userId, validUserId)));
    const next: Membership = {
      orgId: validOrgId,
      userId: validUserId,
      role: validRole,
      createdAt: new Date(existingRow.createdAt).toISOString(),
    };
    return cloneMembership(next);
  }

  async removeMember(orgId: string, userId: string): Promise<void> {
    const validOrgId = parseOrThrow(IdSchema, orgId, "removeMember orgId");
    const validUserId = parseOrThrow(IdSchema, userId, "removeMember userId");
    const existingRow = await this.#db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, validOrgId), eq(memberships.userId, validUserId)))
      .get();
    if (!existingRow) throw new NotFoundError("membership", `${validOrgId}:${validUserId}`);
    if (existingRow.role === "owner") {
      const owners = await this.#db
        .select()
        .from(memberships)
        .where(and(eq(memberships.orgId, validOrgId), eq(memberships.role, "owner")))
        .all();
      if (owners.length <= 1) {
        throwCustomValidation("removeMember", "userId", "organisation must have at least one owner", validUserId);
      }
    }
    await this.#db
      .delete(memberships)
      .where(and(eq(memberships.orgId, validOrgId), eq(memberships.userId, validUserId)));
  }

  async listMembers(orgId: string): Promise<Membership[]> {
    const validOrgId = parseOrThrow(IdSchema, orgId, "listMembers orgId");
    const orgRow = await this.#db
      .select()
      .from(organisations)
      .where(and(eq(organisations.id, validOrgId), isNull(organisations.deletedAt)))
      .get();
    if (!orgRow) throw new NotFoundError("organisation", validOrgId);
    const rows = await this.#db.select().from(memberships).where(eq(memberships.orgId, validOrgId)).all();
    return rows
      .map(recordToMembership)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.userId.localeCompare(b.userId))
      .map(cloneMembership);
  }
}
