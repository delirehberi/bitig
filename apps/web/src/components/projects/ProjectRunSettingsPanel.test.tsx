import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchProjectRunSettings, saveProjectRunSettings } from "../../services/run-orchestration";
import { ProjectRunSettingsPanel } from "./ProjectRunSettingsPanel";

vi.mock("../../services/run-orchestration", () => ({
  fetchProjectRunSettings: vi.fn(),
  saveProjectRunSettings: vi.fn(),
}));

const LEVELS = [
  { key: "cheap", label: "Cheap", description: "Small", order: 0 },
  { key: "strong", label: "Strong", description: "Hard", order: 1 },
];

describe("ProjectRunSettingsPanel (#BIT-188)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchProjectRunSettings).mockResolvedValue({
      projectId: "p1",
      serialPaths: ["migrations/**"],
      maxParallelChildren: 3,
    });
  });

  it("saves the default level, serial paths and max parallel children", async () => {
    const user = userEvent.setup();
    vi.mocked(saveProjectRunSettings).mockResolvedValue({
      projectId: "p1",
      defaultRunLevel: "strong",
      serialPaths: ["migrations/**", "schema.ts"],
      maxParallelChildren: 5,
    });
    render(<ProjectRunSettingsPanel projectId="p1" levels={LEVELS} />);

    await user.selectOptions(await screen.findByLabelText("Default level"), "strong");
    await user.type(screen.getByLabelText(/serial paths/i), "{enter}schema.ts");
    const max = screen.getByLabelText("Max parallel children");
    await user.clear(max);
    await user.type(max, "5");
    await user.click(screen.getByRole("button", { name: "Save run settings" }));

    expect(saveProjectRunSettings).toHaveBeenCalledWith("p1", {
      defaultRunLevel: "strong",
      serialPaths: ["migrations/**", "schema.ts"],
      maxParallelChildren: 5,
    });
    expect(await screen.findByText("Run settings saved.")).toBeInTheDocument();
  });

  it("blocks an out-of-range max parallel children", async () => {
    const user = userEvent.setup();
    render(<ProjectRunSettingsPanel projectId="p1" levels={LEVELS} />);
    const max = await screen.findByLabelText("Max parallel children");
    await user.clear(max);
    await user.type(max, "99");
    expect(screen.getByText(/whole number from 1 to 20/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save run settings" })).toBeDisabled();
  });

  it("stays hidden when the settings cannot be loaded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(fetchProjectRunSettings).mockRejectedValue(new Error("not found"));
    const { container } = render(<ProjectRunSettingsPanel projectId="p1" levels={LEVELS} />);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
    warn.mockRestore();
  });
});
