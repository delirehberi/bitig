import { InMemoryStorage, StorageError, type Project, type Task } from "@bitig/core";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskAttachments } from "./TaskAttachments";
import { TaskModal } from "./TaskModal";

describe("TaskAttachments", () => {
  let storage: InMemoryStorage;
  let project: Project;
  let task: Task;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    project = await storage.createProject({ name: "Bitig" });
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

  it("falls back to extension inference when the browser reports a non-standard MIME type", async () => {
    const user = userEvent.setup();
    render(<TaskAttachments storage={storage} taskId={task.id} />);

    const input = await screen.findByLabelText("Attach files");
    const tsFile = new File(["export const x = 1;\n"], "module.ts", { type: "video/mp2t" });
    const tgzFile = new File([new Uint8Array([0x1f, 0x8b])], "bundle.tar.gz", {
      type: "application/x-compressed-tar",
    });
    await user.upload(input, [tsFile, tgzFile]);

    expect(await screen.findByText("module.ts")).toBeInTheDocument();
    expect(await screen.findByText("bundle.tar.gz")).toBeInTheDocument();

    const saved = await storage.getAttachments(task.id);
    expect(saved).toEqual([
      expect.objectContaining({ name: "module.ts", mimeType: "application/octet-stream" }),
      expect.objectContaining({ name: "bundle.tar.gz", mimeType: "application/gzip" }),
    ]);
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

  it("stages attachments when creating a new task in TaskModal and submits them with the task", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <TaskModal
        isOpen
        onClose={onClose}
        onSubmit={onSubmit}
        projects={[project]}
        defaultProjectId={project.id}
        storage={storage}
      />,
    );

    await user.type(screen.getByLabelText(/title/i), "Task with files");

    const fileInput = screen.getByLabelText("Attach files");
    const notesFile = new File(["## Release Notes\n\nAll green.\n"], "release.md", {
      type: "text/markdown",
    });
    const extraFile = new File(["temp"], "remove-me.txt", { type: "text/plain" });
    await user.upload(fileInput, [notesFile, extraFile]);

    expect(await screen.findByText("release.md")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Release Notes" })).toBeInTheDocument();
    expect(screen.getByText("remove-me.txt")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete attachment remove-me.txt" }));
    expect(screen.queryByText("remove-me.txt")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create Task" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.id,
        title: "Task with files",
      }),
      [
        expect.objectContaining({
          name: "release.md",
          mimeType: "text/markdown",
        }),
      ],
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("manages existing attachments directly when editing a task in TaskModal", async () => {
    const user = userEvent.setup();
    await storage.addAttachment({
      taskId: task.id,
      name: "existing.txt",
      data: "already attached",
    });

    render(
      <TaskModal
        isOpen
        task={task}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        projects={[project]}
        storage={storage}
      />,
    );

    expect(await screen.findByText("existing.txt")).toBeInTheDocument();

    const fileInput = screen.getByLabelText("Attach files");
    const addedFile = new File(["newly added"], "added.txt", { type: "text/plain" });
    await user.upload(fileInput, addedFile);

    expect(await screen.findByText("added.txt")).toBeInTheDocument();
    expect(await storage.getAttachments(task.id)).toHaveLength(2);
  });
});

