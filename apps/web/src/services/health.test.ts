import { describe, expect, it, vi } from "vitest";
import { HEALTH_PATH, HealthCheckError, fetchHealth } from "./health";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchHealth", () => {
  it("returns the payload when the worker is healthy", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ status: "ok", version: "1.2.3", storageMode: "nostr" }),
    );

    await expect(fetchHealth(new AbortController().signal, fetchImpl)).resolves.toEqual({
      status: "ok",
      version: "1.2.3",
      storageMode: "nostr",
    });
    expect(fetchImpl).toHaveBeenCalledWith(HEALTH_PATH, expect.anything());
  });

  it("rejects a non-2xx response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 503));

    await expect(fetchHealth(new AbortController().signal, fetchImpl)).rejects.toThrow(
      new HealthCheckError("worker answered 503"),
    );
  });

  it("rejects a body with the wrong shape", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: "ok" }));

    await expect(fetchHealth(new AbortController().signal, fetchImpl)).rejects.toBeInstanceOf(
      HealthCheckError,
    );
  });

  it("rejects a body without a storage mode", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ status: "ok", version: "1.2.3" }),
    );

    await expect(fetchHealth(new AbortController().signal, fetchImpl)).rejects.toBeInstanceOf(
      HealthCheckError,
    );
  });

  it("rejects an unknown storage mode", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ status: "ok", version: "1.2.3", storageMode: "bogus" }),
    );

    await expect(fetchHealth(new AbortController().signal, fetchImpl)).rejects.toBeInstanceOf(
      HealthCheckError,
    );
  });

  it("rejects a body that is not JSON", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>"));

    await expect(fetchHealth(new AbortController().signal, fetchImpl)).rejects.toThrow(
      "worker sent an unreadable response",
    );
  });

  it("wraps network failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(fetchHealth(new AbortController().signal, fetchImpl)).rejects.toThrow(
      "worker did not respond",
    );
  });

  it("propagates the caller's abort unchanged", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("aborted", "AbortError");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      controller.abort();
      return Promise.reject(abortError);
    });

    await expect(fetchHealth(controller.signal, fetchImpl)).rejects.toBe(abortError);
  });
});

