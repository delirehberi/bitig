import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { loadNotificationPreferences } from "../../services/notifications";
import { FakeNotification, MemoryStorage } from "../../test/notification-fixtures";
import { NotificationsPanel } from "./NotificationsPanel";

describe("NotificationsPanel", () => {
  beforeEach(() => {
    MemoryStorage.install();
  });

  it("requests permission, enables notifications, and sends a test", async () => {
    FakeNotification.install("default");
    const user = userEvent.setup();
    render(<NotificationsPanel />);
    expect(screen.getByText("Permission: Not requested")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send test notification" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Task completed/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Enable notifications" }));
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Permission: Allowed")).toBeInTheDocument();
    expect(loadNotificationPreferences().enabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Send test notification" }));
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("persists trigger toggles and the master switch", async () => {
    FakeNotification.install("granted");
    const user = userEvent.setup();
    render(<NotificationsPanel />);
    await user.click(screen.getByRole("button", { name: "Enable notifications" }));
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

    const agentRuns = screen.getByRole("checkbox", { name: /Agent run needs attention/ });
    expect(agentRuns).toBeChecked();
    await user.click(agentRuns);
    expect(agentRuns).not.toBeChecked();
    expect(loadNotificationPreferences().triggers.agentRun).toBe(false);

    await user.click(screen.getByRole("button", { name: "Turn off notifications" }));
    expect(loadNotificationPreferences().enabled).toBe(false);
    expect(loadNotificationPreferences().triggers.agentRun).toBe(false);
  });

  it("explains a blocked permission and keeps enabling disabled", () => {
    FakeNotification.install("denied");
    render(<NotificationsPanel />);
    expect(screen.getByText("Permission: Blocked")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/blocked for this site/);
    expect(screen.getByRole("button", { name: "Enable notifications" })).toBeDisabled();
  });

  it("explains unsupported browsers", () => {
    render(<NotificationsPanel />);
    expect(screen.getByText("Permission: Not supported")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/does not support/);
  });
});
