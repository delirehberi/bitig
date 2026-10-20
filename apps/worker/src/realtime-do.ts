import { DurableObject } from "cloudflare:workers";
import type { RealtimeEvent } from "@bitig/core";

const HTTP_SWITCHING_PROTOCOLS = 101;
const HTTP_UPGRADE_REQUIRED = 426;
const WS_GOING_AWAY = 1001;
const WS_INTERNAL_ERROR = 1011;

/**
 * Coordinates live WebSocket connections for the workspace using the Durable
 * Object WebSocket Hibernation API. The Worker calls `publish` via RPC whenever
 * a storage mutation succeeds, fanning the event out to every connected browser.
 */
export class RealtimeHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override fetch(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { error: "upgrade_required", message: "Expected Upgrade: websocket" },
        { status: HTTP_UPGRADE_REQUIRED },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: HTTP_SWITCHING_PROTOCOLS, webSocket: client });
  }

  /** Broadcasts a mutation event to all active WebSocket connections. */
  publish(event: RealtimeEvent): number {
    const payload = JSON.stringify(event);
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
        delivered += 1;
      } catch (error) {
        console.warn("realtime websocket send failed, closing socket", { error });
        this.safeClose(ws, WS_GOING_AWAY, "Send failed");
      }
    }
    return delivered;
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.safeClose(ws, code, reason);
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    console.warn("realtime websocket error", { error });
    this.safeClose(ws, WS_INTERNAL_ERROR, "WebSocket error");
  }

  private safeClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch (error) {
      console.warn("realtime websocket close failed", { error });
    }
  }
}

