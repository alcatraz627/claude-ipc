import { afterEach, describe, expect, test } from "bun:test";
import { AppServerWebSocketRpc, DEFER_TO_OTHER_CLIENT } from "../src/codex/webSocketRpc.ts";

const servers: { stop(closeActiveConnections?: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("AppServerWebSocketRpc", () => {
  test("a no-timeout request waits for the definitive App Server response", async () => {
    const server = Bun.serve<{ socket: true }>({
      port: 0,
      fetch(request, server) {
        return server.upgrade(request, { data: { socket: true } }) ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        message(socket, raw) {
          const request = JSON.parse(String(raw)) as { id: number; method: string };
          setTimeout(() => socket.send(JSON.stringify({ id: request.id, result: { method: request.method } })), 30);
        },
      },
    });
    servers.push(server);
    const rpc = await AppServerWebSocketRpc.connect(`ws://127.0.0.1:${server.port}`, async () => ({}), () => {}, 5);
    await expect(rpc.request("turn/start", {}, 0)).resolves.toEqual({ method: "turn/start" });
    rpc.stop();
  });

  test("socket closure rejects requests that deliberately have no timer", async () => {
    const server = Bun.serve<{ socket: true }>({
      port: 0,
      fetch(request, server) {
        return server.upgrade(request, { data: { socket: true } }) ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        message(socket) {
          socket.close();
        },
      },
    });
    servers.push(server);
    const rpc = await AppServerWebSocketRpc.connect(`ws://127.0.0.1:${server.port}`, async () => ({}));
    await expect(rpc.request("turn/start", {}, 0)).rejects.toThrow("WebSocket closed");
  });

  test("leaves broadcast server requests for the native TUI client", async () => {
    const responses: unknown[] = [];
    const server = Bun.serve<{ socket: true }>({
      port: 0,
      fetch(request, server) {
        return server.upgrade(request, { data: { socket: true } }) ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          socket.send(JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: {} }));
        },
        message(_socket, raw) {
          responses.push(JSON.parse(String(raw)));
        },
      },
    });
    servers.push(server);
    const rpc = await AppServerWebSocketRpc.connect(
      `ws://127.0.0.1:${server.port}`,
      async () => DEFER_TO_OTHER_CLIENT,
    );
    await Bun.sleep(25);
    expect(responses).toEqual([]);
    rpc.stop();
  });
});
