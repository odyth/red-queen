import type { ServerResponse } from "node:http";
import type { DashboardEventMap, DashboardEventName } from "./shared/api-types.js";

export type DashboardEventType = DashboardEventName;

// Discriminated union over event name so broadcasters get type-checked
// against the wire shape declared in shared/api-types.
export type DashboardEvent = {
  [K in DashboardEventName]: { type: K; data: DashboardEventMap[K] };
}[DashboardEventName];

export class SSEManager {
  private readonly clients = new Set<ServerResponse>();

  addClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
    });
  }

  removeClient(res: ServerResponse): void {
    this.clients.delete(res);
  }

  clientCount(): number {
    return this.clients.size;
  }

  broadcast(event: DashboardEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    const dead: ServerResponse[] = [];
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        dead.push(client);
      }
    }
    for (const client of dead) {
      this.clients.delete(client);
    }
  }

  close(): void {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // Already closed
      }
    }
    this.clients.clear();
  }
}
