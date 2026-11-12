import { InMemoryStorage, type AgentRun, type Project, type RunLevel, type Task } from "@bitig/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchT3Capabilities,
  fetchT3Connection,
  fetchT3ProjectMappings,
  fetchTaskT3Run,
  startTaskT3Run,
} from "../../services/t3";
import type * as T3Service from "../../services/t3";
import {
  fetchTaskRunProfile,
  saveTaskRunProfile,
  suggestTaskRunProfile,
  type TaskRunProfileResponse,
} from "../../services/run-orchestration";
import type * as RunOrchestration from "../../services/run-orchestration";
import { EMPTY_RUN_PROFILES, RunProfilesContext } from "../../domain/run-profiles";
import { RunLevelChip } from "./RunLevelChip";
import { TaskT3Section } from "./TaskT3Section";

vi.mock("../../services/t3", async (importActual) => ({
  T3WorkspaceBusyApiError: (await importActual<typeof T3Service>()).T3WorkspaceBusyApiError,
  dispatchTaskT3Run: vi.fn(),
  fetchT3Runs: vi.fn(() => Promise.resolve({ runs: [] })),
  fetchTaskT3Run: vi.fn(),
  fetchT3Connection: vi.fn(),
  fetchT3ProjectMappings: vi.fn(),
  fetchT3Capabilities: vi.fn(),
  respondToTaskT3PendingRequest: vi.fn(),
  startTaskT3Run: vi.fn(),
  stopTaskT3Run: vi.fn(),
}));

vi.mock("../../services/run-orchestration", async (importActual) => ({
  RunOrchestrationApiError: (await importActual<typeof RunOrchestration>()).RunOrchestrationApiError,
  fetchTaskRunProfile: vi.fn(),
  saveTaskRunProfile: vi.fn(),
  clearTaskRunProfile: vi.fn(),
  suggestTaskRunProfile: vi.fn(),
}));

const LEVELS: RunLevel[] = [
  { key: "cheap", label: "Cheap", description: "Small edits", order: 0 },
  {
    key: "strong",
    label: "Strong",
    description: "Hard problems",
    order: 1,
    selection: { providerInstanceId: "prov-claude", model: "claude-opus" },
  },
];

const CAPABILITIES = [
  { providerInstanceId: "prov-claude", displayName: "Claude Code", model: "claude-opus", label: "Claude Opus" },
  { providerInstanceId: "prov-codex", displayName: "Codex", model: "gpt-6", label: "GPT 6" },
];

