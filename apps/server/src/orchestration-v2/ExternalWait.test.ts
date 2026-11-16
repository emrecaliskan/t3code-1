import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { ExternalWaitRegistry } from "./ExternalWait.ts";

const thread = Schema.decodeSync(ThreadId)("thread");
const decodeRunId = Schema.decodeSync(RunId);
const decodeMessageId = Schema.decodeSync(MessageId);
const run = decodeRunId("run");
const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000);
const dependency = {
  host: "github.com",
  repository: "acme/app",
  runId: "42",
  attempt: 1,
  expectedHeadSha: "abc",
};
const input = (callerKey: string) => ({
  ownerThreadId: thread,
  ownerRunId: run,
  callerKey,
  dependency,
  deadlineAt: at(100),
  nextDueAt: at(10),
});
const setup = () => new ExternalWaitRegistry();

it("registers by owner, generation, caller, dependency, and deadline", () => {
  const registry = setup();
  const first = registry.register(input("checks"));
  expect(registry.register({ ...input("checks"), nextDueAt: at(20) })).toEqual({
    record: first.record,
    created: false,
  });
  expect(() =>
    registry.register({ ...input("checks"), dependency: { ...dependency, attempt: 2 } }),
  ).toThrow();
  expect(() =>
    registry.register({ ...input("checks"), ownerRunId: decodeRunId("other") }),
  ).toThrow();
});

it("keeps terminal observations monotonic across restore and rejects cancellation or disposal", () => {
  const registry = setup();
  const item = registry.register(input("checks")).record;
  const recovered = setup();
  recovered.restore(registry.snapshot());
  const terminal = recovered.reconcile(
    item.itemId,
    {
      kind: "observation",
      value: { runId: "42", attempt: 1, headSha: "abc", conclusion: "failure" },
    },
    at(20),
  );
  expect(terminal.state).toEqual({
    kind: "terminal",
    result: "remote_failure",
    observedAt: at(20),
  });
  expect(
    recovered.reconcile(
      item.itemId,
      {
        kind: "observation",
        value: { runId: "42", attempt: 1, headSha: "abc", conclusion: "success" },
      },
      at(21),
    ),
  ).toEqual(terminal);
  expect(() => recovered.cancel(item.itemId, at(22))).toThrow();
  expect(() => recovered.dispose(item.itemId, at(22))).toThrow();
});

it("models explicit cancellation, disposal evidence, holds, resumes, and deadlines", () => {
  const registry = setup();
  const cancelled = registry.register(input("cancelled")).record;
  expect(registry.cancel(cancelled.itemId, at(12)).state).toEqual({
    kind: "cancelled",
    cancelledAt: at(12),
  });
  expect(
    registry.reconcile(cancelled.itemId, { kind: "pending", nextDueAt: at(20) }, at(20)),
  ).toEqual(registry.get(cancelled.itemId));
  const disposed = registry.register(input("disposed")).record;
  expect(registry.dispose(disposed.itemId, at(13)).state).toEqual({
    kind: "disposed",
    disposedAt: at(13),
    prior: "pending",
  });
  expect(registry.get(disposed.itemId)?.delivery).toEqual({ kind: "disposed" });
  const held = registry.register(input("held")).record;
  registry.hold(held.itemId, "quota");
  expect(registry.resume(held.itemId, at(20), at(20)).state).toEqual({
    kind: "pending",
    nextDueAt: at(20),
  });
  expect(
    registry.reconcile(held.itemId, { kind: "pending", nextDueAt: at(99) }, at(100)).state,
  ).toEqual({ kind: "terminal", result: "deadline", observedAt: at(100) });
});

it.each([
  ["success", "remote_success"],
  ["failure", "remote_failure"],
  ["cancelled", "remote_cancelled"],
  ["startup_failure", "remote_startup_failure"],
] as const)("maps %s to the exported terminal result", (conclusion, result) => {
  const registry = setup();
  const item = registry.register(input(conclusion)).record;
  expect(
    registry.reconcile(
      item.itemId,
      { kind: "observation", value: { runId: "42", attempt: 1, headSha: "abc", conclusion } },
      at(20),
    ).state,
  ).toEqual({ kind: "terminal", result, observedAt: at(20) });
});

it("reserves a stable message and recovers queueing with bounded retries", () => {
  const registry = setup();
  const item = registry.register(input("delivery")).record;
  registry.reconcile(item.itemId, { kind: "error", error: "bounded_read_error" }, at(20));
  expect(registry.beginDelivery(item.itemId).delivery).toEqual({ kind: "queueing", attempt: 1 });
  expect(registry.recoverQueueing(item.itemId).delivery).toEqual({
    kind: "failed",
    attempt: 1,
    reason: "queue interrupted before commit",
  });
  expect(registry.beginDelivery(item.itemId).delivery).toEqual({ kind: "queueing", attempt: 2 });
  expect(registry.failDelivery(item.itemId, "queue unavailable").delivery).toEqual({
    kind: "failed",
    attempt: 2,
    reason: "queue unavailable",
  });
  expect(registry.beginDelivery(item.itemId).delivery).toEqual({ kind: "queueing", attempt: 3 });
  expect(registry.failDelivery(item.itemId, "queue unavailable").delivery).toEqual({
    kind: "held",
    reason: "retry_limit",
  });
  expect(item.reservedMessageId).toBe(decodeMessageId("external-wait-message:1"));
});

it("requires commit before queued and accepts only committed delivery", () => {
  const registry = setup();
  const item = registry.register(input("accepted")).record;
  registry.reconcile(item.itemId, { kind: "error", error: "observer_init_failure" }, at(20));
  expect(registry.accept(item.itemId, at(21)).delivery).toEqual({ kind: "undelivered" });
  registry.beginDelivery(item.itemId);
  expect(registry.commitDelivery(item.itemId, at(22)).delivery).toEqual({
    kind: "queued",
    attempt: 1,
    queuedAt: at(22),
  });
  expect(registry.accept(item.itemId, at(23)).delivery).toEqual({
    kind: "accepted",
    acceptedAt: at(23),
  });
  expect(registry.accept(item.itemId, at(24)).delivery).toEqual({
    kind: "accepted",
    acceptedAt: at(23),
  });
});

it("requires a new generation after terminal, cancellation, or disposal", () => {
  const registry = setup();
  const item = registry.register(input("checks")).record;
  registry.reconcile(item.itemId, { kind: "error", error: "unreadable_host" }, at(20));
  expect(() => registry.register(input("checks"))).toThrow("new generation");
  const next = registry.register({ ...input("checks"), generation: 2 });
  expect(next.created).toBe(true);
  expect(next.record.itemId).not.toBe(item.itemId);
});
