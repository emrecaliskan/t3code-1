import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  PullRequestActor,
  PullRequestChecksState,
  PullRequestMergeability,
  PullRequestReviewDecision,
  PullRequestState,
} from "./pullRequest.ts";

export const ThreadLinkedPullRequest = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ThreadLinkedPullRequest = typeof ThreadLinkedPullRequest.Type;

/** stack-dismissed hides an unlinked native member and prevents sync from re-adding it. */
export const ThreadPullRequestLinkSource = Schema.Literals([
  "manual",
  "created",
  "agent",
  "stack",
  "stack-dismissed",
]);
export type ThreadPullRequestLinkSource = typeof ThreadPullRequestLinkSource.Type;

export const ThreadPullRequestSnapshot = Schema.Struct({
  state: PullRequestState,
  title: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  isDraft: Schema.Boolean,
  updatedAt: Schema.NullOr(IsoDateTime),
  syncedAt: IsoDateTime,
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergeSha: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  author: Schema.optional(Schema.NullOr(PullRequestActor)),
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  changedFiles: Schema.optional(NonNegativeInt),
  reviewDecision: Schema.optional(Schema.NullOr(PullRequestReviewDecision)),
  checksState: Schema.optional(Schema.NullOr(PullRequestChecksState)),
  mergeability: Schema.optional(PullRequestMergeability),
});
export type ThreadPullRequestSnapshot = typeof ThreadPullRequestSnapshot.Type;

export const ThreadPullRequestStackLayer = Schema.Struct({
  number: PositiveInt,
  headBranch: TrimmedNonEmptyString,
  state: PullRequestState,
});
export type ThreadPullRequestStackLayer = typeof ThreadPullRequestStackLayer.Type;

/** Layers run bottom to top. */
export const ThreadPullRequestStack = Schema.Struct({
  kind: Schema.Literal("native"),
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  base: TrimmedNonEmptyString,
  layers: Schema.Array(ThreadPullRequestStackLayer),
});
export type ThreadPullRequestStack = typeof ThreadPullRequestStack.Type;

export const ThreadPullRequestKey = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ThreadPullRequestKey = typeof ThreadPullRequestKey.Type;

export const ThreadPullRequestWatch = Schema.Struct({
  startedAt: IsoDateTime,
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  failedChecks: Schema.Array(TrimmedNonEmptyString),
  passed: Schema.Boolean,
  passedChecks: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Checks still pending when required ones passed early, owed one wake once all settle. */
  owedChecks: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  remarksThrough: IsoDateTime,
  /** Reported remarks at remarksThrough, so late arrivals at that timestamp still count. */
  remarkIds: Schema.Array(TrimmedNonEmptyString),
  conflicting: Schema.Boolean,
  /** Consecutive comment-only wakes; limited to prevent bot loops. */
  wakes: NonNegativeInt,
  /**
   * When the head was first read without any check, until a check shows up or the agent is told
   * none did. Null once either happened; absent on watches saved before it existed.
   */
  checksAwaitedSince: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type ThreadPullRequestWatch = typeof ThreadPullRequestWatch.Type;

export const PullRequestFollowupTerminal = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("merged"),
    mergeSha: TrimmedNonEmptyString,
    base: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("closed"), base: TrimmedNonEmptyString }),
]);
export type PullRequestFollowupTerminal = typeof PullRequestFollowupTerminal.Type;

const FollowupIdentity = {
  generation: PositiveInt,
  reviewedHead: TrimmedNonEmptyString,
  intendedBase: TrimmedNonEmptyString,
};

export const ThreadPullRequestFollowup = Schema.Union([
  Schema.Struct({ ...FollowupIdentity, status: Schema.Literal("awaiting_terminal") }),
  Schema.Struct({
    ...FollowupIdentity,
    status: Schema.Literal("verification_pending"),
    terminal: PullRequestFollowupTerminal,
    messageId: MessageId,
    attempts: PositiveInt,
    lastAttemptAt: IsoDateTime,
  }),
  Schema.Struct({
    ...FollowupIdentity,
    status: Schema.Literal("held"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...FollowupIdentity,
    status: Schema.Literal("released"),
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...FollowupIdentity,
    status: Schema.Literal("acknowledged"),
    terminal: PullRequestFollowupTerminal,
    evidence: TrimmedNonEmptyString,
    acknowledgedAt: IsoDateTime,
  }),
]);
export type ThreadPullRequestFollowup = typeof ThreadPullRequestFollowup.Type;

export const PullRequestFollowupAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("register"),
    reviewedHead: TrimmedNonEmptyString,
    intendedBase: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literals(["hold", "release"]),
    generation: PositiveInt,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("acknowledge"),
    generation: PositiveInt,
    result: PullRequestFollowupTerminal,
    evidence: TrimmedNonEmptyString,
  }),
]);
export type PullRequestFollowupAction = typeof PullRequestFollowupAction.Type;

export function hasPendingPullRequestFollowup(link: {
  readonly followup?: ThreadPullRequestFollowup | undefined;
}): boolean {
  return (
    link.followup !== undefined &&
    link.followup.status !== "acknowledged" &&
    link.followup.status !== "released"
  );
}

export const ThreadPullRequestLink = Schema.Struct({
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  /** An actual browser or clone URL; older agent display URLs may be synthesized. */
  repositoryWebUrl: Schema.optional(TrimmedNonEmptyString),
  source: ThreadPullRequestLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadPullRequestSnapshot),
  stack: Schema.NullOr(ThreadPullRequestStack),
  watch: Schema.optional(ThreadPullRequestWatch),
  followup: Schema.optional(ThreadPullRequestFollowup),
  /** Resume from the ended watch to avoid duplicate notifications. */
  endedWatch: Schema.optional(ThreadPullRequestWatch),
});
export type ThreadPullRequestLink = typeof ThreadPullRequestLink.Type;
