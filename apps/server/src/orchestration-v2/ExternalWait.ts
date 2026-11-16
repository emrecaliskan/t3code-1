/** Durable state machine for one finite, exact external dependency. */

export type ExternalWaitDependency = Readonly<{
  host: string;
  repository: string;
  runId: string;
  attempt: number;
  expectedHeadSha: string;
}>;

export type ExternalWaitTerminal =
  | "remote_success"
  | "remote_failure"
  | "remote_cancelled"
  | "remote_startup_failure"
  | "deadline"
  | "observer_error";

export type ExternalWaitDisposition =
  | { readonly kind: "pending"; readonly nextDueAt: number }
  | {
      readonly kind: "held";
      readonly reason: "paused" | "decision" | "quota" | "provider_disabled";
    }
  | {
      readonly kind: "terminal";
      readonly result: ExternalWaitTerminal;
      readonly observedAt: number;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "disposed" };

export type ExternalWaitRecord = Readonly<{
  itemId: string;
  ownerThreadId: string;
  ownerRunId: string;
  callerKey: string;
  generation: number;
  dependency: ExternalWaitDependency;
  deadlineAt: number;
  disposition: ExternalWaitDisposition;
  reservedMessageId: string;
  queuedRunId: string;
  delivery: "undelivered" | "queued" | "accepted";
}>;

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
  | { readonly kind: "pending"; readonly nextDueAt: number }
  | { readonly kind: "observation"; readonly value: ExternalWaitObservation }
  | { readonly kind: "error"; readonly error: ExternalWaitReaderError };

export type ExternalWaitRegistration = Readonly<{
  readonly record: ExternalWaitRecord;
  readonly created: boolean;
}>;

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

const actionable = (record: ExternalWaitRecord): boolean => record.disposition.kind === "terminal";

export class ExternalWaitRegistry {
  private readonly records = new Map<string, ExternalWaitRecord>();
  private nextItem = 0;

  register(input: {
    ownerThreadId: string;
    ownerRunId: string;
    callerKey: string;
    generation?: number;
    dependency: ExternalWaitDependency;
    deadlineAt: number;
    nextDueAt: number;
  }): ExternalWaitRegistration {
    const existing = [...this.records.values()].find(
      (record) =>
        record.ownerThreadId === input.ownerThreadId &&
        record.callerKey === input.callerKey &&
        record.generation === (input.generation ?? record.generation),
    );
    if (existing !== undefined) {
      if (existing.disposition.kind === "disposed") {
        throw new Error("disposed external wait requires an explicit new generation");
      }
      if (
        !sameDependency(existing.dependency, input.dependency) ||
        existing.deadlineAt !== input.deadlineAt
      ) {
        throw new Error("external wait caller key is already bound to a different dependency");
      }
      return { record: existing, created: false };
    }

    const generation = input.generation ?? 1;
    const record: ExternalWaitRecord = {
      itemId: `external-wait:${++this.nextItem}`,
      ownerThreadId: input.ownerThreadId,
      ownerRunId: input.ownerRunId,
      callerKey: input.callerKey,
      generation,
      dependency: input.dependency,
      deadlineAt: input.deadlineAt,
      disposition: { kind: "pending", nextDueAt: Math.min(input.nextDueAt, input.deadlineAt) },
      reservedMessageId: `external-wait-message:${this.nextItem}`,
      queuedRunId: `external-wait-run:${this.nextItem}`,
      delivery: "undelivered",
    };
    this.records.set(record.itemId, record);
    return { record, created: true };
  }

  get(itemId: string): ExternalWaitRecord | undefined {
    return this.records.get(itemId);
  }

  list(): ReadonlyArray<ExternalWaitRecord> {
    return [...this.records.values()];
  }

  reconcile(itemId: string, read: ExternalWaitRead, now: number): ExternalWaitRecord {
    const current = this.require(itemId);
    if (current.disposition.kind !== "pending") return current;
    if (now >= current.deadlineAt)
      return this.replace(current, { kind: "terminal", result: "deadline", observedAt: now });
    if (read.kind === "pending") {
      return this.replace(current, {
        kind: "pending",
        nextDueAt: Math.min(Math.max(read.nextDueAt, now), current.deadlineAt),
      });
    }
    if (read.kind === "error") {
      return this.replace(current, { kind: "terminal", result: "observer_error", observedAt: now });
    }
    const { value } = read;
    if (
      value.runId !== current.dependency.runId ||
      value.attempt !== current.dependency.attempt ||
      value.headSha !== current.dependency.expectedHeadSha
    ) {
      return this.replace(current, { kind: "terminal", result: "observer_error", observedAt: now });
    }
    return this.replace(current, {
      kind: "terminal",
      result: terminalForObservation(value.conclusion),
      observedAt: now,
    });
  }

  hold(
    itemId: string,
    reason: "paused" | "decision" | "quota" | "provider_disabled",
  ): ExternalWaitRecord {
    const current = this.require(itemId);
    if (current.disposition.kind === "disposed" || current.disposition.kind === "cancelled")
      return current;
    return this.replace(current, { kind: "held", reason });
  }

  resume(itemId: string, nextDueAt: number): ExternalWaitRecord {
    const current = this.require(itemId);
    if (current.disposition.kind !== "held") return current;
    if (nextDueAt >= current.deadlineAt)
      return this.replace(current, { kind: "terminal", result: "deadline", observedAt: nextDueAt });
    return this.replace(current, { kind: "pending", nextDueAt });
  }

  cancel(itemId: string): ExternalWaitRecord {
    const current = this.require(itemId);
    if (current.disposition.kind === "terminal" || current.disposition.kind === "disposed")
      return current;
    return this.replace(current, { kind: "cancelled" });
  }

  dispose(itemId: string): ExternalWaitRecord {
    const current = this.require(itemId);
    return this.replace(current, { kind: "disposed" });
  }

  deliver(itemId: string): {
    readonly record: ExternalWaitRecord;
    readonly shouldDeliver: boolean;
  } {
    const current = this.require(itemId);
    if (!actionable(current) || current.delivery !== "undelivered") {
      return { record: current, shouldDeliver: false };
    }
    const queued = { ...current, delivery: "queued" as const };
    this.records.set(itemId, queued);
    return { record: queued, shouldDeliver: true };
  }

  accept(itemId: string): ExternalWaitRecord {
    const current = this.require(itemId);
    if (current.delivery !== "queued") return current;
    const accepted = { ...current, delivery: "accepted" as const };
    this.records.set(itemId, accepted);
    return accepted;
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

  private require(itemId: string): ExternalWaitRecord {
    const record = this.records.get(itemId);
    if (record === undefined) throw new Error(`unknown external wait ${itemId}`);
    return record;
  }

  private replace(
    record: ExternalWaitRecord,
    disposition: ExternalWaitDisposition,
  ): ExternalWaitRecord {
    const next = { ...record, disposition };
    this.records.set(record.itemId, next);
    return next;
  }
}
