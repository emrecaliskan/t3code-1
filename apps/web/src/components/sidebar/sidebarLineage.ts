import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isListedThreadLineage, isLiveSubagentShell, type ThreadId } from "@t3tools/contracts";

export type SidebarLineageThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "lineage" | "createdAt"
> & {
  readonly source: Parameters<typeof isLiveSubagentShell>[0];
};

/** Which candidate rows render under which parent, by thread key. */
export interface SidebarLineageForest<T> {
  /** Rows that render under a parent, so sections leave them out. */
  readonly nested: ReadonlySet<string>;
  readonly parentByKey: ReadonlyMap<string, string>;
  /** In launch order. */
  readonly childrenByKey: ReadonlyMap<string, ReadonlyArray<T>>;
}

export interface SidebarLineageRow<T> {
  readonly thread: T;
  readonly key: string;
  readonly depth: number;
  readonly parentKey: string | null;
  /** Known children, or idle subagents the shell left out. */
  readonly expandable: boolean;
  readonly expanded: boolean;
  /**
   * One entry per level from 1 to `depth`: whether that level's guide line continues below this
   * row. The last entry is the row's own connector, false at its parent's last child.
   */
  readonly guides: ReadonlyArray<boolean>;
}

const keyOf = (thread: Pick<SidebarLineageThread, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/**
 * Nests each candidate under its nearest candidate ancestor that itself renders, walking stored
 * lineage through threads that cannot render. A subagent whose chain breaks falls back to its
 * root. Listed threads with no rendering ancestor stay top-level; subagents without one stay
 * hidden. A lineage cycle is cut where the walk meets it, so every listed thread renders once.
 */
export function buildSidebarLineageForest<T extends SidebarLineageThread>(input: {
  readonly candidates: ReadonlyArray<T>;
  readonly threads: ReadonlyArray<SidebarLineageThread>;
}): SidebarLineageForest<T> {
  const threadByKey = new Map(input.threads.map((thread) => [keyOf(thread), thread] as const));
  const candidateByKey = new Map(
    input.candidates.map((thread) => [keyOf(thread), thread] as const),
  );

  const nearestCandidateAncestor = (thread: T): string | undefined => {
    const refKey = (id: ThreadId) => keyOf({ environmentId: thread.environmentId, id });
    const visited = new Set([keyOf(thread)]);
    let current: SidebarLineageThread = thread;
    while (current.lineage.parentThreadId !== null) {
      const parentKey = refKey(current.lineage.parentThreadId);
      if (visited.has(parentKey)) return undefined;
      if (candidateByKey.has(parentKey)) return parentKey;
      visited.add(parentKey);
      const parent = threadByKey.get(parentKey);
      if (parent === undefined) {
        const rootKey = refKey(thread.lineage.rootThreadId);
        return thread.lineage.relationshipToParent === "subagent" &&
          !visited.has(rootKey) &&
          candidateByKey.has(rootKey)
          ? rootKey
          : undefined;
      }
      current = parent;
    }
    return undefined;
  };

  const parentByKey = new Map<string, string>();
  for (const [key, thread] of candidateByKey) {
    const parentKey = nearestCandidateAncestor(thread);
    if (parentKey !== undefined) parentByKey.set(key, parentKey);
  }

  // A row renders when it is listed with no parent or its parent renders. A listed row whose
  // parent cannot render, including one met again around a cycle, is cut loose to the top level.
  const renders = new Map<string, boolean | "visiting">();
  const resolve = (key: string): boolean => {
    const known = renders.get(key);
    if (known === "visiting") return false;
    if (known !== undefined) return known;
    renders.set(key, "visiting");
    const parentKey = parentByKey.get(key);
    let rendered: boolean;
    if (parentKey !== undefined && resolve(parentKey)) {
      rendered = true;
    } else {
      parentByKey.delete(key);
      rendered = isListedThreadLineage(candidateByKey.get(key)!.lineage);
    }
    renders.set(key, rendered);
    return rendered;
  };

  const children = new Map<string, T[]>();
  for (const [key, thread] of candidateByKey) {
    if (!resolve(key)) continue;
    const parentKey = parentByKey.get(key);
    if (parentKey === undefined) continue;
    const siblings = children.get(parentKey);
    if (siblings === undefined) children.set(parentKey, [thread]);
    else siblings.push(thread);
  }
  for (const siblings of children.values()) {
    siblings.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  }
  return { nested: new Set(parentByKey.keys()), parentByKey, childrenByKey: children };
}

/**
 * The visible rows under `roots`, in order. A parent the user never toggled starts open while any
 * descendant is live.
 */
export function flattenSidebarLineage<T extends SidebarLineageThread>(input: {
  readonly roots: ReadonlyArray<T>;
  readonly forest: SidebarLineageForest<T>;
  readonly expandedByKey: Readonly<Record<string, boolean>>;
  /** Parents whose idle subagent children are not loaded. */
  readonly idleParentKeys: ReadonlySet<string>;
}): SidebarLineageRow<T>[] {
  const { forest, expandedByKey, idleParentKeys } = input;
  const liveBelow = new Map<string, boolean>();
  const hasLiveDescendant = (key: string): boolean => {
    const known = liveBelow.get(key);
    if (known !== undefined) return known;
    const live = (forest.childrenByKey.get(key) ?? []).some(
      (child) => isLiveSubagentShell(child.source) || hasLiveDescendant(keyOf(child)),
    );
    liveBelow.set(key, live);
    return live;
  };

  const rows: SidebarLineageRow<T>[] = [];
  const visit = (thread: T, parentKey: string | null, guides: ReadonlyArray<boolean>): void => {
    const key = keyOf(thread);
    const children = forest.childrenByKey.get(key) ?? [];
    const expandable = children.length > 0 || idleParentKeys.has(key);
    const expanded = expandable && (expandedByKey[key] ?? hasLiveDescendant(key));
    rows.push({ thread, key, depth: guides.length, parentKey, expandable, expanded, guides });
    if (!expanded) return;
    children.forEach((child, index) => visit(child, key, [...guides, index < children.length - 1]));
  };
  for (const root of input.roots) visit(root, null, []);
  return rows;
}

/** The row that stands for `key`: itself when rendered, else its nearest rendered ancestor. */
export function resolveSidebarLineageRowKey(
  key: string,
  forest: Pick<SidebarLineageForest<unknown>, "parentByKey">,
  renderedKeys: Pick<ReadonlySet<string>, "has">,
): string | null {
  const visited = new Set<string>();
  let current: string | undefined = key;
  while (current !== undefined && !visited.has(current)) {
    if (renderedKeys.has(current)) return current;
    visited.add(current);
    current = forest.parentByKey.get(current);
  }
  return null;
}

/** The top-level row a nested row sits under, or `key` itself. */
export function sidebarLineageTopKey(
  key: string,
  forest: Pick<SidebarLineageForest<unknown>, "parentByKey">,
): string {
  const visited = new Set<string>();
  let current = key;
  while (!visited.has(current)) {
    visited.add(current);
    const parentKey = forest.parentByKey.get(current);
    if (parentKey === undefined) return current;
    current = parentKey;
  }
  return current;
}
