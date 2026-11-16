import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  MessageId,
  OrchestrationV2ExternalWaitDependency,
  OrchestrationV2ExternalWaitRecord,
  OrchestrationV2ExternalWaitResult,
  OrchestrationV2ExternalWaitState,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

const decodeTurnItemId = Schema.decodeSync(TurnItemId);
const decodeMessageId = Schema.decodeSync(MessageId);
const decodeRunId = Schema.decodeSync(RunId);

export type ExternalWaitDependency = OrchestrationV2ExternalWaitDependency;
export type ExternalWaitTerminal = OrchestrationV2ExternalWaitResult;
export type ExternalWaitDisposition = OrchestrationV2ExternalWaitState;
export type ExternalWaitDelivery = OrchestrationV2ExternalWaitRecord["delivery"];
export type ExternalWaitRecord = OrchestrationV2ExternalWaitRecord;

export type ExternalWaitObservation = Readonly<{
  runId: string;
  attempt: number;
  headSha: string;
  conclusion: "success" | "failure" | "cancelled" | "startup_failure";
}>;

export type ExternalWaitReaderError =
  | "unreadable_host"
  | "observer_init_failure"
  | "bounded_read_error";

export type ExternalWaitRead =
  | { readonly kind: "pending"; readonly nextDueAt: DateTime.Utc }
  | { readonly kind: "observation"; readonly value: ExternalWaitObservation }
  | { readonly kind: "error"; readonly error: ExternalWaitReaderError };

const MAX_DELIVERY_ATTEMPTS = 3;

const terminalForObservation = (
  conclusion: ExternalWaitObservation["conclusion"],
): ExternalWaitTerminal => {
  switch (conclusion) {
    case "success":
      return "remote_success";
    case "failure":
      return "remote_failure";
    case "cancelled":
      return "remote_cancelled";
    case "startup_failure":
      return "remote_startup_failure";
  }
};

const sameDependency = (left: ExternalWaitDependency, right: ExternalWaitDependency): boolean =>
  left.host === right.host &&
  left.repository === right.repository &&
  left.runId === right.runId &&
  left.attempt === right.attempt &&
  left.expectedHeadSha === right.expectedHeadSha;

const epoch = (value: DateTime.Utc): number => DateTime.toEpochMillis(value);
const isTerminal = (
  state: ExternalWaitDisposition,
): state is Extract<ExternalWaitDisposition, { kind: "terminal" }> => state.kind === "terminal";
const isNonTerminal = (
  state: ExternalWaitDisposition,
): state is Extract<ExternalWaitDisposition, { kind: "pending" | "held" | "cancelled" }> =>
  state.kind === "pending" || state.kind === "held" || state.kind === "cancelled";

export class ExternalWaitRegistry {
  private readonly records = new Map<TurnItemId, ExternalWaitRecord>();
  private nextItem = 0;

  register(input: {
    ownerThreadId: ThreadId;
    ownerRunId: RunId;
    callerKey: string;
    generation?: number;
    dependency: ExternalWaitDependency;
    deadlineAt: DateTime.Utc;
    nextDueAt: DateTime.Utc;
    itemId?: TurnItemId;
    reservedMessageId?: MessageId;
    queuedRunId?: RunId;
  }): { readonly record: ExternalWaitRecord; readonly created: boolean } {
    const generation = input.generation ?? 1;
    const sameCaller = [...this.records.values()].filter(
      (record) =>
        record.ownerThreadId === input.ownerThreadId && record.callerKey === input.callerKey,
    );
    const existing = sameCaller.find(
      (record) => record.generation === generation && record.ownerRunId === input.ownerRunId,
    );
    if (existing !== undefined) {
      if (existing.state.kind === "disposed" || existing.state.kind === "cancelled") {
        throw new Error("cancelled or disposed external wait requires an explicit new generation");
      }
      if (isTerminal(existing.state)) {
        throw new Error("terminal external wait requires an explicit new generation");
      }
      if (
        !sameDependency(existing.dependency, input.dependency) ||
        epoch(existing.deadlineAt) !== epoch(input.deadlineAt)
      ) {
        throw new Error("external wait caller key is already bound to a different dependency");
      }
      return { record: existing, created: false };
    }
    const conflicting = sameCaller.find((record) => record.generation === generation);
    if (conflicting !== undefined) {
      throw new Error("external wait caller key is bound to a different owner run");
    }

    const itemNumber = ++this.nextItem;
    const itemId = input.itemId ?? decodeTurnItemId(`external-wait:${itemNumber}`);
    const record: ExternalWaitRecord = {
      type: "external_wait",
      itemId,
      ownerThreadId: input.ownerThreadId,
      ownerRunId: input.ownerRunId,
      callerKey: input.callerKey,
      generation,
      dependency: input.dependency,
      deadlineAt: input.deadlineAt,
      state: {
        kind: "pending",
        nextDueAt:
          epoch(input.nextDueAt) <= epoch(input.deadlineAt) ? input.nextDueAt : input.deadlineAt,
      },
      reservedMessageId:
        input.reservedMessageId ?? decodeMessageId(`external-wait-message:${itemNumber}`),
      queuedRunId: input.queuedRunId ?? decodeRunId(`external-wait-run:${itemNumber}`),
      delivery: { kind: "undelivered" },
    };
    this.records.set(itemId, record);
    return { record, created: true };
  }

  get(itemId: TurnItemId): ExternalWaitRecord | undefined {
    return this.records.get(itemId);
  }

  list(): ReadonlyArray<ExternalWaitRecord> {
    return [...this.records.values()];
  }

