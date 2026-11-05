import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const ALICE_USER = {
  id: "01a10000-0000-7000-8000-000000000010",
  email: "alice@example.com",
  username: "alice",
  displayName: "Alice Example",
  platformRole: "admin" as const,
  status: "active" as const,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const ACME_ORG = {
  id: "01a10000-0000-7000-8000-000000000020",
  slug: "acme",
  name: "Acme Labs",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const BETA_ORG = {
  id: "01a10000-0000-7000-8000-000000000021",
  slug: "beta",
  name: "Beta Studio",
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
};

function stubMultiUserApi(options: {
  signedIn?: boolean;
  needsOnboarding?: boolean;
  memberships?: {
    organisation: typeof ACME_ORG;
    role: "owner" | "editor" | "viewer";
    joinedAt: string;
  }[];
}) {
  let signedIn = options.signedIn ?? true;
  let needsOnboarding = options.needsOnboarding ?? false;
  let memberships =
    options.memberships ??
    (needsOnboarding
      ? []
      : [
          { organisation: ACME_ORG, role: "owner" as const, joinedAt: "2026-10-01T00:00:00.000Z" },
          { organisation: BETA_ORG, role: "viewer" as const, joinedAt: "2026-10-02T00:00:00.000Z" },
        ]);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

      if (url.includes("/health")) {
        return Promise.resolve(Response.json({ status: "ok", version: "0.4.1", storageMode: "cloudflare" }));
      }

      if (url.includes("/api/auth/session")) {
        if (!signedIn) {
          return Promise.resolve(Response.json({ error: "unauthorized" }, { status: 401 }));
        }
        return Promise.resolve(
          Response.json({
            user: ALICE_USER.username,
            profile: ALICE_USER,
            memberships,
            needsOnboarding,
          }),
        );
      }

      if (url.includes("/api/auth/me")) {
        if (!signedIn) {
          return Promise.resolve(Response.json({ error: "unauthorized" }, { status: 401 }));
        }
        return Promise.resolve(
          Response.json({
            user: ALICE_USER,
            memberships,
            needsOnboarding,
          }),
        );
      }

      if (url.includes("/api/auth/code") || url.includes("/api/auth/register")) {
        return Promise.resolve(Response.json({ sent: true, email: "alice@example.com" }));
      }

      if (url.includes("/api/auth/verify")) {
        signedIn = true;
        return Promise.resolve(
          Response.json({
            user: ALICE_USER.username,
            profile: ALICE_USER,
            memberships,
            needsOnboarding,
          }),
        );
      }

      if (url.endsWith("/api/orgs") && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { name: string; slug?: string };
        const createdOrg = {
          id: "01a10000-0000-7000-8000-000000000099",
          name: body.name,
          slug: body.slug ?? "first-org",
          createdAt: "2026-10-03T00:00:00.000Z",
          updatedAt: "2026-10-03T00:00:00.000Z",
        };
        memberships = [{ organisation: createdOrg, role: "owner", joinedAt: createdOrg.createdAt }];
        needsOnboarding = false;
        return Promise.resolve(Response.json({ organisation: createdOrg, role: "owner" }, { status: 201 }));
      }

      if (url.includes("/api/orgs/acme/members")) {
        return Promise.resolve(
          Response.json({
            members: [
              {
                orgId: ACME_ORG.id,
                userId: ALICE_USER.id,
                role: "owner",
                createdAt: "2026-10-01T00:00:00.000Z",
                email: ALICE_USER.email,
                username: ALICE_USER.username,
                displayName: ALICE_USER.displayName,
              },
            ],
            invitations: [],
          }),
        );
      }

      if (url.includes("/api/orgs/acme/invitations")) {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as { email: string; role: string };
          return Promise.resolve(
            Response.json(
              {
                invitation: {
                  id: "inv-1",
                  orgId: ACME_ORG.id,
                  email: body.email,
                  role: body.role,
                  invitedBy: ALICE_USER.id,
                  expiresAt: "2026-10-10T00:00:00.000Z",
                  createdAt: "2026-10-03T00:00:00.000Z",
                },
                token: "invite-token-xyz",
                acceptUrl: "http://localhost:8787/register?invite=invite-token-xyz",
              },
              { status: 201 },
            ),
          );
        }
        return Promise.resolve(Response.json([]));
      }

      if (url.includes("/api/orgs/acme")) {
        return Promise.resolve(Response.json({ organisation: ACME_ORG, role: "owner" }));
      }

      if (url.includes("/api/me/sessions")) {
        return Promise.resolve(
          Response.json([
            {
              id: "sess-1",
              userId: ALICE_USER.id,
              userAgent: "Test Browser",
              createdAt: "2026-10-01T00:00:00.000Z",
              lastSeenAt: "2026-10-03T00:00:00.000Z",
              expiresAt: "2026-11-01T00:00:00.000Z",
              current: true,
            },
          ]),
        );
      }

      if (url.includes("/api/me/tokens")) {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as { name: string; orgId: string };
          return Promise.resolve(
            Response.json(
              {
                token: "btg_secret_token_value",
                credential: {
                  id: "tok-1",
                  userId: ALICE_USER.id,
                  orgId: body.orgId,
                  orgName: ACME_ORG.name,
                  orgSlug: ACME_ORG.slug,
                  name: body.name,
                  prefix: "btg_secr",
                  createdAt: "2026-10-03T00:00:00.000Z",
                },
              },
              { status: 201 },
            ),
          );
        }
        return Promise.resolve(Response.json([]));
      }

      if (url.includes("/api/admin/users")) {
        return Promise.resolve(
          Response.json({
            users: [{ ...ALICE_USER, orgCount: 2 }],
            total: 1,
          }),
        );
      }

      if (url.includes("/api/admin/orgs")) {
        return Promise.resolve(
          Response.json({
            organisations: [
              { ...ACME_ORG, memberCount: 1, projectCount: 1 },
              { ...BETA_ORG, memberCount: 1, projectCount: 0 },
            ],
          }),
        );
      }

      if (url.includes("/api/t3/runs")) {
        return Promise.resolve(Response.json({ runs: [], activeSessions: [] }));
      }

      return Promise.resolve(Response.json([]));
    }),
  );
}

