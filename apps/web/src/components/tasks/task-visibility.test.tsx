import type { StorageMode, Project, Task } from "@bitig/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "../../domain/feature-context";
import { TaskCard } from "./TaskCard";
import { TaskModal } from "./TaskModal";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig App",
  description: "",
  kind: "hobby",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const TASK: Task = {
  id: "01940000-0000-7000-8000-000000000002",
  projectId: PROJECT.id,
  title: "Write documentation",
  description: "",
  status: "todo",
  isPublic: true,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function renderCard(mode: StorageMode) {
  render(
    <FeatureFlagsProvider mode={mode}>
      <TaskCard
        task={TASK}
        projects={[PROJECT]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onComplete={vi.fn()}
        onStatusChange={vi.fn()}
      />
    </FeatureFlagsProvider>,
  );
}

function renderModal(mode: StorageMode) {
  render(
    <FeatureFlagsProvider mode={mode}>
      <TaskModal
        isOpen
        onClose={vi.fn()}
        onSubmit={vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined)}
        task={TASK}
        projects={[PROJECT]}
      />
    </FeatureFlagsProvider>,
  );
}

describe("task visibility controls", () => {
  it("shows the public badge and checkbox in nostr mode", () => {
    renderCard("nostr");
    renderModal("nostr");

    expect(screen.getByTitle("Public task (visible on Nostr relays)")).toBeInTheDocument();
    expect(screen.getByLabelText(/public task/i)).toBeChecked();
  });

  it.each<StorageMode>(["cloudflare", "local"])("hides them in %s mode", (mode) => {
    renderCard(mode);
    renderModal(mode);

    expect(screen.queryByTitle("Public task (visible on Nostr relays)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/public task/i)).not.toBeInTheDocument();
  });
});
