import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_RUN_PROFILES, RunProfilesContext } from "../../domain/run-profiles";
import { dispatchRealtimeEvent } from "../../hooks/useRealtime";
import {
  cancelWorkQueue,
  fetchWorkQueues,
  pauseWorkQueue,
  resumeWorkQueue,
  retryWorkQueueItem,
  skipWorkQueueItem,
  WorkQueueApiError,
  type WorkQueueEntryView,
  type WorkQueueView,
} from "../../services/work-queue";
import { WQ_LEVELS } from "./work-queue-fixtures";
import type * as WorkQueueService from "../../services/work-queue";
import { WorkQueuePanel } from "./WorkQueuePanel";

vi.mock("../../services/work-queue", async (importActual) => ({
  WorkQueueApiError: (await importActual<typeof WorkQueueService>()).WorkQueueApiError,
  fetchWorkQueues: vi.fn(),
  pauseWorkQueue: vi.fn(),
  resumeWorkQueue: vi.fn(),
  cancelWorkQueue: vi.fn(),
  skipWorkQueueItem: vi.fn(),
  retryWorkQueueItem: vi.fn(),
}));

const QUEUE_ID = "01940000-0000-7000-8000-00000000f001";
const LANE_BIT = "01940000-0000-7000-8000-0000000000b1";
const CREATED_AT = "2026-11-16T00:00:00.000Z";
const CHEAP_SELECTION = { providerInstanceId: "claudeAgent", model: "claude-haiku-5-5" };
const STRONG_SELECTION = { providerInstanceId: "claudeAgent", model: "claude-opus-5-5" };
const PROMPT = "Start BIT-1 to BIT-5";

function entry(id: string, overrides: Partial<WorkQueueEntryView> = {}): WorkQueueEntryView {
  return {
    id,
    queueId: QUEUE_ID,
    taskId: `task-${id}`,
    position: 0,
    lane: LANE_BIT,
    state: "waiting",
    waitingReason: null,
    resolvedSelection: null,
    umbrellaTaskId: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    taskCode: `BIT-${id}`,
    taskTitle: `Task ${id}`,
    ...overrides,
  };
}

function queue(overrides: Partial<WorkQueueView> = {}): WorkQueueView {
  return {
    id: QUEUE_ID,
    orgId: "01940000-0000-7000-8000-0000000000aa",
    createdBy: "Emre",
    prompt: PROMPT,
    state: "active",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    entries: [
      entry("1", { state: "running" }),
      entry("2", { state: "waiting", waitingReason: "Waiting for a free lane slot" }),
      entry("3", { state: "ready" }),
      entry("4", { state: "merged" }),
    ],
    ...overrides,
  };
}

function renderPanel(enabled = true) {
  return render(
    <RunProfilesContext.Provider value={{ ...EMPTY_RUN_PROFILES, levels: WQ_LEVELS }}>
      <WorkQueuePanel enabled={enabled} />
    </RunProfilesContext.Provider>,
  );
}

function itemRow(code: string): HTMLElement {
  const row = screen.getByRole("link", { name: code }).closest("li");
  if (!row) throw new Error(`no row for ${code}`);
  return row;
}

async function renderLoaded(queues: WorkQueueView[] = [queue()]) {
  vi.mocked(fetchWorkQueues).mockResolvedValue(queues);
  renderPanel();
  return await screen.findByRole("article", { name: PROMPT });
}

