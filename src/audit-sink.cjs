// Shared by the TypeScript extension and the standalone Node loader check.
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const events = new Set([
  "request_start",
  "request_terminal",
  "extension_load",
  "registration",
]);
const reasons = new Set([
  "stop",
  "length",
  "toolUse",
  "cancelled",
  "attachment_rejected",
  "repeated_tool_rejected",
  "protocol_error",
  "cli_exit",
  "result_error",
  "spawn_error",
  "http_error",
  "timeout",
  "inactivity_timeout",
  "hook_error",
  "tool_inventory_error",
  "resume_missing",
  "error",
  "sdk_import_error",
  "sdk_load_error",
  "loader_errors",
  "not_loaded",
  "registered",
  "registration_error",
  "cli_missing",
  "auth_unavailable",
  "relay_error",
]);
const number = (v) =>
  v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
const pick = (obj, keys, valid) =>
  Object.fromEntries(
    keys.filter((k) => valid(obj?.[k])).map((k) => [k, obj[k]]),
  );
const oneOf = (values) => (v) => values.includes(v);

// Construct every field explicitly. Raw objects, errors and strings never pass through.
function sanitize(record) {
  if (!events.has(record.event)) return null;
  const out = { event: record.event };
  Object.assign(
    out,
    pick(
      record,
      ["requestId"],
      (v) => typeof v === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(v),
    ),
  );
  Object.assign(
    out,
    pick(
      record,
      ["model"],
      (v) => typeof v === "string" && /^claude-[a-z0-9.-]{1,80}$/.test(v),
    ),
  );
  Object.assign(out, pick(record, ["route"], oneOf(["cli", "api"])));
  Object.assign(
    out,
    pick(record, ["sessionMode"], oneOf(["resume", "replay"])),
  );
  Object.assign(
    out,
    pick(
      record,
      ["outcome"],
      oneOf(["success", "error", "cancelled", "failure", "skipped"]),
    ),
  );
  Object.assign(
    out,
    pick(record, ["reason"], (v) => reasons.has(v)),
  );
  Object.assign(
    out,
    pick(
      record,
      ["hook"],
      oneOf(["onPayload", "onResponse", "onProviderStreamEvent"]),
    ),
  );
  if (record.versions)
    out.versions = pick(
      record.versions,
      ["extension", "pi", "cli"],
      (v) =>
        v === null ||
        (typeof v === "string" && /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(v)),
    );
  if (record.usage)
    out.usage = pick(
      record.usage,
      ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"],
      number,
    );
  if (record.estimatedCost)
    out.estimatedCost = pick(
      record.estimatedCost,
      ["input", "output", "cacheRead", "cacheWrite", "total"],
      number,
    );
  if (record.relay)
    out.relay = pick(record.relay, ["upstreamCount", "rejectedCount"], number);
  if (record.http) {
    out.http = pick(
      record.http,
      ["status"],
      (v) => Number.isInteger(v) && v >= 100 && v <= 599,
    );
    Object.assign(
      out.http,
      pick(
        record.http,
        ["retryAfter"],
        (v) => typeof v === "string" && /^\d{1,9}$/.test(v),
      ),
    );
  }
  if (record.cleanup) {
    out.cleanup = pick(
      record.cleanup,
      ["attempted"],
      (v) => typeof v === "boolean",
    );
    Object.assign(
      out.cleanup,
      pick(
        record.cleanup,
        ["process", "relay", "sandbox", "mcp"],
        oneOf(["confirmed", "failed", "unknown"]),
      ),
    );
  }
  if (Array.isArray(record.attempts))
    out.attempts = record.attempts.slice(0, 2).map((a) => ({
      ...pick(a, ["mode"], oneOf(["resume", "replay"])),
      ...pick(a, ["reason"], (v) => reasons.has(v)),
    }));
  return out;
}

