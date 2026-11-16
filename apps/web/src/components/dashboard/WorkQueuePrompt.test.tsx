import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_RUN_PROFILES, RunProfilesContext } from "../../domain/run-profiles";
import { fetchT3Capabilities } from "../../services/t3";
import { confirmWorkQueue, planWorkQueue, WorkQueueApiError } from "../../services/work-queue";
import type * as WorkQueueService from "../../services/work-queue";
import {
  confirmResult,
  row,
  samplePlan,
  WQ_CAPABILITIES,
  WQ_LEVELS,
  WQ_PROJECTS,
} from "./work-queue-fixtures";
import { WORK_QUEUE_PLACEHOLDER, WorkQueuePrompt } from "./WorkQueuePrompt";

vi.mock("../../services/work-queue", async (importActual) => ({
  WorkQueueApiError: (await importActual<typeof WorkQueueService>()).WorkQueueApiError,
  planWorkQueue: vi.fn(),
  confirmWorkQueue: vi.fn(),
}));

vi.mock("../../services/t3", () => ({
  fetchT3Capabilities: vi.fn(),
  fetchT3Connection: vi.fn(),
  fetchT3Hosts: vi.fn(),
}));

const HTTP_BAD_GATEWAY = 502;
const HTTP_CONFLICT = 409;

function renderPrompt(t3Connected = true) {
  return render(
    <RunProfilesContext.Provider value={{ ...EMPTY_RUN_PROFILES, levels: WQ_LEVELS }}>
      <WorkQueuePrompt enabled projects={WQ_PROJECTS} t3Connected={t3Connected} />
    </RunProfilesContext.Provider>,
  );
}

function textarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(WORK_QUEUE_PLACEHOLDER);
}

async function planSample(user: ReturnType<typeof userEvent.setup>, text = "Start BIT-92 to BIT-97 and KOM-3") {
  await user.type(textarea(), text);
  await user.click(screen.getByRole("button", { name: "Plan" }));
  return await screen.findByRole("list", { name: "Planned tasks" });
}

function planRow(code: string): HTMLElement {
  const item = within(screen.getByRole("list", { name: "Planned tasks" }))
    .getAllByRole("listitem")
    .find((li) => li.getAttribute("aria-label")?.startsWith(`${code} `));
  if (!item) throw new Error(`no row for ${code}`);
  return item;
}

beforeEach(() => {
  vi.mocked(planWorkQueue).mockReset().mockResolvedValue(samplePlan());
  vi.mocked(confirmWorkQueue).mockReset();
  vi.mocked(fetchT3Capabilities).mockReset().mockResolvedValue(WQ_CAPABILITIES);
});

