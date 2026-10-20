import { useEffect, useRef } from "react";
import { RealtimeEventSchema, type RealtimeEvent } from "@bitig/core";

const REALTIME_DOM_EVENT = "bitig:realtime";
const REALTIME_PATH = "/api/realtime";
const PING_MESSAGE = "ping";
const PONG_MESSAGE = "pong";
const PING_INTERVAL_MS = 30_000;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

export function dispatchRealtimeEvent(event: RealtimeEvent): void {
  window.dispatchEvent(new CustomEvent<RealtimeEvent>(REALTIME_DOM_EVENT, { detail: event }));
}

function realtimeSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${REALTIME_PATH}`;
}

/**
 * Maintains the workspace WebSocket connection to `/api/realtime` when `enabled`
 * is true (`cloudflare` mode), dispatching validated `RealtimeEvent` payloads.
 */
export function useRealtime(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof WebSocket === "undefined") return;

    let disposed = false;
    let socket: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = INITIAL_RECONNECT_MS;
    let hasConnectedOnce = false;

    function clearTimers() {
      if (pingTimer !== null) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function connect() {
      if (disposed) return;
      try {
        socket = new WebSocket(realtimeSocketUrl());
      } catch (error) {
        console.warn("failed to open realtime websocket", error);
        scheduleReconnect();
        return;
      }

      socket.addEventListener("open", () => {
        if (disposed) return;
        const isReconnect = hasConnectedOnce;
        hasConnectedOnce = true;
        reconnectDelay = INITIAL_RECONNECT_MS;
        if (isReconnect) {
          dispatchRealtimeEvent({ type: "sync" });
        }
        pingTimer = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(PING_MESSAGE);
          }
        }, PING_INTERVAL_MS);
      });

      socket.addEventListener("message", (message) => {
        if (disposed || typeof message.data !== "string" || message.data === PONG_MESSAGE) {
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(message.data);
        } catch (error) {
          console.warn("ignoring malformed realtime message", error);
          return;
        }
        const parsed = RealtimeEventSchema.safeParse(raw);
        if (parsed.success) {
          dispatchRealtimeEvent(parsed.data);
        }
      });

      socket.addEventListener("close", () => {
        if (pingTimer !== null) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        if (!disposed) {
          scheduleReconnect();
        }
      });
    }

    function scheduleReconnect() {
      if (disposed || reconnectTimer !== null) return;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(MAX_RECONNECT_MS, reconnectDelay * BACKOFF_MULTIPLIER);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    connect();

    return () => {
      disposed = true;
      clearTimers();
      if (socket !== null) {
        try {
          socket.close();
        } catch (error) {
          console.warn("failed to close realtime websocket", error);
        }
      }
    };
  }, [enabled]);
}

/** Subscribes a hook to incoming `RealtimeEvent` payloads. */
export function useRealtimeEvent(onEvent: (event: RealtimeEvent) => void): void {
  const handlerRef = useRef(onEvent);
  useEffect(() => {
    handlerRef.current = onEvent;
  });

  useEffect(() => {
    function handleEvent(e: Event) {
      const custom = e as CustomEvent<RealtimeEvent>;
      handlerRef.current(custom.detail);
    }
    window.addEventListener(REALTIME_DOM_EVENT, handleEvent);
    return () => {
      window.removeEventListener(REALTIME_DOM_EVENT, handleEvent);
    };
  }, []);
}