function createAuditSink({
  extensionRoot,
  env = process.env,
  now = () => new Date(),
  warn = console.warn,
  maxFileBytes = 5 * 1024 * 1024,
}) {
  const enabled = ["1", "true"].includes(env.PI_CLAUDE_SUBSCRIPTION_AUDIT);
  const notify = (message) => {
    try {
      warn(`[pi-claude-subscription] audit ${message}`);
    } catch {
      /* Nonfatal, even with a failing warning handler. */
    }
  };
  return {
    async append(record) {
      if (!enabled) return;
      let lock;
      let fd;
      let originalSize;
      try {
        const root = fs.realpathSync(extensionRoot);
        const target = path.resolve(
          root,
          env.PI_CLAUDE_SUBSCRIPTION_AUDIT_DIR || ".audit",
        );
        const relative = path.relative(root, target);
        if (
          !relative ||
          relative.startsWith("..") ||
          path.isAbsolute(relative)
        ) {
          notify("directory rejected: must be inside extension installation");
          return;
        }
        // Walk components before creating children. Reject symlinks rather than
        // following one outside the installation, including dangling links.
        let dir = root;
        for (const component of relative.split(path.sep)) {
          dir = path.join(dir, component);
          try {
            fs.mkdirSync(dir, { mode: 0o700 });
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
          const stat = fs.lstatSync(dir);
          if (stat.isSymbolicLink()) {
            notify("directory rejected: must be inside extension installation");
            return;
          }
          if (!stat.isDirectory()) throw new Error("directory unavailable");
        }
        fs.chmodSync(dir, 0o700);
        const lockPath = path.join(dir, ".append-lock");
        // Cross-process exclusion covers both size checks and retention. A hard
        // kill may leave a lock; time out visibly rather than stealing a live lock.
        for (let i = 0; i < 100; i++) {
          try {
            fs.mkdirSync(lockPath, { mode: 0o700 });
            lock = lockPath;
            break;
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
            await delay(10);
          }
        }
        if (!lock) throw new Error("lock unavailable");
        const date = now();
        const day = date.toISOString().slice(0, 10);
        const cutoff = Date.parse(`${day}T00:00:00Z`) - 6 * 86400000;
        for (const name of fs.readdirSync(dir)) {
          if (
            /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) &&
            Date.parse(name.slice(0, 10)) < cutoff
          ) {
            const old = path.join(dir, name);
            if (fs.lstatSync(old).isFile()) fs.unlinkSync(old);
          }
        }
        const safe = sanitize(record);
        if (!safe) return;
        const line =
          JSON.stringify({
            ...safe,
            schemaVersion: 1,
            timestamp: date.toISOString(),
          }) + "\n";
        const filename = path.join(dir, `${day}.jsonl`);
        fd = fs.openSync(
          filename,
          fs.constants.O_CREAT |
            fs.constants.O_APPEND |
            fs.constants.O_WRONLY |
            fs.constants.O_NOFOLLOW |
            fs.constants.O_NONBLOCK,
          0o600,
        );
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe file");
        fs.fchmodSync(fd, 0o600);
        if (stat.size + Buffer.byteLength(line) > maxFileBytes) {
          notify("write failed: daily size limit reached");
          return;
        }
        originalSize = stat.size;
        const bytes = Buffer.from(line);
        let offset = 0;
        while (offset < bytes.length) {
          const written = fs.writeSync(
            fd,
            bytes,
            offset,
            bytes.length - offset,
          );
          if (!written) throw new Error("short write");
          offset += written;
        }
        fs.fsyncSync(fd);
      } catch {
        // Under the same append lock, discard a failed partial line when possible.
        try {
          if (fd !== undefined && originalSize !== undefined)
            fs.ftruncateSync(fd, originalSize);
        } catch {
          /* The warning covers an unavailable filesystem. */
        }
        notify("write failed: audit unavailable");
      } finally {
        try {
          if (fd !== undefined) fs.closeSync(fd);
        } catch {
          notify("flush failed: audit unavailable");
        }
        try {
          if (lock) fs.rmdirSync(lock);
        } catch {
          notify("write failed: audit lock unavailable");
        }
      }
    },
  };
}
module.exports = { createAuditSink };
