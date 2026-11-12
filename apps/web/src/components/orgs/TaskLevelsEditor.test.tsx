import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRunLevels, RunOrchestrationApiError, saveRunLevels } from "../../services/run-orchestration";
import type * as RunOrchestration from "../../services/run-orchestration";
import { fetchT3Capabilities, fetchT3Hosts } from "../../services/t3";
import { TaskLevelsEditor } from "./TaskLevelsEditor";

vi.mock("../../services/run-orchestration", async (importActual) => ({
  RunOrchestrationApiError: (await importActual<typeof RunOrchestration>()).RunOrchestrationApiError,
  fetchRunLevels: vi.fn(),
  saveRunLevels: vi.fn(),
}));

vi.mock("../../services/t3", () => ({
  fetchT3Hosts: vi.fn(),
  fetchT3Capabilities: vi.fn(),
}));

const SERVER = {
  levels: [
    { key: "cheap", label: "Cheap", description: "Small edits", order: 0 },
    { key: "strong", label: "Strong", description: "Hard problems", order: 1 },
  ],
  models: [{ levelKey: "strong", hostId: null, selection: { providerInstanceId: "prov-claude", model: "claude-opus" } }],
};

function host(id: string) {
  return {
    id,
    label: `Host ${id}`,
    kind: "user" as const,
    projectsRoot: "~/www",
    connected: true as const,
    mcpUrl: "https://t3.example.test/mcp",
    issuer: "https://t3.example.test",
    connectedAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    expiresInDays: 19,
    expiringSoon: false,
    expired: false,
  };
}

function rowAt(rows: readonly HTMLElement[], index: number): HTMLElement {
  const row = rows[index];
  if (!row) throw new Error(`expected a level row at ${String(index)}`);
  return row;
}

describe("TaskLevelsEditor (#BIT-188)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchRunLevels).mockResolvedValue(SERVER);
    vi.mocked(fetchT3Hosts).mockResolvedValue([host("a"), host("b")]);
    vi.mocked(fetchT3Capabilities).mockImplementation((_signal, context) =>
      Promise.resolve(
        context?.hostId === "a"
          ? [{ providerInstanceId: "prov-claude", model: "claude-opus", label: "Claude Opus" }]
          : [{ providerInstanceId: "prov-codex", model: "gpt-6", label: "GPT 6", options: [{ id: "effort", values: ["low", "high"] }] }],
      ),
    );
    vi.mocked(saveRunLevels).mockImplementation((_slug, input) =>
      Promise.resolve({
        levels: input.levels.map((l) => ({ ...l })),
        models: input.models.map((m) => ({ ...m })),
      }),
    );
  });

  it("renames, reorders, adds a level and maps models with a per-host override", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<TaskLevelsEditor orgSlug="acme" isActiveOrg onSaved={onSaved} />);

    const rows = await screen.findAllByTestId("task-level-row");
    expect(rows).toHaveLength(2);
    const firstName = within(rowAt(rows, 0)).getByLabelText("Level name");
    await user.clear(firstName);
    await user.type(firstName, "Quick");
    await user.click(screen.getByRole("button", { name: "Move Quick down" }));

    await user.click(screen.getByRole("button", { name: "Add level" }));
    const added = rowAt(await screen.findAllByTestId("task-level-row"), 2);
    expect(screen.getByRole("button", { name: "Save task levels" })).toBeDisabled();
    await user.type(within(added).getByLabelText("When to use"), "Umbrella orchestration");
    await waitFor(() => {
      expect(within(added).getAllByRole("combobox").length).toBeGreaterThan(1);
    });
    await user.selectOptions(within(added).getByLabelText("On Host b"), "prov-codex::gpt-6");
    await user.selectOptions(within(added).getByRole("combobox", { name: "T3 effort" }), "str:high");

    await user.click(screen.getByRole("button", { name: "Save task levels" }));

    expect(saveRunLevels).toHaveBeenCalledWith("acme", {
      levels: [
        { key: "strong", label: "Strong", description: "Hard problems", order: 0 },
        { key: "cheap", label: "Quick", description: "Small edits", order: 1 },
        { key: "new-level", label: "New level", description: "Umbrella orchestration", order: 2 },
      ],
      models: [
        { levelKey: "strong", hostId: null, selection: { providerInstanceId: "prov-claude", model: "claude-opus" } },
        {
          levelKey: "new-level",
          hostId: "b",
          selection: { providerInstanceId: "prov-codex", model: "gpt-6", options: [{ id: "effort", value: "high" }] },
        },
      ],
    });
    expect(await screen.findByText("Task levels saved.")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalled();
  });

  it("asks which level replaces a removed level that is still in use", async () => {
    const user = userEvent.setup();
    vi.mocked(saveRunLevels).mockRejectedValueOnce(
      new RunOrchestrationApiError(400, 'Run level "cheap" is still used by tasks or projects.', [
        { message: "still used", path: ["replacementKey"] },
      ]),
    );
    render(<TaskLevelsEditor orgSlug="acme" isActiveOrg={false} />);

    await user.click(await screen.findByRole("button", { name: "Remove Cheap" }));
    await user.click(screen.getByRole("button", { name: "Save task levels" }));

    const prompt = await screen.findByRole("group", { name: "Choose replacement levels" });
    expect(within(prompt).getByRole("combobox", { name: "Replacement for cheap" })).toHaveValue("strong");
    await user.click(within(prompt).getByRole("button", { name: "Replace and save" }));

    expect(saveRunLevels).toHaveBeenLastCalledWith(
      "acme",
      expect.objectContaining({ replacementKeys: { cheap: "strong" } }),
    );
    expect(await screen.findByText("Task levels saved.")).toBeInTheDocument();
    // Another organisation's model list is not loaded.
    expect(fetchT3Hosts).not.toHaveBeenCalled();
  });

  it("shows other save errors without the replacement prompt", async () => {
    const user = userEvent.setup();
    vi.mocked(saveRunLevels).mockRejectedValueOnce(new RunOrchestrationApiError(400, "Model is not available"));
    render(<TaskLevelsEditor orgSlug="acme" isActiveOrg={false} />);

    await user.click(await screen.findByRole("button", { name: "Save task levels" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Model is not available");
    expect(screen.queryByRole("group", { name: "Choose replacement levels" })).not.toBeInTheDocument();
  });
});
