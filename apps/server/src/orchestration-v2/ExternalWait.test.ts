import { expect, it } from "@effect/vitest";
import { ExternalWaitRegistry } from "./ExternalWait.ts";

const dependency = {
  host: "github.com",
  repository: "acme/app",
  runId: "42",
  attempt: 1,
  expectedHeadSha: "abc",
};
const setup = () => new ExternalWaitRegistry();

it("registers idempotently and resumes one actionable result after restart", () => {
  const registry = setup();
  const first = registry.register({
    ownerThreadId: "thread",
    ownerRunId: "run",
    callerKey: "checks",
    dependency,
    deadlineAt: 100,
    nextDueAt: 10,
  });
  const duplicate = registry.register({
    ownerThreadId: "thread",
    ownerRunId: "run",
    callerKey: "checks",
    dependency,
    deadlineAt: 100,
    nextDueAt: 20,
  });
  expect(duplicate).toEqual({ record: first.record, created: false });

  const recovered = setup();
  recovered.restore(registry.snapshot());
  const terminal = recovered.reconcile(
    first.record.itemId,
    {
      kind: "observation",
      value: { runId: "42", attempt: 1, headSha: "abc", conclusion: "failure" },
    },
    20,
  );
  expect(terminal.disposition).toEqual({
    kind: "terminal",
    result: "remote_failure",
    observedAt: 20,
  });
  expect(
    recovered.reconcile(
      first.record.itemId,
      {
        kind: "observation",
        value: { runId: "42", attempt: 1, headSha: "abc", conclusion: "success" },
      },
      21,
    ),
  ).toEqual(terminal);
  const delivery = recovered.deliver(first.record.itemId);
  expect(delivery.shouldDeliver).toBe(true);
  expect(recovered.deliver(first.record.itemId).shouldDeliver).toBe(false);
  expect(recovered.accept(first.record.itemId).delivery).toBe("accepted");
  expect(terminal.reservedMessageId).toBe(first.record.reservedMessageId);
});

it("rejects mismatched attempts and never revives held or cancelled work", () => {
  const registry = setup();
  const item = registry.register({
    ownerThreadId: "thread",
    ownerRunId: "run",
    callerKey: "checks",
    dependency,
    deadlineAt: 100,
    nextDueAt: 10,
  }).record;
  expect(
    registry.reconcile(
      item.itemId,
      {
        kind: "observation",
        value: { runId: "42", attempt: 2, headSha: "abc", conclusion: "success" },
      },
      20,
    ).disposition,
  ).toEqual({ kind: "terminal", result: "observer_error", observedAt: 20 });

  const held = registry.register({
    ownerThreadId: "thread",
    ownerRunId: "run",
    callerKey: "held",
    dependency,
    deadlineAt: 100,
    nextDueAt: 10,
  }).record;
  registry.hold(held.itemId, "quota");
  expect(
    registry.reconcile(
      held.itemId,
      {
        kind: "observation",
        value: { runId: "42", attempt: 1, headSha: "abc", conclusion: "success" },
      },
      20,
    ),
  ).toEqual(registry.get(held.itemId));

  const cancelled = registry.register({
    ownerThreadId: "thread",
    ownerRunId: "run",
    callerKey: "cancelled",
    dependency,
    deadlineAt: 100,
    nextDueAt: 10,
  }).record;
  const cancelledRecord = registry.cancel(cancelled.itemId);
  expect(
    registry.reconcile(
      cancelled.itemId,
      {
        kind: "observation",
        value: { runId: "42", attempt: 1, headSha: "abc", conclusion: "success" },
      },
      20,
    ),
  ).toEqual(cancelledRecord);
  expect(registry.deliver(cancelled.itemId).shouldDeliver).toBe(false);
});

it.each([
  ["success", "remote_success"],
  ["failure", "remote_failure"],
  ["cancelled", "remote_cancelled"],
  ["startup_failure", "remote_startup_failure"],
] as const)("maps an Actions %s conclusion to one owner result", (conclusion, result) => {
  const registry = setup();
  const item = registry.register({
    ownerThreadId: "thread",
    ownerRunId: "run",
    callerKey: conclusion,
    dependency,
    deadlineAt: 100,
    nextDueAt: 10,
  }).record;
  expect(
    registry.reconcile(
      item.itemId,
      { kind: "observation", value: { runId: "42", attempt: 1, headSha: "abc", conclusion } },
      20,
    ).disposition,
  ).toEqual({ kind: "terminal", result, observedAt: 20 });
});

it("requires a new generation after disposal", () => {
  const registry = setup();
  const item = registry.register({
    ownerThreadId: "thread",
    ownerRunId: "run",
    callerKey: "checks",
    dependency,
    deadlineAt: 100,
    nextDueAt: 10,
  }).record;
  registry.dispose(item.itemId);
  expect(() =>
    registry.register({
      ownerThreadId: "thread",
      ownerRunId: "run",
      callerKey: "checks",
      dependency,
      deadlineAt: 100,
      nextDueAt: 10,
    }),
  ).toThrow("explicit new generation");
  const next = registry.register({
    ownerThreadId: "thread",
    ownerRunId: "run",
    callerKey: "checks",
    generation: 2,
    dependency,
    deadlineAt: 100,
    nextDueAt: 10,
  });
  expect(next.created).toBe(true);
  expect(next.record.itemId).not.toBe(item.itemId);
});

it("turns bounded reader errors and deadlines into one terminal result", () => {
  const registry = setup();
  const error = registry.register({
    ownerThreadId: "thread",
    ownerRunId: "run",
    callerKey: "error",
    dependency,
    deadlineAt: 100,
    nextDueAt: 10,
  }).record;
  expect(
    registry.reconcile(error.itemId, { kind: "error", error: "unreadable_host" }, 20).disposition,
  ).toEqual({ kind: "terminal", result: "observer_error", observedAt: 20 });
  const deadline = registry.register({
    ownerThreadId: "thread",
    ownerRunId: "run",
    callerKey: "deadline",
    dependency,
    deadlineAt: 30,
    nextDueAt: 10,
  }).record;
  expect(
    registry.reconcile(deadline.itemId, { kind: "pending", nextDueAt: 25 }, 30).disposition,
  ).toEqual({ kind: "terminal", result: "deadline", observedAt: 30 });
});
