import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "@bitig/core";
import { AuthContext, type AuthContextValue } from "../../auth/auth-types";
import { ProfileEditView } from "./ProfileEditView";
import { ProfileView } from "./ProfileView";
import { formatNip05 } from "./nip05";

const PUBKEY = "a".repeat(64);

const NOSTR_USER: User = {
  id: "01a10000-0000-7000-8000-000000000030",
  email: `${PUBKEY}@nostr.local`,
  username: "nostr-aaaaaaaaaaaaaaaa",
  displayName: "Nostr (aaaaaaaa)",
  platformRole: "user",
  status: "active",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const EMAIL_USER: User = { ...NOSTR_USER, email: "alice@example.com", username: "alice", displayName: "Alice" };

function authValue(profile: User, refreshAuth: () => Promise<void> = () => Promise.resolve()): AuthContextValue {
  const unused = () => Promise.reject(new Error("not used in this test"));
  return {
    status: "authenticated",
    user: profile.username,
    profile,
    memberships: [],
    needsOnboarding: false,
    currentOrg: null,
    currentRole: "viewer",
    isAdmin: false,
    selectOrg: () => undefined,
    refreshAuth,
    requestSignInCode: unused,
    requestRegistrationCode: unused,
    verifyAuthCode: unused,
    loginWithPassword: unused,
    loginWithNostr: unused,
    logout: unused,
    expire: () => undefined,
  };
}

function stubSync(response: Response | Error) {
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    if (!url.includes("/api/me/nostr/sync")) return Promise.reject(new Error(`unexpected request ${url}`));
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProfileEditView Nostr fetch", () => {
  it("fills empty fields from Nostr and refreshes the session profile", async () => {
    const refreshAuth = vi.fn(() => Promise.resolve());
    const updated: User = {
      ...NOSTR_USER,
      displayName: "Grace",
      avatarUrl: "https://cdn.test/grace.png",
      nip05: "grace@example.com",
    };
    const fetchMock = stubSync(
      Response.json({ user: updated, found: true, updated: ["displayName", "avatarUrl", "nip05"] }),
    );
    render(
      <AuthContext.Provider value={authValue(NOSTR_USER, refreshAuth)}>
        <ProfileEditView />
      </AuthContext.Provider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Fetch my profile from Nostr" }));

    expect(await screen.findByText("Filled from Nostr: display name, avatar, NIP-05.")).toBeInTheDocument();
    expect(screen.getByLabelText("Display name")).toHaveValue("Grace");
    expect(screen.getByLabelText(/Avatar URL/)).toHaveValue("https://cdn.test/grace.png");
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  it("keeps unsaved edits in the form", async () => {
    stubSync(
      Response.json({ user: { ...NOSTR_USER, displayName: "Relay Name" }, found: true, updated: ["displayName"] }),
    );
    render(
      <AuthContext.Provider value={authValue(NOSTR_USER)}>
        <ProfileEditView />
      </AuthContext.Provider>,
    );
    const nameInput = screen.getByLabelText("Display name");
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Typed By Me");

    await userEvent.click(screen.getByRole("button", { name: "Fetch my profile from Nostr" }));

    expect(await screen.findByText("Filled from Nostr: display name.")).toBeInTheDocument();
    expect(nameInput).toHaveValue("Typed By Me");
  });

  it("explains when no profile was found or nothing changed", async () => {
    stubSync(Response.json({ user: NOSTR_USER, found: false, updated: [] }));
    const { unmount } = render(
      <AuthContext.Provider value={authValue(NOSTR_USER)}>
        <ProfileEditView />
      </AuthContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Fetch my profile from Nostr" }));
    expect(await screen.findByText("No Nostr profile was found on the relays.")).toBeInTheDocument();
    unmount();

    stubSync(Response.json({ user: NOSTR_USER, found: true, updated: [] }));
    render(
      <AuthContext.Provider value={authValue(NOSTR_USER)}>
        <ProfileEditView />
      </AuthContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Fetch my profile from Nostr" }));
    expect(
      await screen.findByText("Your profile has no empty fields to fill, so nothing changed."),
    ).toBeInTheDocument();
  });

  it("shows the server's error message", async () => {
    stubSync(Response.json({ error: "too_many_requests", message: "Rate limit exceeded." }, { status: 429 }));
    render(
      <AuthContext.Provider value={authValue(NOSTR_USER)}>
        <ProfileEditView />
      </AuthContext.Provider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Fetch my profile from Nostr" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Rate limit exceeded.");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Fetch my profile from Nostr" })).toBeEnabled();
    });
  });

  it("hides the Nostr section for email accounts", () => {
    render(
      <AuthContext.Provider value={authValue(EMAIL_USER)}>
        <ProfileEditView />
      </AuthContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: "Fetch my profile from Nostr" })).not.toBeInTheDocument();
  });
});

describe("ProfileView NIP-05", () => {
  it("shows a verified NIP-05 and hides the row when unset", () => {
    const { unmount } = render(
      <AuthContext.Provider value={authValue({ ...NOSTR_USER, nip05: "grace@example.com" })}>
        <ProfileView />
      </AuthContext.Provider>,
    );
    expect(screen.getByText("NIP-05")).toBeInTheDocument();
    expect(screen.getByText("grace@example.com")).toBeInTheDocument();
    unmount();

    render(
      <AuthContext.Provider value={authValue(NOSTR_USER)}>
        <ProfileView />
      </AuthContext.Provider>,
    );
    expect(screen.queryByText("NIP-05")).not.toBeInTheDocument();
  });

  it("shows a root identifier as the bare domain", () => {
    expect(formatNip05("_@example.com")).toBe("example.com");
    expect(formatNip05("grace@example.com")).toBe("grace@example.com");
  });
});
