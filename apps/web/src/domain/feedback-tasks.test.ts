import { describe, expect, it } from "vitest";
import { isFeedbackTask } from "./feedback-tasks";

describe("isFeedbackTask", () => {
  it("is true only when the task carries the feedback label", () => {
    expect(isFeedbackTask({ labels: ["feedback", "ui"] })).toBe(true);
    expect(isFeedbackTask({ labels: ["ui"] })).toBe(false);
    expect(isFeedbackTask({ labels: [] })).toBe(false);
    expect(isFeedbackTask({})).toBe(false);
  });
});
