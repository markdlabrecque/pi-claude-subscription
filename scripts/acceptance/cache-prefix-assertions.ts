import assert from "node:assert/strict";

export type Block = { type: string; text?: string; cache_control?: unknown };
export type Payload = {
  system: unknown;
  tools: unknown;
  messages: { role: string; content: Block[] }[];
};

// Cache-control markers move as history grows; their placement is not content.
const contentBytes = (blocks: Block[]) =>
  JSON.stringify(blocks.map(({ cache_control: _cache, ...block }) => block));

/** Boolean assertions only: failures must not print private request content. */
export function assertPreviousPrefix(
  previous: Payload,
  current: Payload,
): void {
  assert(
    JSON.stringify(current.system) === JSON.stringify(previous.system),
    "system prompt changed",
  );
  assert(
    JSON.stringify(current.tools) === JSON.stringify(previous.tools),
    "tools changed",
  );
  assert(
    current.messages.length >= previous.messages.length,
    "messages removed",
  );
  for (const [index, message] of previous.messages.entries()) {
    const next = current.messages[index];
    assert(next.role === message.role, "previous message role changed");
    assert(
      contentBytes(next.content.slice(0, message.content.length)) ===
        contentBytes(message.content),
      "previous message content is not an identical prefix",
    );
  }
}

/** Inspect the normalized payload without retaining or printing raw paths. */
export function assertNormalizedEnvironment(payload: Payload) {
  const shapes: string[] = [];
  for (const [index, message] of payload.messages.entries()) {
    const block = message.content[0];
    if (message.role !== "user" || block?.type !== "text") continue;
    const text = block.text ?? "";
    if (
      /^(?:<system-reminder>\n)?# Environment\nYou have been invoked in the following environment: \n - Primary working directory: \[private CLI transport directory, not the Pi workspace\]\r?\n/.test(
        text,
      )
    ) {
      shapes.push(
        `${text.startsWith("<system-reminder>") ? "wrapped" : "unwrapped"}:messages[${index}]`,
      );
    }
  }
  assert(shapes.length > 0, "normalized environment reminder not found");
  assert(
    !/[/\\]pi-claude-subscription-[A-Za-z0-9]{6}(?=[/\\\s"']|$)/.test(
      JSON.stringify(payload).replaceAll("\\\\", "\\"),
    ),
    "raw private transport path remains in payload",
  );
  return {
    normalizedReminderObserved: true,
    rawPrivatePathAbsent: true,
    shapes,
  };
}
