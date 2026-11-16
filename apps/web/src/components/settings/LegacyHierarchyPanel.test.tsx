import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacyHierarchyInventoryResponse, Project } from "@bitig/core";
import * as hierarchyService from "../../services/hierarchy";
import { LegacyHierarchyPanel } from "./LegacyHierarchyPanel";

const NOW = "2026-11-15T12:00:00.000Z";

const PROJECT_A: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig",
  key: "BIT",
  description: "",
  kind: "paid",
  createdAt: NOW,
  updatedAt: NOW,
};

const INVENTORY: LegacyHierarchyInventoryResponse = {
  hierarchyMode: "explicit",
  totalTasks: 5,
  alreadyParentedCount: 1,
  candidates: [
    {
      childTaskId: "01940000-0000-7000-8000-000000000102",
      childCode: "BIT-2",
      childTitle: "Clean candidate",
      childProjectId: PROJECT_A.id,
      childStatus: "todo",
      proposedParentId: "01940000-0000-7000-8000-000000000101",
      proposedParentCode: "BIT-1",
      proposedParentTitle: "Umbrella root",
      proposedParentProjectId: PROJECT_A.id,
      provenance: ["checklist_mention"],
      conflicts: [],
      importable: true,
    },
    {
      childTaskId: "01940000-0000-7000-8000-000000000103",
      childCode: "BIT-3",
      childTitle: "Cross-project candidate",
      childProjectId: "01940000-0000-7000-8000-000000000009",
      childStatus: "todo",
      proposedParentId: "01940000-0000-7000-8000-000000000101",
      proposedParentCode: "BIT-1",
      proposedParentTitle: "Umbrella root",
      proposedParentProjectId: PROJECT_A.id,
      provenance: ["description_mention"],
      conflicts: ["cross_project"],
      importable: false,
    },
  ],
};

describe("LegacyHierarchyPanel (#BIT-195)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads read-only inventory without auto-importing and requires explicit human confirmation", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi
      .spyOn(hierarchyService, "fetchLegacyHierarchyInventory")
      .mockResolvedValue(INVENTORY);
    const importSpy = vi.spyOn(hierarchyService, "importLegacyHierarchy").mockResolvedValue({
      imported: [
        {
          childTaskId: "01940000-0000-7000-8000-000000000102",
          childCode: "BIT-2",
          parentTaskId: "01940000-0000-7000-8000-000000000101",
          parentCode: "BIT-1",
        },
      ],
      rejected: [],
    });

    render(<LegacyHierarchyPanel projects={[PROJECT_A]} role="editor" />);

    expect(await screen.findByTestId("hierarchy-mode-badge")).toHaveTextContent("Mode: explicit");
    expect(importSpy).not.toHaveBeenCalled();

    const cleanRow = screen.getByTestId("hierarchy-candidate-BIT-2-BIT-1");
    expect(within(cleanRow).getByText("Checklist mention")).toBeInTheDocument();
    const cleanCheckbox = within(cleanRow).getByRole("checkbox");
    expect(cleanCheckbox).not.toBeDisabled();
    expect(cleanCheckbox).not.toBeChecked();

    const conflictRow = screen.getByTestId("hierarchy-candidate-BIT-3-BIT-1");
    expect(within(conflictRow).getByText("Cross-project")).toBeInTheDocument();
    expect(within(conflictRow).getByRole("checkbox")).toBeDisabled();

    const confirmBtn = screen.getByRole("button", { name: "Import selected (0)" });
    expect(confirmBtn).toBeDisabled();

    await user.click(cleanCheckbox);
    expect(screen.getByRole("button", { name: "Import selected (1)" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Import selected (1)" }));

    expect(importSpy).toHaveBeenCalledWith({
      edges: [
        {
          childTaskId: "01940000-0000-7000-8000-000000000102",
          parentTaskId: "01940000-0000-7000-8000-000000000101",
        },
      ],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Imported 1 explicit parent link.");
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("renders read-only for viewers without import controls", async () => {
    vi.spyOn(hierarchyService, "fetchLegacyHierarchyInventory").mockResolvedValue(INVENTORY);

    render(<LegacyHierarchyPanel projects={[PROJECT_A]} role="viewer" />);

    expect(await screen.findByText("Read-only (viewer)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Import selected/i })).not.toBeInTheDocument();
    expect(within(screen.getByTestId("hierarchy-candidate-BIT-2-BIT-1")).getByRole("checkbox")).toBeDisabled();
  });
});
