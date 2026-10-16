/**
 * Single-request relay between the Claude CLI and Anthropic.
 *
 * The CLI is pointed at this loopback server through ANTHROPIC_BASE_URL. Of
 * everything it sends, only the first `POST /v1/messages` goes upstream; a
 * later one gets a local error and a log line, so one Pi turn can never spend
 * more than one generation.
 *
 * Which request is "the real one": the first Messages request. In stream-json
 * input mode the CLI also fires a Haiku session-title request, and it fires it
 * first. The spawner suppresses that with
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1, so the first Messages request is
 * the real one, and the guard rejects any extra rather than guessing from the
 * body. `HEAD /api/hello` is answered locally (the CLI sends it unless that
 * variable is set). Nothing else is forwarded.
 *
 * Headers are copied to the upstream request as an opaque map. They are never
 * inspected, stored or logged.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { isDebugEnabled } from "./debug-log";

export interface Relay {
  /** Base URL for ANTHROPIC_BASE_URL, e.g. http://127.0.0.1:41234 */
  url: string;
  /** Messages requests forwarded upstream. */
  readonly upstreamCount: number;
  /** Messages requests rejected locally. */
  readonly rejectedCount: number;
  /** Close the server and drop open connections. Safe to call twice. */
  stop(): Promise<void>;
}

export interface RelayOptions {
  /** Upstream base URL. Defaults to ANTHROPIC_BASE_URL, then api.anthropic.com. */
  upstream?: string;
  /** Receives one line per request. Defaults to console.error. */
  log?: (line: string) => void;
}

const DEFAULT_UPSTREAM = "https://api.anthropic.com";

/** Relays still open, closed on process exit. */
const openRelays = new Set<() => void>();
let exitHookInstalled = false;

function closeAllOnExit(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const close of openRelays) close();
  });
}

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message },
    }),
  );
}

/**
 * Start a relay on 127.0.0.1 and a random free port.
 */
export async function startRelay(options?: RelayOptions): Promise<Relay> {
  const upstream = new URL(
    options?.upstream ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_UPSTREAM,
  );
  const log =
    options?.log ??
    ((line: string) => console.error(`[pi-claude-subscription] ${line}`));
  const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;

  let upstreamCount = 0;
  let rejectedCount = 0;
  const sockets = new Set<Socket>();

  function forward(req: IncomingMessage, res: ServerResponse): void {
    const proxied = send(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: upstream.pathname.replace(/\/$/, "") + req.url,
        headers: { ...req.headers, host: upstream.host },
      },
      (up) => {
        log(
          `relay POST ${req.url?.split("?")[0]} -> upstream status=${up.statusCode} upstream=${upstreamCount} rejected=${rejectedCount}`,
        );
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    proxied.on("error", (err) => {
      log(`relay upstream error: ${err.message}`);
      if (!res.headersSent) reject(res, 502, "relay: upstream unreachable");
      else res.destroy();
    });
    res.on("close", () => proxied.destroy());
    req.pipe(proxied);
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (isDebugEnabled()) {
      log(
        `relay debug: ${req.method} ${path} content-length=${req.headers["content-length"] ?? "none"}`,
      );
    }

    if (req.method === "HEAD" && path === "/api/hello") {
      res.writeHead(200).end();
      return;
    }

    if (req.method === "POST" && path === "/v1/messages") {
      if (upstreamCount >= 1) {
        rejectedCount++;
        log(
          `relay POST ${path} rejected: one Messages request per turn upstream=${upstreamCount} rejected=${rejectedCount}`,
        );
        req.resume();
        reject(
          res,
          400,
          "pi-claude-subscription relay: only one Messages request per turn is allowed",
        );
        return;
      }
      upstreamCount++;
      forward(req, res);
      return;
    }

    log(`relay ${req.method} ${path} answered locally, not forwarded`);
    req.resume();
    reject(res, 404, "pi-claude-subscription relay: path not forwarded");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  // A relay must never keep Pi alive.
  server.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  const closeNow = () => {
    server.close();
    for (const socket of sockets) socket.destroy();
  };
  openRelays.add(closeNow);
  closeAllOnExit();

  return {
    url: `http://127.0.0.1:${port}`,
    get upstreamCount() {
      return upstreamCount;
    },
    get rejectedCount() {
      return rejectedCount;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        openRelays.delete(closeNow);
        if (!server.listening) return resolve();
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
