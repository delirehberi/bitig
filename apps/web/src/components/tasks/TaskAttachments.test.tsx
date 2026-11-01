import { InMemoryStorage, StorageError, type Task } from "@bitig/core";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskAttachments } from "./TaskAttachments";

describe("TaskAttachments", () => {
  let storage: InMemoryStorage;
  let task: Task;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    const project = await storage.createProject({ name: "Bitig" });
    task = await storage.saveTask({ projectId: project.id, title: "Attach docs" });
  });

  it("renders Markdown and image attachments inline and toggles preview", async () => {
    const user = userEvent.setup();
    await storage.addAttachment(
      {
        taskId: task.id,
        name: "architecture.md",
        data: "### Architecture Plan\n\n- Edge R2 storage\n",
      },
      { actor: "claude" },
    );
    await storage.addAttachment({
      taskId: task.id,
      name: "diagram.png",
      mimeType: "image/png",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });

    render(<TaskAttachments storage={storage} taskId={task.id} />);

    expect(await screen.findByRole("heading", { name: /attachments \(2\)/i })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Architecture Plan" })).toBeInTheDocument();
    expect(screen.getByText("Edge R2 storage")).toBeInTheDocument();
    expect(screen.getByText("claude")).toBeInTheDocument();

    const img = await screen.findByRole("img", { name: "diagram.png" });
    expect(img).toHaveAttribute("src", expect.stringMatching(/^data:image\/png;base64,/));

    await user.click(screen.getByRole("button", { name: "Hide preview for architecture.md" }));
    expect(screen.queryByRole("heading", { name: "Architecture Plan" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show preview for architecture.md" }));
    expect(await screen.findByRole("heading", { name: "Architecture Plan" })).toBeInTheDocument();
  });

  it("uploads via file input, drag-and-drop, and clipboard paste, and deletes attachments", async () => {
    const user = userEvent.setup();
    render(<TaskAttachments storage={storage} taskId={task.id} />);
    expect(await screen.findByText(/no attachments yet/i)).toBeInTheDocument();

    const input = screen.getByLabelText("Attach files");
    const mdFile = new File(["# Uploaded Spec\n\nReady.\n"], "spec.md", { type: "text/markdown" });
    await user.upload(input, mdFile);

    expect(await screen.findByText("spec.md")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Uploaded Spec" })).toBeInTheDocument();

    const section = screen.getByRole("region", { name: /attachments/i });
    const droppedFile = new File(["dropped log line"], "run.txt", { type: "text/plain" });
    fireEvent.drop(section, {
      dataTransfer: { files: [droppedFile] },
    });

    expect(await screen.findByText("run.txt")).toBeInTheDocument();
    expect(await screen.findByText("dropped log line")).toBeInTheDocument();

    const pastedImage = new File([new Uint8Array([1, 2, 3, 4])], "screenshot.png", {
      type: "image/png",
    });
    fireEvent.paste(document, {
      clipboardData: { files: [pastedImage] },
    });

    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    expect(await storage.getAttachments(task.id)).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Delete attachment spec.md" }));
    expect(screen.queryByText("spec.md")).not.toBeInTheDocument();
    expect(await storage.getAttachments(task.id)).toHaveLength(2);
  });

  it("hides the attachments section when the storage adapter does not support attachments", async () => {
    vi.spyOn(storage, "getAttachments").mockRejectedValueOnce(
      new StorageError("unsupported", "Attachments are not supported by this storage adapter"),
    );

    const { container } = render(<TaskAttachments storage={storage} taskId={task.id} />);
    await vi.waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });
});