function makeRun(taskId: string, state: AgentRun["state"]): AgentRun {
  return {
    id: "01940000-0000-7000-8000-000000000001",
    taskId,
    t3ProjectId: "t3-proj",
    threadId: "thread-1",
    state,
    workspaceStrategy: "worktree",
    startedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function profileResponse(taskId: string, patch: Partial<TaskRunProfileResponse> = {}): TaskRunProfileResponse {
  return {
    profile: {
      taskId,
      level: "strong",
      source: "router",
      reason: "Touches auth middleware",
      touches: ["apps/worker/src/**"],
      parallelSafe: true,
    },
    resolved: {
      selection: { providerInstanceId: "prov-claude", model: "claude-opus" },
      source: "profile_level",
      levelKey: "strong",
      profileSource: "router",
      skipped: [],
    },
    routerEnabled: true,
    ...patch,
  };
}

function renderSection(task: Task, project: Project, setProfile = vi.fn()) {
  return render(
    <RunProfilesContext.Provider value={{ ...EMPTY_RUN_PROFILES, levels: LEVELS, setProfile }}>
      <TaskT3Section task={task} project={project} hasUnfinishedDependencies={false} />
    </RunProfilesContext.Provider>,
  );
}

describe("task run profile (#BIT-188)", () => {
  let project: Project;
  let task: Task;

  beforeEach(async () => {
    vi.clearAllMocks();
    const storage = new InMemoryStorage();
    project = await storage.createProject({ name: "Bitig" });
    task = await storage.saveTask({ projectId: project.id, title: "Harden auth" });
    vi.mocked(fetchTaskT3Run).mockResolvedValue({ run: null, pendingQuestions: [] });
    vi.mocked(fetchT3Connection).mockResolvedValue({ connected: true, expired: false });
    vi.mocked(fetchT3ProjectMappings).mockResolvedValue([
      { projectId: project.id, t3ProjectId: "t3-proj", t3ProjectTitle: "Bitig", updatedAt: "2026-11-01T00:00:00.000Z" },
    ]);
    vi.mocked(fetchT3Capabilities).mockResolvedValue(CAPABILITIES);
    vi.mocked(fetchTaskRunProfile).mockResolvedValue(profileResponse(task.id));
  });

  it("shows the level chip with its source and the reason on hover", () => {
    render(
      <RunLevelChip profile={{ level: "strong", source: "agent", reason: "Large refactor" }} levels={LEVELS} />,
    );
    const chip = screen.getByTestId("run-level-chip");
    expect(chip).toHaveTextContent("Strong");
    expect(chip).toHaveTextContent("agent");
    expect(chip).toHaveAttribute("title", "Level Strong, set by agent: Large refactor");
  });

  it("labels a manual profile as set by you and renders nothing without a level", () => {
    const { rerender } = render(<RunLevelChip profile={{ level: "cheap", source: "manual" }} levels={LEVELS} />);
    expect(screen.getByTestId("run-level-chip")).toHaveTextContent("you");
    rerender(<RunLevelChip profile={{ source: "manual" }} levels={LEVELS} />);
    expect(screen.queryByTestId("run-level-chip")).not.toBeInTheDocument();
  });

  it("preselects the resolved model, says where it came from, and starts without an override", async () => {
    const user = userEvent.setup();
    vi.mocked(startTaskT3Run).mockResolvedValue({ run: makeRun(task.id, "working"), task });
    renderSection(task, project);

    const modelSelect = await screen.findByRole("combobox", { name: "T3 model" });
    await waitFor(() => {
      expect(within(modelSelect).getAllByRole("option")[0]).toHaveTextContent("Claude Opus (resolved)");
    });
    expect(screen.getByTestId("t3-model-source")).toHaveTextContent("From the task's level Strong (set by router)");
    expect(screen.getByTestId("run-level-chip")).toHaveTextContent("Strong");

    await user.click(screen.getByRole("button", { name: /start in t3/i }));
    expect(startTaskT3Run).toHaveBeenCalledWith(task.id, { workspaceStrategy: "worktree" });
  });

  it("sends another picked model as a one-run override without saving the profile", async () => {
    const user = userEvent.setup();
    vi.mocked(startTaskT3Run).mockResolvedValue({ run: makeRun(task.id, "working"), task });
    renderSection(task, project);

    const modelSelect = await screen.findByRole("combobox", { name: "T3 model" });
    await waitFor(() => {
      expect(screen.getByTestId("t3-model-source")).toBeInTheDocument();
    });
    await user.selectOptions(modelSelect, "prov-codex::gpt-6");
    expect(screen.getByTestId("t3-model-source")).toHaveTextContent("One-run override");
    await user.click(screen.getByRole("button", { name: /start in t3/i }));

    expect(startTaskT3Run).toHaveBeenCalledWith(task.id, {
      workspaceStrategy: "worktree",
      providerInstanceId: "prov-codex",
      model: "gpt-6",
    });
    expect(saveTaskRunProfile).not.toHaveBeenCalled();
  });

  it("saves the level, override, touched paths and parallel-safe as set by you", async () => {
    const user = userEvent.setup();
    const setProfile = vi.fn();
    const saved = profileResponse(task.id, {
      profile: { taskId: task.id, level: "cheap", source: "manual", touches: ["docs/**"], parallelSafe: false },
    });
    vi.mocked(saveTaskRunProfile).mockResolvedValue(saved);
    renderSection(task, project, setProfile);

    const control = await screen.findByTestId("task-run-profile");
    await user.selectOptions(within(control).getByLabelText("Level"), "cheap");
    const touches = within(control).getByLabelText(/touched paths/i);
    await user.clear(touches);
    await user.type(touches, "docs/**{enter}{enter}");
    await user.click(within(control).getByRole("checkbox", { name: /parallel-safe/i }));
    await user.click(within(control).getByRole("button", { name: /save run profile/i }));

    expect(saveTaskRunProfile).toHaveBeenCalledWith(task.id, {
      level: "cheap",
      selection: null,
      touches: ["docs/**"],
      parallelSafe: false,
      effort: null,
      reason: null,
      confidence: null,
    });
    expect(setProfile).toHaveBeenCalledWith(task.id, saved.profile);
    expect(await within(control).findByRole("status")).toHaveTextContent("Run profile saved.");
  });

  it("asks the router for a suggestion, and hides Suggest when no router is configured", async () => {
    const user = userEvent.setup();
    vi.mocked(suggestTaskRunProfile).mockResolvedValue({
      ...profileResponse(task.id),
      stored: true,
      suggestion: { level: "strong", reason: "Touches auth middleware" },
    });
    const { unmount } = renderSection(task, project);

    await user.click(await screen.findByRole("button", { name: "Suggest" }));
    expect(suggestTaskRunProfile).toHaveBeenCalledWith(task.id);
    expect(await screen.findByText("Router suggested level Strong.")).toBeInTheDocument();
    unmount();

    vi.mocked(fetchTaskRunProfile).mockResolvedValue(profileResponse(task.id, { routerEnabled: false }));
    renderSection(task, project);
    await screen.findByTestId("task-run-profile");
    expect(screen.queryByRole("button", { name: "Suggest" })).not.toBeInTheDocument();
  });

  it("offers Retry on the next level up after a failed run and launches on that level", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchTaskT3Run).mockResolvedValue({ run: makeRun(task.id, "failed"), pendingQuestions: [] });
    vi.mocked(fetchTaskRunProfile).mockResolvedValue(
      profileResponse(task.id, { nextLevelUp: { key: "strong", label: "Strong", description: "Hard problems", order: 1 } }),
    );
    vi.mocked(startTaskT3Run).mockResolvedValue({ run: makeRun(task.id, "working"), task });
    renderSection(task, project);

    await user.click(await screen.findByRole("button", { name: "Retry on the next level up (Strong)" }));
    expect(startTaskT3Run).toHaveBeenCalledWith(task.id, { workspaceStrategy: "worktree", level: "strong" });
  });

  it("keeps the old Start flow when the run profile cannot be loaded", async () => {
    vi.mocked(fetchTaskRunProfile).mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderSection(task, project);

    const modelSelect = await screen.findByRole("combobox", { name: "T3 model" });
    expect(within(modelSelect).getAllByRole("option")[0]).toHaveTextContent("Default T3 model");
    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("task-run-profile")).not.toBeInTheDocument();
    warn.mockRestore();
  });
});
