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
 *
 * Hooks. With `onPayload`, the permitted Messages body is buffered, parsed and
 * handed to the hook; whatever it returns (or the original, edited in place,
 * when it returns undefined) is what goes upstream, with Content-Length
 * recomputed. A body that is not JSON, or a hook that throws, is refused
 * locally and recorded in `requestFailure`; nothing is forwarded. With
 * `onResponse`, the first forwarded response's status and headers are awaited
 * before its body is released to the CLI. Neither hook sees request headers.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { ProviderResponse } from "@earendil-works/pi-ai";
import { isDebugEnabled } from "./debug-log.js";

/** The first failed upstream response (any status of 400 or above). */
export interface UpstreamFailure {
  status: number;
  /** The retry-after header, as sent. */
  retryAfter?: string;
}

/**
 * The error text Pi shows. A 429 says "rate limit", which Pi's retry matcher
 * recognises, and keeps retry-after. A 401 avoids every retry keyword. Any
 * other status is named, so a 5xx reads as the server error it is.
 */
export function describeFailure(failure: UpstreamFailure): string {
  if (failure.status === 401) {
    return "Claude authentication failed. Run `claude auth login`, then try again.";
  }
  if (failure.status !== 429) {
    return `Claude API returned ${failure.status}${failure.status === 529 ? " (overloaded)" : ""}.`;
  }
  return failure.retryAfter
    ? `Claude rate limit reached; retry after ${failure.retryAfter}s.`
    : "Claude rate limit reached.";
}

export interface Relay {
  /** Base URL for ANTHROPIC_BASE_URL, e.g. http://127.0.0.1:41234 */
  url: string;
  /** Messages requests forwarded upstream. */
  readonly upstreamCount: number;
  /** Messages requests rejected locally. */
  readonly rejectedCount: number;
  /** Set when upstream answered with an error status. */
  readonly failure: UpstreamFailure | undefined;
  /** Set when the relay refused to forward the Messages request itself. */
  readonly requestFailure: string | undefined;
  /** Close the server and drop open connections. Safe to call twice. */
  stop(): Promise<void>;
}

export interface RelayOptions {
  /** Upstream base URL. Defaults to ANTHROPIC_BASE_URL, then api.anthropic.com. */
  upstream?: string;
  /** Receives one line per request. Defaults to console.error. */
  log?: (line: string) => void;
  /** Sees the parsed Messages body; a returned value replaces it. */
  onPayload?: (payload: unknown) => unknown | Promise<unknown>;
  /** Sees the upstream status and headers before the body is released. */
  onResponse?: (response: ProviderResponse) => void | Promise<void>;
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

/** Node's header map as the string map Pi's ProviderResponse carries. */
function headerRecord(headers: IncomingHttpHeaders): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      record[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return record;
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

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
  let failure: UpstreamFailure | undefined;
  let requestFailure: string | undefined;
  // The one Messages request has been claimed (forwarded or refused)
  let claimed = false;
  let stopped = false;
  const sockets = new Set<Socket>();
  const onPayload = options?.onPayload;
  const onResponse = options?.onResponse;

  /** Refuse the claimed Messages request locally, recording why. */
  function refuse(res: ServerResponse, reason: string, failureText: string) {
    requestFailure ??= failureText;
    log(`relay POST /v1/messages refused: ${reason}`);
    if (!res.headersSent) {
      reject(res, 400, `pi-claude-subscription relay: ${reason}`);
    } else res.destroy();
  }

  /** Forward to upstream; `body` replaces the request's own when given. */
  function forward(
    req: IncomingMessage,
    res: ServerResponse,
    body?: Buffer,
  ): void {
    upstreamCount++;
    let gone = false;
    res.on("close", () => (gone = true));
    const headers = { ...req.headers, host: upstream.host };
    if (body) {
      headers["content-length"] = String(body.length);
      delete headers["transfer-encoding"];
    }
    const proxied = send(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: upstream.pathname.replace(/\/$/, "") + req.url,
        headers,
      },
      (up) => {
        log(
          `relay POST ${req.url?.split("?")[0]} -> upstream status=${up.statusCode} upstream=${upstreamCount} rejected=${rejectedCount}`,
        );
        if (up.statusCode !== undefined && up.statusCode >= 400) {
          const retryAfter = up.headers["retry-after"];
          failure ??= {
            status: up.statusCode,
            ...(typeof retryAfter === "string" && { retryAfter }),
          };
        }
        const release = () => {
          if (gone || stopped) return void up.destroy();
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        };
        if (!onResponse) return release();
        // The body stays paused in `up` until the hook settles
        (async () =>
          onResponse({
            status: up.statusCode ?? 502,
            headers: headerRecord(up.headers),
          }))().then(release, (err) => {
          up.destroy();
          refuse(
            res,
            "response hook failed",
            `Response hook failed: ${errorText(err)}`,
          );
        });
      },
    );
    proxied.on("error", (err) => {
      log(`relay upstream error: ${err.message}`);
      if (!res.headersSent) reject(res, 502, "relay: upstream unreachable");
      else res.destroy();
    });
    res.on("close", () => proxied.destroy());
    if (body) proxied.end(body);
    else req.pipe(proxied);
  }

  /** Buffer and parse the body, let the hook edit it, then forward that. */
  function forwardEdited(
    req: IncomingMessage,
    res: ServerResponse,
    hook: (payload: unknown) => unknown,
  ): void {
    const chunks: Buffer[] = [];
    let gone = false;
    res.on("close", () => (gone = true));
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {
        refuse(
          res,
          "Messages request body is not valid JSON",
          "Claude CLI sent a Messages request body that is not valid JSON.",
        );
        return;
      }
      let body: Buffer;
      try {
        const replacement = await hook(payload);
        body = Buffer.from(
          JSON.stringify(replacement === undefined ? payload : replacement),
          "utf-8",
        );
      } catch (err) {
        refuse(
          res,
          "request hook failed",
          `Request hook failed: ${errorText(err)}`,
        );
        return;
      }
      // Cancelled while the hook ran: the CLI is gone, send nothing
      if (gone || stopped) return;
      forward(req, res, body);
    });
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
      if (claimed) {
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
      claimed = true;
      if (onPayload) forwardEdited(req, res, onPayload);
      else forward(req, res);
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
    stopped = true;
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
    get failure() {
      return failure;
    },
    get requestFailure() {
      return requestFailure;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        stopped = true;
        openRelays.delete(closeNow);
        if (!server.listening) return resolve();
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
