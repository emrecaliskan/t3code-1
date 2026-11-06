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

/** A visible row under the sidebar's top-level threads, in render order. */
export type SidebarLineageRow<T> = SidebarLineageThreadRow<T> | SidebarLineageFinishedGroupRow;

interface SidebarLineageRowPlacement {
  readonly key: string;
  readonly depth: number;
  /**
   * One entry per level from 1 to `depth`: whether that level's guide line continues below this
   * row. The last entry is the row's own connector, false at its parent's last child.
   */
  readonly guides: ReadonlyArray<boolean>;
}

export interface SidebarLineageThreadRow<T> extends SidebarLineageRowPlacement {
  readonly kind: "thread";
  readonly thread: T;
  /** The row this one sits under: its parent thread, or the finished group that holds it. */
  readonly parentKey: string | null;
  /** Known children, or idle subagents the shell left out. */
  readonly expandable: boolean;
  readonly expanded: boolean;
}

/** The last row under a parent, holding its finished children. */
export interface SidebarLineageFinishedGroupRow extends SidebarLineageRowPlacement {
  readonly kind: "finishedGroup";
  readonly parentKey: string;
  readonly count: number;
  readonly expanded: boolean;
}

/** The finished group's row key, which also keys its open state. */
export const sidebarFinishedGroupKey = (parentKey: string) => `${parentKey}:finished`;

const keyOf = (thread: Pick<SidebarLineageThread, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/**
 * Nests each candidate under its nearest rendering ancestor by stored lineage; a subagent whose
 * chain breaks falls back to its root, and a thread with its own section nests only within it.
 * Otherwise a thread is top-level when placed (by default, when listed). Cycles are cut where met.
 */
export function buildSidebarLineageForest<T extends SidebarLineageThread>(input: {
  readonly candidates: ReadonlyArray<T>;
  readonly threads: ReadonlyArray<SidebarLineageThread>;
  readonly placement?: {
    /** Rows the sidebar places top-level; a parent outside them cannot hold children. */
    readonly placed: ReadonlySet<string>;
    readonly sectionOf: ReadonlyMap<string, string>;
  };
}): SidebarLineageForest<T> {
  const { placement } = input;
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

  // A row renders when its parent renders or it is top-level. A row whose parent cannot render,
  // including one met again around a cycle, is cut loose to the top level.
  const renders = new Map<string, boolean | "visiting">();
  const rowSection = new Map<string, string | undefined>();
  const resolve = (key: string): boolean => {
    const known = renders.get(key);
    if (known === "visiting") return false;
    if (known !== undefined) return known;
    renders.set(key, "visiting");
    const parentKey = parentByKey.get(key);
    const ownSection = placement?.sectionOf.get(key);
    let rendered: boolean;
    if (
      parentKey !== undefined &&
      resolve(parentKey) &&
      (ownSection === undefined || ownSection === rowSection.get(parentKey))
    ) {
      rendered = true;
      rowSection.set(key, rowSection.get(parentKey));
    } else {
      parentByKey.delete(key);
      rowSection.set(key, ownSection);
      rendered =
        placement === undefined
          ? isListedThreadLineage(candidateByKey.get(key)!.lineage)
          : placement.placed.has(key);
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

/** Every thread below `key` in the forest, each once, depth first. Cycles are cut where met. */
export function sidebarLineageDescendants<T extends SidebarLineageThread>(
  key: string,
  forest: Pick<SidebarLineageForest<T>, "childrenByKey">,
): T[] {
  const visited = new Set([key]);
  const descendants: T[] = [];
  const visit = (parentKey: string): void => {
    for (const child of forest.childrenByKey.get(parentKey) ?? []) {
      const childKey = keyOf(child);
      if (visited.has(childKey)) continue;
      visited.add(childKey);
      descendants.push(child);
      visit(childKey);
    }
  };
  visit(key);
  return descendants;
}

/**
 * The visible rows under `roots`, in order. A parent the user never toggled starts open while any
 * descendant is live. Finished children fold into one closed group after the others, except one on
 * the way to `routeKey` or with a live descendant.
 */
export function flattenSidebarLineage<T extends SidebarLineageThread>(input: {
  readonly roots: ReadonlyArray<T>;
  readonly forest: SidebarLineageForest<T>;
  readonly expandedByKey: Readonly<Record<string, boolean>>;
  /** Parents with children the shell left out, which load when the parent opens. */
  readonly unloadedParentKeys: ReadonlySet<string>;
  readonly isFinished: (thread: T) => boolean;
  /** The open thread's row key. */
  readonly routeKey: string | null;
}): SidebarLineageRow<T>[] {
  const { forest, expandedByKey, unloadedParentKeys, isFinished } = input;
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
  const onRoute = new Set<string>();
  for (
    let key = input.routeKey ?? undefined;
    key !== undefined && !onRoute.has(key);
    key = forest.parentByKey.get(key)
  ) {
    onRoute.add(key);
  }
  const folds = (child: T) => {
    const key = keyOf(child);
    return (
      isFinished(child) &&
      !onRoute.has(key) &&
      !isLiveSubagentShell(child.source) &&
      !hasLiveDescendant(key)
    );
  };

  const rows: SidebarLineageRow<T>[] = [];
  const visit = (thread: T, parentKey: string | null, guides: ReadonlyArray<boolean>): void => {
    const key = keyOf(thread);
    const children = forest.childrenByKey.get(key) ?? [];
    const expandable = children.length > 0 || unloadedParentKeys.has(key);
    const expanded = expandable && (expandedByKey[key] ?? hasLiveDescendant(key));
    rows.push({
      kind: "thread",
      thread,
      key,
      depth: guides.length,
      parentKey,
      expandable,
      expanded,
      guides,
    });
    if (!expanded) return;
    const open: T[] = [];
    const finished: T[] = [];
    for (const child of children) (folds(child) ? finished : open).push(child);
    open.forEach((child, index) =>
      visit(child, key, [...guides, finished.length > 0 || index < open.length - 1]),
    );
    if (finished.length === 0) return;
    const groupKey = sidebarFinishedGroupKey(key);
    const groupGuides = [...guides, false];
    const groupExpanded = expandedByKey[groupKey] ?? false;
    rows.push({
      kind: "finishedGroup",
      key: groupKey,
      depth: groupGuides.length,
      parentKey: key,
      count: finished.length,
      expanded: groupExpanded,
      guides: groupGuides,
    });
    if (!groupExpanded) return;
    finished.forEach((child, index) =>
      visit(child, groupKey, [...groupGuides, index < finished.length - 1]),
    );
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

const LEADING_SYMBOLS = /^[^\p{L}\p{N}]*/u;
const PREFIXED_TITLE = /^([^:]+):\s+(\S[\s\S]*)$/u;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * A nested row's title without a `<prefix>: ` lead that repeats its parent's title, keeping the
 * row's leading symbols. Any other title comes back unchanged.
 */
export function sidebarLineageRowTitle(title: string, parentTitle: string): string {
  const symbols = LEADING_SYMBOLS.exec(title)![0];
  const match = PREFIXED_TITLE.exec(title.slice(symbols.length));
  if (match === null) return title;
  const [, prefix = "", remainder = ""] = match;
  const parentRest = parentTitle.slice(LEADING_SYMBOLS.exec(parentTitle)![0].length);
  if (parentRest.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return title;
  const next = parentRest.charAt(prefix.length);
  return next === "" || !WORD_CHAR.test(next) ? symbols + remainder : title;
}
