import type { MessageId, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export const PULL_REQUEST_FOLLOWUP_RETRY_MS = 15 * 60_000;
export const PULL_REQUEST_FOLLOWUP_MAX_ATTEMPTS = 3;

export function canStartPullRequestFollowup(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerThreads" | "runtimeRequests"
  >,
  messageId: MessageId,
): boolean {
  const { thread } = projection;
  return (
    thread.pullRequests?.some(
      (link) =>
        link.followup?.status === "verification_pending" && link.followup.messageId === messageId,
    ) === true &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.settledAt === null &&
    thread.settledOverride !== "settled" &&
    thread.snoozedUntil == null &&
    thread.lineage.relationshipToParent !== "subagent" &&
    thread.lineage.sideChat !== true &&
    thread.delegatedFrom === undefined &&
    projection.providerThreads.find(
      (providerThread) => providerThread.id === thread.activeProviderThreadId,
    )?.goal?.status !== "paused" &&
    !projection.runtimeRequests.some((request) => request.status === "pending")
  );
}
