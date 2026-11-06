import { describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "./errors";
import { InMemoryUserStore } from "./users";
import { InMemoryOrganisationStore } from "./organisations";
import { canPerformOrgAction, requiredOrgRoleForMcpTool } from "./permissions";

describe("InMemoryUserStore", () => {
  it("creates, finds, updates, lists, and deletes users", async () => {
    const store = new InMemoryUserStore();
    const alice = await store.create({
      email: "Alice@Example.com",
      username: "Alice_Dev",
      displayName: "Alice",
      platformRole: "admin",
    });
    expect(alice.email).toBe("alice@example.com");
    expect(alice.username).toBe("alice_dev");
    expect(alice.platformRole).toBe("admin");
    expect(alice.status).toBe("active");

    const foundByEmail = await store.getByEmail("ALICE@EXAMPLE.COM");
    expect(foundByEmail?.id).toBe(alice.id);

    const foundByUsername = await store.getByUsername("ALICE_DEV");
    expect(foundByUsername?.id).toBe(alice.id);

    await expect(
      store.create({
        email: "alice@example.com",
        username: "other_user",
        displayName: "Other",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      store.create({
        email: "other@example.com",
        username: "alice_dev",
        displayName: "Other",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const bob = await store.create({
      email: "bob@example.com",
      username: "bob",
      displayName: "Bob",
      platformRole: "admin",
    });

    const updatedBob = await store.update(bob.id, {
      displayName: "Bob Builder",
      platformRole: "user",
      avatarUrl: "https://example.com/bob.png",
    });
    expect(updatedBob.displayName).toBe("Bob Builder");
    expect(updatedBob.platformRole).toBe("user");
    expect(updatedBob.avatarUrl).toBe("https://example.com/bob.png");

    // Cannot demote or disable or delete the last active admin (Alice)
    await expect(store.update(alice.id, { platformRole: "user" })).rejects.toBeInstanceOf(ValidationError);
    await expect(store.update(alice.id, { status: "disabled" })).rejects.toBeInstanceOf(ValidationError);
    await expect(store.delete(alice.id)).rejects.toBeInstanceOf(ValidationError);

    const listed = await store.list({ search: "bob" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(bob.id);

    await store.delete(bob.id);
    expect(await store.getById(bob.id)).toBeNull();
  });

  it("stores, normalizes, validates, and clears the NIP-05 identifier", async () => {
    const store = new InMemoryUserStore();
    const carol = await store.create({
      email: "carol@example.com",
      username: "carol",
      displayName: "Carol",
      nip05: " Carol@Example.COM ",
    });
    expect(carol.nip05).toBe("carol@example.com");

    await expect(store.update(carol.id, { nip05: "not-an-identifier" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(store.update(carol.id, { nip05: "evil@<script>.com" })).rejects.toBeInstanceOf(
      ValidationError,
    );

    const underscore = await store.update(carol.id, { nip05: "_@carol.dev" });
    expect(underscore.nip05).toBe("_@carol.dev");

    const cleared = await store.update(carol.id, { nip05: null });
    expect(cleared.nip05).toBeUndefined();
    expect("nip05" in cleared).toBe(false);
  });
});

describe("InMemoryOrganisationStore", () => {
  it("creates organisations, manages memberships, and enforces last-owner invariant", async () => {
    const store = new InMemoryOrganisationStore();
    const user1 = "01a10000-0000-7000-8000-000000000010";
    const user2 = "01a10000-0000-7000-8000-000000000020";

    const org = await store.create({ name: "Acme Corp", slug: "acme-corp" }, user1);
    expect(org.slug).toBe("acme-corp");

    const m1 = await store.getMembership(org.id, user1);
    expect(m1?.role).toBe("owner");

    // Cannot demote or remove the last owner
    await expect(store.updateMemberRole(org.id, user1, "editor")).rejects.toBeInstanceOf(ValidationError);
    await expect(store.removeMember(org.id, user1)).rejects.toBeInstanceOf(ValidationError);

    // Add second member as owner, then demote user1
    await store.addMember(org.id, user2, "owner");
    const demoted = await store.updateMemberRole(org.id, user1, "editor");
    expect(demoted.role).toBe("editor");

    await store.removeMember(org.id, user1);
    expect(await store.getMembership(org.id, user1)).toBeNull();

    await store.delete(org.id);
    expect(await store.getById(org.id)).toBeNull();
    await expect(store.delete(org.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("permissions", () => {
  it("enforces viewer, editor, and owner role hierarchy", () => {
    expect(canPerformOrgAction("viewer", "org:read")).toBe(true);
    expect(canPerformOrgAction("viewer", "task:write")).toBe(false);
    expect(canPerformOrgAction("editor", "task:write")).toBe(true);
    expect(canPerformOrgAction("editor", "org:manage")).toBe(false);
    expect(canPerformOrgAction("owner", "org:manage")).toBe(true);

    expect(requiredOrgRoleForMcpTool("list_tasks")).toBe("viewer");
    expect(requiredOrgRoleForMcpTool("add_task")).toBe("editor");
    expect(requiredOrgRoleForMcpTool("report_t3_git_metadata")).toBe("editor");
  });
});
