import { afterEach, expect, it } from "vitest";
import { startRelay, type Relay } from "../src/relay";
import { startFakeUpstream, type FakeUpstream } from "./harness";

let relay: Relay | undefined;
let upstream: FakeUpstream | undefined;
afterEach(async () => {
  await relay?.stop();
  await upstream?.close();
  relay = upstream = undefined;
});

const post = (body: string) =>
  fetch(`${relay!.url}/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer secret-token" },
    body,
  });

it("rejects a malformed Messages body with an explicit error, never forwarding it unmodified", async () => {
  upstream = await startFakeUpstream(["normal"]);
  let called = false;
  relay = await startRelay({
    upstream: upstream.url,
    log: () => {},
    onPayload: () => {
      called = true;
    },
  } as any);

  const res = await post("{not json");

  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(called).toBe(false);
  expect(upstream.requests).toHaveLength(0);
});

it("keeps the one-request guard when a hook edits the first request", async () => {
  upstream = await startFakeUpstream(["normal"]);
  relay = await startRelay({
    upstream: upstream.url,
    log: () => {},
    onPayload: async (payload: any) => {
      payload.max_tokens = 9;
    },
  } as any);

  const first = await post(JSON.stringify({ max_tokens: 1 }));
  const second = await post(JSON.stringify({ max_tokens: 1 }));

  expect(first.status).toBe(200);
  expect(second.status).toBe(400);
  expect(upstream.requests).toHaveLength(1);
  expect(upstream.requests[0].body).toEqual({ max_tokens: 9 });
});