describe("WorkQueuePanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("loading and states", () => {
    it("renders nothing and does not fetch when disabled", () => {
      renderPanel(false);
      expect(screen.queryByRole("region", { name: "Work queues" })).toBeNull();
      expect(fetchWorkQueues).not.toHaveBeenCalled();
    });

    it("shows a loading message until the queues arrive", () => {
      vi.mocked(fetchWorkQueues).mockReturnValue(new Promise(() => undefined));
      renderPanel();
      expect(screen.getByText("Loading work queues…")).toBeTruthy();
    });

    it("shows the empty state when no queue is open", async () => {
      vi.mocked(fetchWorkQueues).mockResolvedValue([]);
      renderPanel();
      expect(await screen.findByText(/No open work queues/)).toBeTruthy();
    });

    it("reports a failed load as an alert", async () => {
      vi.mocked(fetchWorkQueues).mockRejectedValue(new Error("Could not load the work queues (HTTP 500)"));
      renderPanel();
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the work queues (HTTP 500)");
    });

    it("shows each queue's state, prompt title and lane progress", async () => {
      const card = await renderLoaded();
      expect(within(card).getByText("Active")).toBeTruthy();
      expect(within(card).getByRole("heading", { name: PROMPT })).toBeTruthy();
      const lanes = within(card).getByRole("list", { name: "Lane progress" });
      expect(within(lanes).getByText("BIT: 1 running, 2 waiting, 1 merged")).toBeTruthy();
    });

    it("lists each item with its state, waiting reason and links to the task", async () => {
      await renderLoaded();
      const waiting = itemRow("BIT-2");
      expect(within(waiting).getByText("Waiting")).toBeTruthy();
      expect(within(waiting).getByText("Waiting for a free lane slot")).toBeTruthy();
      expect(screen.getByRole("link", { name: "BIT-2" })).toHaveAttribute("href", "/tasks?task=BIT-2");
      expect(within(itemRow("BIT-3")).getByText("Ready")).toBeTruthy();
      expect(within(itemRow("BIT-4")).getByText("Merged")).toBeTruthy();
    });

    it("links to the lane umbrella when the item has one", async () => {
      const umbrellaId = "01940000-0000-7000-8000-00000000cafe";
      await renderLoaded([queue({ entries: [entry("9", { umbrellaTaskId: umbrellaId })] })]);
      expect(screen.getByRole("link", { name: "Lane umbrella" })).toHaveAttribute("href", `/tasks?task=${umbrellaId}`);
    });

    it("shows a queue with no items as empty", async () => {
      await renderLoaded([queue({ entries: [] })]);
      expect(screen.getByText("No tasks in this queue.")).toBeTruthy();
    });
  });

  describe("queue controls", () => {
    it("pauses an active queue and shows Resume afterwards", async () => {
      vi.mocked(pauseWorkQueue).mockResolvedValue(queue({ state: "paused" }));
      const user = userEvent.setup();
      await renderLoaded();
      await user.click(screen.getByRole("button", { name: "Pause" }));
      expect(pauseWorkQueue).toHaveBeenCalledWith(QUEUE_ID);
      expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
      expect(screen.getByText("Paused")).toBeTruthy();
    });

    it("resumes a paused queue", async () => {
      vi.mocked(resumeWorkQueue).mockResolvedValue(queue({ state: "active" }));
      const user = userEvent.setup();
      await renderLoaded([queue({ state: "paused" })]);
      expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Resume" }));
      expect(resumeWorkQueue).toHaveBeenCalledWith(QUEUE_ID);
      expect(await screen.findByRole("button", { name: "Pause" })).toBeTruthy();
    });

    it("asks for confirmation before cancelling and does nothing when kept", async () => {
      const user = userEvent.setup();
      await renderLoaded();
      await user.click(screen.getByRole("button", { name: "Cancel queue" }));
      await user.click(screen.getByRole("button", { name: "Keep queue" }));
      expect(cancelWorkQueue).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Cancel queue" })).toBeTruthy();
    });

    it("cancels the queue once the cancel is confirmed and removes it from the list", async () => {
      vi.mocked(cancelWorkQueue).mockResolvedValue(queue({ state: "cancelled" }));
      const user = userEvent.setup();
      await renderLoaded();
      await user.click(screen.getByRole("button", { name: "Cancel queue" }));
      await user.click(screen.getByRole("button", { name: "Confirm cancel" }));
      expect(cancelWorkQueue).toHaveBeenCalledWith(QUEUE_ID);
      expect(await screen.findByText(/No open work queues/)).toBeTruthy();
    });

    it("shows the server's message when a queue action fails", async () => {
      vi.mocked(pauseWorkQueue).mockRejectedValue(new WorkQueueApiError(409, "Could not pause the queue (HTTP 409)"));
      const user = userEvent.setup();
      await renderLoaded();
      await user.click(screen.getByRole("button", { name: "Pause" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not pause the queue (HTTP 409)");
      expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    });
  });

  describe("item controls", () => {
    it("offers Skip only for waiting or ready items and calls the skip endpoint", async () => {
      vi.mocked(skipWorkQueueItem).mockResolvedValue(entry("2", { state: "skipped", waitingReason: "Skipped by a person" }));
      const user = userEvent.setup();
      await renderLoaded();
      expect(within(itemRow("BIT-1")).queryByRole("button", { name: "Skip" })).toBeNull();
      await user.click(within(itemRow("BIT-2")).getByRole("button", { name: "Skip" }));
      expect(skipWorkQueueItem).toHaveBeenCalledWith(entry("2").id);
      expect(await within(itemRow("BIT-2")).findByText("Skipped")).toBeTruthy();
      expect(within(itemRow("BIT-2")).getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    it("retries a failed item on its current level", async () => {
      vi.mocked(retryWorkQueueItem).mockResolvedValue(entry("5", { state: "waiting", resolvedSelection: CHEAP_SELECTION }));
      const user = userEvent.setup();
      await renderLoaded([queue({ entries: [entry("5", { state: "failed", resolvedSelection: CHEAP_SELECTION })] })]);
      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(retryWorkQueueItem).toHaveBeenCalledWith(entry("5").id, undefined);
      expect(await within(itemRow("BIT-5")).findByText("Waiting")).toBeTruthy();
    });

    it("retries on the next level up, one step above the item's current level", async () => {
      vi.mocked(retryWorkQueueItem).mockResolvedValue(entry("5", { state: "waiting", resolvedSelection: STRONG_SELECTION }));
      const user = userEvent.setup();
      await renderLoaded([queue({ entries: [entry("5", { state: "failed", resolvedSelection: CHEAP_SELECTION })] })]);
      await user.click(screen.getByRole("button", { name: "Retry on next level up" }));
      expect(retryWorkQueueItem).toHaveBeenCalledWith(entry("5").id, "strong");
    });

    it("disables Retry on next level up when the item is already on the highest level", async () => {
      await renderLoaded([queue({ entries: [entry("5", { state: "failed", resolvedSelection: STRONG_SELECTION })] })]);
      expect(screen.getByRole("button", { name: "Retry on next level up" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    });

    it("hides every retry control for items that cannot be retried", async () => {
      await renderLoaded([queue({ entries: [entry("6", { state: "merged" })] })]);
      expect(within(itemRow("BIT-6")).queryByRole("button")).toBeNull();
    });
  });

  describe("realtime updates", () => {
    it("moves an item to its new state when an item update arrives", async () => {
      await renderLoaded();
      const realtimeEntry = {
        id: entry("2").id,
        queueId: QUEUE_ID,
        taskId: "task-2",
        position: 0,
        lane: LANE_BIT,
        state: "running" as const,
        waitingReason: null,
        resolvedSelection: null,
        umbrellaTaskId: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      };
      act(() => {
        dispatchRealtimeEvent({ type: "work_queue_item.updated", entry: realtimeEntry });
      });
      expect(within(itemRow("BIT-2")).getByText("Running")).toBeTruthy();
      expect(within(itemRow("BIT-2")).getByRole("link", { name: "BIT-2" })).toBeTruthy();
      expect(screen.getByRole("list", { name: "Lane progress" })).toHaveTextContent("BIT: 2 running, 1 waiting, 1 merged");
    });

    it("updates the queue's state when a queue update arrives", async () => {
      await renderLoaded();
      act(() => {
        dispatchRealtimeEvent({
          type: "work_queue.updated",
          queue: {
            id: QUEUE_ID,
            orgId: "01940000-0000-7000-8000-0000000000aa",
            createdBy: "Emre",
            prompt: PROMPT,
            state: "paused",
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          },
        });
      });
      expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
      expect(screen.getByText("Paused")).toBeTruthy();
    });

    it("drops a queue from the list when it closes", async () => {
      await renderLoaded();
      act(() => {
        dispatchRealtimeEvent({
          type: "work_queue.updated",
          queue: {
            id: QUEUE_ID,
            orgId: "01940000-0000-7000-8000-0000000000aa",
            createdBy: "Emre",
            prompt: PROMPT,
            state: "done",
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          },
        });
      });
      expect(await screen.findByText(/No open work queues/)).toBeTruthy();
    });

    it("reloads the list when an update refers to a queue it does not have", async () => {
      await renderLoaded();
      vi.mocked(fetchWorkQueues).mockResolvedValue([queue({ id: "other", prompt: "Other queue" })]);
      act(() => {
        dispatchRealtimeEvent({
          type: "work_queue_item.updated",
          entry: {
            id: "e-x",
            queueId: "unknown-queue",
            taskId: "task-x",
            position: 0,
            lane: LANE_BIT,
            state: "waiting",
            waitingReason: null,
            resolvedSelection: null,
            umbrellaTaskId: null,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          },
        });
      });
      expect(await screen.findByRole("heading", { name: "Other queue" })).toBeTruthy();
      expect(fetchWorkQueues).toHaveBeenCalledTimes(2);
    });

    it("ignores updates for other event types", async () => {
      await renderLoaded();
      act(() => {
        dispatchRealtimeEvent({
          type: "project.updated",
          project: {
            id: LANE_BIT,
            name: "Bitig",
            key: "BIT",
            description: "",
            kind: "open_source",
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          },
        });
      });
      expect(fetchWorkQueues).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("article", { name: PROMPT })).toBeTruthy();
    });
  });

  it("reloads after a failed load once a realtime change arrives", async () => {
    vi.mocked(fetchWorkQueues).mockRejectedValueOnce(new Error("Could not load the work queues"));
    renderPanel();
    expect(await screen.findByRole("alert")).toBeTruthy();
    vi.mocked(fetchWorkQueues).mockResolvedValue([queue()]);
    act(() => {
      dispatchRealtimeEvent({
        type: "work_queue.updated",
        queue: { id: "unknown", orgId: "o", createdBy: "x", prompt: "p", state: "active", createdAt: CREATED_AT, updatedAt: CREATED_AT },
      });
    });
    await waitFor(() => {
      expect(screen.getByRole("article", { name: PROMPT })).toBeTruthy();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
