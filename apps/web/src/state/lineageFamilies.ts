import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { threadFamilies } from "./threads";

/** Keeps each family in the thread lists while mounted, for children the shell left out. */
export function useMountedThreadFamilies(
  roots: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly threadId: ThreadId }>,
) {
  const rootsKey = [
    ...new Set(
      roots.map(({ environmentId, threadId }) => JSON.stringify([environmentId, threadId])),
    ),
  ]
    .toSorted()
    .join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the thread families of open sidebar parents into the family registry while shown
  useEffect(() => {
    const releases = (rootsKey === "" ? [] : rootsKey.split("\n")).map((root) => {
      const [environmentId, threadId] = JSON.parse(root) as [EnvironmentId, ThreadId];
      return threadFamilies.mount(appAtomRegistry, environmentId, threadId);
    });
    return () => {
      for (const release of releases) release();
    };
  }, [rootsKey]);
}