  reconcile(itemId: TurnItemId, read: ExternalWaitRead, now: DateTime.Utc): ExternalWaitRecord {
    const current = this.require(itemId);
    if (current.state.kind !== "pending") return current;
    if (epoch(now) >= epoch(current.deadlineAt)) {
      return this.replaceState(current, { kind: "terminal", result: "deadline", observedAt: now });
    }
    if (read.kind === "pending") {
      return this.replaceState(current, {
        kind: "pending",
        nextDueAt:
          epoch(read.nextDueAt) <= epoch(current.deadlineAt) ? read.nextDueAt : current.deadlineAt,
      });
    }
    if (read.kind === "error") {
      return this.replaceState(current, {
        kind: "terminal",
        result: "observer_error",
        observedAt: now,
      });
    }
    const { value } = read;
    if (
      value.runId !== current.dependency.runId ||
      value.attempt !== current.dependency.attempt ||
      value.headSha !== current.dependency.expectedHeadSha
    ) {
      return this.replaceState(current, {
        kind: "terminal",
        result: "observer_error",
        observedAt: now,
      });
    }
    return this.replaceState(current, {
      kind: "terminal",
      result: terminalForObservation(value.conclusion),
      observedAt: now,
    });
  }

  hold(
    itemId: TurnItemId,
    reason: Extract<ExternalWaitDisposition, { kind: "held" }>["reason"],
  ): ExternalWaitRecord {
    const current = this.require(itemId);
    if (!isNonTerminal(current.state) || current.state.kind === "cancelled") return current;
    return this.replaceState(current, { kind: "held", reason });
  }

  resume(itemId: TurnItemId, nextDueAt: DateTime.Utc, now: DateTime.Utc): ExternalWaitRecord {
    const current = this.require(itemId);
    if (current.state.kind !== "held") return current;
    if (epoch(nextDueAt) >= epoch(current.deadlineAt)) {
      return this.replaceState(current, { kind: "terminal", result: "deadline", observedAt: now });
    }
    return this.replaceState(current, { kind: "pending", nextDueAt });
  }

  cancel(itemId: TurnItemId, now: DateTime.Utc): ExternalWaitRecord {
    const current = this.require(itemId);
    if (isTerminal(current.state)) throw new Error("terminal external wait cannot be cancelled");
    if (current.state.kind === "disposed" || current.state.kind === "cancelled") return current;
    return this.replaceState(current, { kind: "cancelled", cancelledAt: now });
  }

  dispose(itemId: TurnItemId, now: DateTime.Utc): ExternalWaitRecord {
    const current = this.require(itemId);
    if (isTerminal(current.state)) throw new Error("terminal external wait cannot be disposed");
    if (current.state.kind === "disposed") return current;
    const prior = current.state.kind;
    return this.replace({
      ...current,
      state: { kind: "disposed", disposedAt: now, prior },
      delivery: { kind: "disposed" },
    });
  }

  beginDelivery(itemId: TurnItemId): ExternalWaitRecord {
    const current = this.require(itemId);
    if (!isTerminal(current.state)) return current;
    if (
      current.delivery.kind === "queueing" ||
      current.delivery.kind === "queued" ||
      current.delivery.kind === "accepted"
    ) {
      return current;
    }
    if (current.delivery.kind === "held" || current.delivery.kind === "disposed") return current;
    const attempt = current.delivery.kind === "failed" ? current.delivery.attempt + 1 : 1;
    if (attempt > MAX_DELIVERY_ATTEMPTS) {
      return this.replace({ ...current, delivery: { kind: "held", reason: "retry_limit" } });
    }
    return this.replace({ ...current, delivery: { kind: "queueing", attempt } });
  }

  commitDelivery(itemId: TurnItemId, queuedAt: DateTime.Utc): ExternalWaitRecord {
    const current = this.require(itemId);
    if (current.delivery.kind !== "queueing") return current;
    return this.replace({
      ...current,
      delivery: { kind: "queued", attempt: current.delivery.attempt, queuedAt },
    });
  }

  failDelivery(itemId: TurnItemId, reason: string): ExternalWaitRecord {
    const current = this.require(itemId);
    if (current.delivery.kind !== "queueing") return current;
    if (current.delivery.attempt >= MAX_DELIVERY_ATTEMPTS) {
      return this.replace({ ...current, delivery: { kind: "held", reason: "retry_limit" } });
    }
    return this.replace({
      ...current,
      delivery: { kind: "failed", attempt: current.delivery.attempt, reason },
    });
  }

  accept(itemId: TurnItemId, acceptedAt: DateTime.Utc): ExternalWaitRecord {
    const current = this.require(itemId);
    if (current.delivery.kind !== "queued") return current;
    return this.replace({ ...current, delivery: { kind: "accepted", acceptedAt } });
  }

  recoverQueueing(itemId: TurnItemId): ExternalWaitRecord {
    const current = this.require(itemId);
    if (current.delivery.kind !== "queueing") return current;
    return this.failDelivery(itemId, "queue interrupted before commit");
  }

  snapshot(): ReadonlyArray<ExternalWaitRecord> {
    return this.list();
  }

  restore(records: ReadonlyArray<ExternalWaitRecord>): void {
    this.records.clear();
    for (const record of records) {
      this.records.set(record.itemId, record);
      const number = Number(record.itemId.split(":").at(-1));
      if (Number.isSafeInteger(number)) this.nextItem = Math.max(this.nextItem, number);
    }
  }

  private require(itemId: TurnItemId): ExternalWaitRecord {
    const record = this.records.get(itemId);
    if (record === undefined) throw new Error(`unknown external wait ${itemId}`);
    return record;
  }

  private replaceState(
    record: ExternalWaitRecord,
    state: ExternalWaitDisposition,
  ): ExternalWaitRecord {
    return this.replace({ ...record, state });
  }

  private replace(record: ExternalWaitRecord): ExternalWaitRecord {
    this.records.set(record.itemId, record);
    return record;
  }
}
