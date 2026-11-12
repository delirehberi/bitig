import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteAiRouter, fetchAiRouter, saveAiRouter, testAiRouter } from "../../services/run-orchestration";
import { AiRouterSection } from "./AiRouterSection";

vi.mock("../../services/run-orchestration", () => ({
  fetchAiRouter: vi.fn(),
  saveAiRouter: vi.fn(),
  deleteAiRouter: vi.fn(),
  testAiRouter: vi.fn(),
}));

const CONFIGURED = {
  orgId: "org-1",
  baseUrl: "https://router.example.test/v1",
  model: "@cf/meta/llama",
  apiStyle: "cloudflare-run" as const,
  hasToken: true,
  tokenLast4: "1234",
  enabled: true,
  configured: true,
};

const EMPTY = { ...CONFIGURED, baseUrl: "", model: "", hasToken: false, tokenLast4: undefined, enabled: false, configured: false };

describe("AiRouterSection (#BIT-188)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchAiRouter).mockResolvedValue(CONFIGURED);
  });

  it("shows the stored token only as its last four characters and never fills it in", async () => {
    render(<AiRouterSection orgSlug="acme" />);
    expect(await screen.findByTestId("ai-router-token-status")).toHaveTextContent("Set, ends in 1234");
    expect(screen.getByLabelText("API token")).toHaveValue("");
    expect(screen.getByLabelText("API token")).toHaveAttribute("type", "password");
  });

  it("saves a replacement token, then clears the field", async () => {
    const user = userEvent.setup();
    vi.mocked(saveAiRouter).mockResolvedValue({ ...CONFIGURED, tokenLast4: "9876" });
    render(<AiRouterSection orgSlug="acme" />);

    await user.type(await screen.findByLabelText("API token"), "sk-new-9876");
    await user.click(screen.getByRole("checkbox", { name: /enabled/i }));
    await user.click(screen.getByRole("button", { name: "Save router" }));

    expect(saveAiRouter).toHaveBeenCalledWith("acme", {
      baseUrl: CONFIGURED.baseUrl,
      model: CONFIGURED.model,
      apiStyle: "cloudflare-run",
      enabled: false,
      apiToken: "sk-new-9876",
    });
    expect(await screen.findByTestId("ai-router-token-status")).toHaveTextContent("Set, ends in 9876");
    expect(screen.getByLabelText("API token")).toHaveValue("");
  });

  it("removes the stored token on save", async () => {
    const user = userEvent.setup();
    vi.mocked(saveAiRouter).mockResolvedValue({ ...CONFIGURED, hasToken: false, tokenLast4: undefined });
    render(<AiRouterSection orgSlug="acme" />);

    await user.click(await screen.findByRole("button", { name: "Remove token" }));
    expect(screen.getByTestId("ai-router-token-status")).toHaveTextContent("will be removed on save");
    await user.click(screen.getByRole("button", { name: "Save router" }));

    expect(saveAiRouter).toHaveBeenCalledWith("acme", expect.objectContaining({ clearToken: true }));
    expect(vi.mocked(saveAiRouter).mock.calls[0]?.[1]).not.toHaveProperty("apiToken");
    expect(await screen.findByTestId("ai-router-token-status")).toHaveTextContent("Not set");
  });

  it("tests the endpoint and shows whether it answered", async () => {
    const user = userEvent.setup();
    vi.mocked(testAiRouter)
      .mockResolvedValueOnce({ ok: true, suggestion: { level: "strong", reason: "r", confidence: 0.9 } })
      .mockResolvedValueOnce({ ok: false, status: 401, error: "Unauthorized" });
    render(<AiRouterSection orgSlug="acme" />);

    await user.click(await screen.findByRole("button", { name: "Test" }));
    expect(testAiRouter).toHaveBeenCalledWith("acme", {
      baseUrl: CONFIGURED.baseUrl,
      model: CONFIGURED.model,
      apiStyle: "cloudflare-run",
    });
    expect(await screen.findByTestId("ai-router-test-result")).toHaveTextContent('suggests level "strong"');

    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByTestId("ai-router-test-result")).toHaveTextContent(
      "The endpoint did not answer (HTTP 401): Unauthorized",
    );
  });

  it("needs an endpoint, model and token before testing or saving a new router", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAiRouter).mockResolvedValue(EMPTY);
    vi.mocked(deleteAiRouter).mockResolvedValue(EMPTY);
    render(<AiRouterSection orgSlug="acme" />);

    expect(await screen.findByTestId("ai-router-token-status")).toHaveTextContent("Not set");
    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save router" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Remove router" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Endpoint URL"), "https://router.example.test");
    await user.type(screen.getByLabelText("Model ID"), "m");
    expect(screen.getByRole("button", { name: "Save router" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled();
    await user.type(screen.getByLabelText("API token"), "tok");
    expect(screen.getByRole("button", { name: "Test" })).toBeEnabled();
  });
});
