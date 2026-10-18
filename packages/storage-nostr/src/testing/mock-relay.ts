import { matchFilters, type Filter } from "nostr-tools/filter";
import type { Event } from "nostr-tools/pure";
import { WebSocket, WebSocketServer } from "ws";
import { NOSTR_TAG_D } from "../kinds";

export interface MockRelay {
  readonly url: string;
  readonly port: number;
  clear(): void;
  getEvents(): readonly Event[];
  close(): Promise<void>;
}

export function startMockRelay(): Promise<MockRelay> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => {
      const addr = wss.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get WebSocketServer port"));
        return;
      }

      const port = addr.port;
      const url = `ws://127.0.0.1:${String(port)}`;
      let events: Event[] = [];

      interface Subscription {
        subId: string;
        filters: Filter[];
        ws: WebSocket;
      }

      const subscriptions = new Map<string, Subscription>();

      wss.on("connection", (ws) => {
        ws.on("message", (raw) => {
          try {
            const rawStr = Buffer.isBuffer(raw)
              ? raw.toString("utf-8")
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf-8")
                : Buffer.from(raw).toString("utf-8");
            const parsed = JSON.parse(rawStr) as unknown;
            if (!Array.isArray(parsed)) return;

            const type = parsed[0] as string;

            if (type === "EVENT") {
              const ev = parsed[1] as Event;
              if (!ev.id) return;

              // Parameterized replaceable event handling (30000-39999)
              if (ev.kind >= 30000 && ev.kind < 40000) {
                const dTag = ev.tags.find((t) => t[0] === NOSTR_TAG_D)?.[1];
                events = events.filter((existing) => {
                  if (existing.kind !== ev.kind || existing.pubkey !== ev.pubkey) return true;
                  const existingD = existing.tags.find((t) => t[0] === NOSTR_TAG_D)?.[1];
                  return existingD !== dTag;
                });
              }

              events.push(ev);

              // Send OK
              ws.send(JSON.stringify(["OK", ev.id, true, ""]));

              // Broadcast to active subscriptions if matching
              for (const sub of subscriptions.values()) {
                if (matchFilters(sub.filters, ev) && sub.ws.readyState === WebSocket.OPEN) {
                  sub.ws.send(JSON.stringify(["EVENT", sub.subId, ev]));
                }
              }
            } else if (type === "REQ") {
              const subId = parsed[1] as string;
              const filters = parsed.slice(2) as Filter[];

              subscriptions.set(subId, { subId, filters, ws });

              // Send stored matching events
              for (const ev of events) {
                if (matchFilters(filters, ev)) {
                  ws.send(JSON.stringify(["EVENT", subId, ev]));
                }
              }

              // Send EOSE
              ws.send(JSON.stringify(["EOSE", subId]));
            } else if (type === "CLOSE") {
              const subId = parsed[1] as string;
              subscriptions.delete(subId);
            }
          } catch {
            // Ignore malformed client frames
          }
        });

        ws.on("close", () => {
          for (const [key, sub] of subscriptions.entries()) {
            if (sub.ws === ws) {
              subscriptions.delete(key);
            }
          }
        });
      });

      resolve({
        url,
        port,
        clear() {
          events = [];
        },
        getEvents() {
          return [...events];
        },
        close(): Promise<void> {
          return new Promise((res) => {
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close(() => {
              res();
            });
          });
        },
      });
    });

    wss.on("error", reject);
  });
}
