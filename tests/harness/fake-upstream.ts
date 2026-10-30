import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** Scripted upstream behaviours. */
export type Scenario =
  | "normal"
  | "thinking_only"
  | "tool_call"
  | "made_up_tool"
  | "made_up_mcp_tool"
  | "custom_tool"
  | "t3_code_tool"
  | "echo_tool_result"
  | "401"
  | "429"
  | "503"
  | "529"
  | "hang";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FakeUpstream {
  /** Base URL, e.g. http://127.0.0.1:41234 */
  url: string;
  /** Every request received, in order (hung requests included). */
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export const NORMAL_TEXT = "Hello from the fake upstream";

function message(content: unknown[], stopReason: string) {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function toolUse(name: string) {
  return message(
    [{ type: "tool_use", id: "toolu_fake", name, input: { path: "a.txt" } }],
    "tool_use",
  );
}

function error(type: string, status: number) {
  return { status, body: { type: "error", error: { type, message: type } } };
}

/**
 * Start a fake Anthropic endpoint on a random local port. Responses are served
 * from `scenarios` in order; the last one repeats once the list runs out.
 */
export async function startFakeUpstream(
  scenarios: Scenario[] = ["normal"],
): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const index = requests.length;
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      });

      const scenario = scenarios[Math.min(index, scenarios.length - 1)];
      let status = 200;
      let body: unknown;
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };

      switch (scenario) {
        case "hang":
          return; // never answer
        case "normal":
          body = message([{ type: "text", text: NORMAL_TEXT }], "end_turn");
          break;
        case "echo_tool_result": {
          // Echo only an actual tool-result turn in the replay request. Missing
          // history must fail, not produce a canned successful final answer.
          const request = requests[index].body as {
            messages?: { content?: unknown }[];
          };
          const text = (request.messages ?? [])
            .flatMap((entry) =>
              Array.isArray(entry.content) ? entry.content : [],
            )
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          const result = text.match(
            /<turn role="tool"(?: name="[^"]+")?>\n([\s\S]*?)\n<\/turn>/,
          );
          if (!result?.[1]) {
            ({ status, body } = error("missing_tool_result", 400));
          } else {
            body = message(
              [{ type: "text", text: `Tool returned: ${result[1]}` }],
              "end_turn",
            );
          }
          break;
        }
        case "thinking_only":
          body = message([{ type: "thinking", thinking: "" }], "end_turn");
          break;
        case "tool_call":
          body = toolUse("Read");
          break;
        case "made_up_tool":
          body = toolUse("totally_made_up_tool");
          break;
        case "made_up_mcp_tool":
          body = toolUse("mcp__ghost-server__totally_made_up_tool");
          break;
        case "t3_code_tool":
          body = toolUse("mcp__custom-tools__mcp__t3_code__link_pull_request");
          break;
        case "custom_tool":
          body = message(
            [
              {
                type: "tool_use",
                id: "toolu_fake",
                name: "mcp__custom-tools__hello",
                input: { name: "Pi" },
              },
            ],
            "tool_use",
          );
          break;
        case "401":
          ({ status, body } = error("authentication_error", 401));
          break;
        case "429":
          ({ status, body } = error("rate_limit_error", 429));
          headers["retry-after"] = "30";
          break;
        case "503":
          ({ status, body } = error("api_error", 503));
          break;
        case "529":
          ({ status, body } = error("overloaded_error", 529));
          break;
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