describe("WorkQueuePrompt", () => {
  it("shows a Connect T3 link instead of the prompt when T3 is not connected", () => {
    renderPrompt(false);
    expect(screen.getByRole("link", { name: "Connect T3" })).toHaveAttribute("href", "/settings");
    expect(screen.queryByPlaceholderText(WORK_QUEUE_PLACEHOLDER)).not.toBeInTheDocument();
  });

  it("plans with Ctrl+Enter and shows rows, statuses, lanes and warnings", async () => {
    const user = userEvent.setup();
    renderPrompt();
    await user.type(textarea(), "Start BIT-92 to BIT-97");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(await screen.findByRole("list", { name: "Planned tasks" })).toBeInTheDocument();
    expect(planWorkQueue).toHaveBeenCalledWith({ prompt: "Start BIT-92 to BIT-97" }, expect.any(AbortSignal));
    expect(within(planRow("BIT-92")).getByText("Ready")).toBeInTheDocument();
    expect(within(planRow("BIT-94")).getByText("After BIT-92")).toBeInTheDocument();
    expect(within(planRow("BIT-95")).getByText("Needs approval")).toBeInTheDocument();
    expect(within(planRow("BIT-97")).getByText("Part of BIT-183")).toBeInTheDocument();
    expect(screen.getByText("Wave 1: BIT-92, BIT-93 · Wave 2: BIT-94 after BIT-92")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Warnings" })).getByText(/AI parse fallback skipped/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queue 3 tasks" })).toBeEnabled();
  });

  it("plans with Cmd+Enter too", async () => {
    const user = userEvent.setup();
    renderPrompt();
    await user.type(textarea(), "BIT-92");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => {
      expect(planWorkQueue).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the typed text and shows the error when planning fails", async () => {
    const user = userEvent.setup();
    vi.mocked(planWorkQueue).mockRejectedValue(new WorkQueueApiError(HTTP_BAD_GATEWAY, "Worker unavailable"));
    renderPrompt();
    await user.type(textarea(), "Start BIT-92");
    await user.click(screen.getByRole("button", { name: "Plan" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Worker unavailable");
    expect(textarea()).toHaveValue("Start BIT-92");
  });

  it("says no codes were found when the plan is empty", async () => {
    const user = userEvent.setup();
    const empty = samplePlan([]);
    vi.mocked(planWorkQueue).mockResolvedValue({ ...empty, parse: { ...empty.parse, unknownKeys: [] }, lanes: [] });
    renderPrompt();
    await user.type(textarea(), "do the header things");
    await user.click(screen.getByRole("button", { name: "Plan" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't find any task codes");
    expect(textarea()).toHaveValue("do the header things");
  });

  it("re-plans the remaining codes when a chip is removed", async () => {
    const user = userEvent.setup();
    renderPrompt();
    await planSample(user);

    await user.click(within(screen.getByRole("list", { name: "Parsed codes" })).getByRole("button", { name: "Remove BIT-93" }));

    expect(planWorkQueue).toHaveBeenLastCalledWith(
      { prompt: "Start BIT-92 to BIT-97 and KOM-3", items: ["BIT-92", "BIT-94", "BIT-95", "BIT-96", "BIT-97"] },
      expect.any(AbortSignal),
    );
  });

  it("offers the suggested key for an unknown one and re-plans the corrected prompt", async () => {
    const user = userEvent.setup();
    renderPrompt();
    await planSample(user);

    expect(screen.getByText("KOM is not a project key. Did you mean KMZ (Komuz)?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use KMZ (Komuz)" }));

    expect(textarea()).toHaveValue("Start BIT-92 to BIT-97 and KMZ-3");
    expect(planWorkQueue).toHaveBeenLastCalledWith({ prompt: "Start BIT-92 to BIT-97 and KMZ-3" }, expect.any(AbortSignal));
  });

  it("queues the unlisted parent instead of the child", async () => {
    const user = userEvent.setup();
    renderPrompt();
    await planSample(user);

    await user.click(within(planRow("BIT-97")).getByRole("button", { name: "Queue BIT-183 instead" }));

    expect(planWorkQueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ items: ["BIT-92", "BIT-93", "BIT-94", "BIT-95", "BIT-96", "BIT-183"] }),
      expect.any(AbortSignal),
    );
  });

  it("approves pending tasks one by one or all at once and counts them in the queue button", async () => {
    const user = userEvent.setup();
    renderPrompt();
    await planSample(user);

    await user.click(screen.getByRole("checkbox", { name: "Approve BIT-95" }));
    expect(screen.getByRole("button", { name: "Queue 4 tasks" })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Approve all (2)" }));
    expect(screen.getByRole("checkbox", { name: "Approve BIT-96" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Queue 5 tasks" })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Approve all (2)" }));
    expect(screen.getByRole("checkbox", { name: "Approve BIT-95" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Queue 3 tasks" })).toBeInTheDocument();
  });

  it("confirms with approvals and level, effort and model overrides, then clears the prompt", async () => {
    const user = userEvent.setup();
    vi.mocked(confirmWorkQueue).mockResolvedValue(confirmResult(samplePlan(), ["BIT-92", "BIT-93", "BIT-94", "BIT-95"]));
    renderPrompt();
    await planSample(user);

    await user.selectOptions(screen.getByLabelText("Level for BIT-92"), "strong");
    await user.selectOptions(await screen.findByLabelText("Effort for BIT-93"), "high");
    await user.selectOptions(
      within(planRow("BIT-94")).getByLabelText("Model for BIT-94"),
      "claudeAgent::claude-opus-5-5",
    );
    await user.click(screen.getByRole("checkbox", { name: "Approve BIT-95" }));
    await user.click(screen.getByRole("button", { name: "Queue 4 tasks" }));

    expect(confirmWorkQueue).toHaveBeenCalledWith(
      {
        prompt: "Start BIT-92 to BIT-97 and KOM-3",
        items: ["BIT-92", "BIT-93", "BIT-94", "BIT-95", "BIT-96", "BIT-97"],
        approvals: ["BIT-95"],
        overrides: [
          { code: "BIT-92", level: "strong" },
          { code: "BIT-93", effort: "high" },
          {
            code: "BIT-94",
            selection: { providerInstanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "low" }] },
          },
        ],
      },
      expect.any(AbortSignal),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Queued 4 tasks. Queue umbrellas: BIT-300.");
    expect(textarea()).toHaveValue("");
    expect(screen.queryByRole("list", { name: "Planned tasks" })).not.toBeInTheDocument();
  });

  it("keeps the prompt and shows the server's fresh plan when nothing can be queued", async () => {
    const user = userEvent.setup();
    const fresh = samplePlan([row(92, { classification: "already_queued", queueable: false, run: undefined })]);
    vi.mocked(confirmWorkQueue).mockRejectedValue(
      new WorkQueueApiError(HTTP_CONFLICT, "No listed task can be queued.", fresh),
    );
    renderPrompt();
    await planSample(user);
    await user.click(screen.getByRole("button", { name: "Queue 3 tasks" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No listed task can be queued.");
    expect(within(planRow("BIT-92")).getByText("Already queued")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queue 0 tasks" })).toBeDisabled();
    expect(textarea()).toHaveValue("Start BIT-92 to BIT-97 and KOM-3");
  });
});