describe("Multi-user web flows", () => {
  beforeEach(() => {
    try {
      window.localStorage.removeItem("bitig:active-org");
    } catch {
      // ignore if localStorage is disabled in test env
    }
    window.history.replaceState(null, "", "/app");
  });

  it("signs in with a 6-digit email verification code", async () => {
    const user = userEvent.setup();
    stubMultiUserApi({ signedIn: false });

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Sign In" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.click(screen.getByRole("button", { name: "Send sign-in code" }));

    expect(await screen.findByLabelText("Verification code")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Verification code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify & sign in" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(screen.getByLabelText("Active organisation")).toHaveValue("acme");
  });

  it("registers a new account on /register and requires onboarding when no organisation exists", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/register");
    stubMultiUserApi({ signedIn: false, needsOnboarding: true });

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Create Account" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "alice@example.com");
    await user.type(screen.getByLabelText("Username"), "alice");
    await user.type(screen.getByLabelText("Display name"), "Alice Example");
    await user.click(screen.getByRole("button", { name: "Send verification code" }));

    expect(await screen.findByLabelText("Verification code")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Verification code"), "654321");
    await user.click(screen.getByRole("button", { name: "Complete registration" }));

    // Needs onboarding gate appears before entering the workspace
    expect(
      await screen.findByRole("heading", { level: 1, name: "Create your first organisation" }),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Organisation name"), "First Org");
    await user.click(screen.getByRole("button", { name: "Create organisation & continue" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
  });

  it("renders profile, security/tokens, organisation members, organisation settings, and admin users pages", async () => {
    const user = userEvent.setup();
    stubMultiUserApi({ signedIn: true });

    window.history.replaceState(null, "", "/profile");
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Profile" })).toBeInTheDocument();
    expect(screen.getByText("@alice")).toBeInTheDocument();
    expect(screen.getByText("Acme Labs")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /sessions & tokens/i }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sessions & API Tokens" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Token name"), "My CLI Token");
    await user.click(screen.getByRole("button", { name: "Generate token" }));
    expect(await screen.findByText("btg_secret_token_value")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Members" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Organisation Members" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Email address"), "bob@example.com");
    await user.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => {
      expect(screen.getByText(/invite-token-xyz/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("link", { name: "Admin Users" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Platform Administration" })).toBeInTheDocument();
  });
});
