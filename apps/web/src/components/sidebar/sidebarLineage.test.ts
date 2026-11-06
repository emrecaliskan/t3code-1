import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarLineageForest,
  flattenSidebarLineage,
  resolveSidebarLineageRowKey,
  sidebarLineageTopKey,
  type SidebarLineageThread,
} from "./sidebarLineage";

const environmentId = EnvironmentId.make("env");

function thread(
  id: string,
  options: {
    readonly parent?: string;
    readonly relationship?: "subagent" | "fork";
    readonly root?: string;
    readonly sideChat?: boolean;
    readonly createdAt?: string;
    readonly live?: boolean;
  } = {},
): SidebarLineageThread {
  return {
    environmentId,
    id: ThreadId.make(id),
    createdAt: options.createdAt ?? "2026-01-01T00:00:00.000Z",
    lineage: {
      parentThreadId: options.parent === undefined ? null : ThreadId.make(options.parent),
      relationshipToParent:
        options.parent === undefined ? null : (options.relationship ?? "subagent"),
      rootThreadId: ThreadId.make(options.root ?? options.parent ?? id),
      ...(options.sideChat ? { sideChat: true } : {}),
    },
    source: {
      activityRunStatus: options.live ? "running" : null,
      status: "completed",
      pendingRuntimeRequest: null,
      pendingBackgroundTasks: [],
    },
  } as SidebarLineageThread;
}

const key = (id: string) => `${environmentId}:${id}`;

function tree(
  threads: ReadonlyArray<SidebarLineageThread>,
  options: {
    readonly candidates?: ReadonlyArray<SidebarLineageThread>;
    readonly expanded?: Record<string, boolean>;
    readonly idle?: ReadonlyArray<string>;
  } = {},
) {
  const candidates = options.candidates ?? threads;
  const forest = buildSidebarLineageForest({ candidates, threads });
  const roots = candidates.filter(
    (candidate) =>
      !forest.nested.has(key(candidate.id)) &&
      candidate.lineage.relationshipToParent !== "subagent",
  );
  const rows = flattenSidebarLineage({
    roots,
    forest,
    expandedByKey: options.expanded ?? {},
    idleParentKeys: new Set((options.idle ?? []).map(key)),
  });
  return {
    forest,
    rows,
    shape: rows.map((row) => `${"  ".repeat(row.depth)}${row.thread.id}`),
  };
}

describe("buildSidebarLineageForest", () => {
  it("nests subagents and forks recursively in launch order", () => {
    const threads = [
      thread("root"),
      thread("late", { parent: "root", createdAt: "2026-01-03T00:00:00.000Z" }),
      thread("early", { parent: "root", createdAt: "2026-01-02T00:00:00.000Z" }),
      thread("fork", {
        parent: "root",
        relationship: "fork",
        createdAt: "2026-01-04T00:00:00.000Z",
      }),
      thread("grandchild", { parent: "early", root: "root" }),
      thread("great", { parent: "grandchild", root: "root" }),
      thread("fork-worker", { parent: "fork", root: "root" }),
    ];
    const allOpen = Object.fromEntries(threads.map((entry) => [key(entry.id), true]));
    expect(tree(threads, { expanded: allOpen }).shape).toEqual([
      "root",
      "  early",
      "    grandchild",
      "      great",
      "  late",
      "  fork",
      "    fork-worker",
    ]);
  });

  it("promotes a fork whose parent cannot render and hides such a subagent", () => {
    const threads = [
      thread("fork", { parent: "gone", relationship: "fork", root: "gone" }),
      thread("orphan", { parent: "gone", root: "gone" }),
      thread("fork-worker", { parent: "fork", root: "gone" }),
    ];
    expect(tree(threads, { expanded: { [key("fork")]: true } }).shape).toEqual([
      "fork",
      "  fork-worker",
    ]);
  });

  it("attaches past ancestors that cannot render", () => {
    const archivedMiddle = thread("middle", { parent: "root" });
    const threads = [
      thread("root"),
      archivedMiddle,
      thread("under-archived", { parent: "middle", root: "root" }),
      thread("under-missing", { parent: "missing", root: "root" }),
      thread("side-chat", { parent: "root", relationship: "fork", sideChat: true }),
      thread("under-side-chat", { parent: "side-chat", root: "root" }),
    ];
    const candidates = threads.filter(
      (entry) => entry !== archivedMiddle && entry.lineage.sideChat !== true,
    );
    expect(tree(threads, { candidates, expanded: { [key("root")]: true } }).shape).toEqual([
      "root",
      "  under-archived",
      "  under-missing",
      "  under-side-chat",
    ]);
  });

  it("renders each thread of a lineage cycle once", () => {
    const threads = [
      thread("a", { parent: "b", relationship: "fork" }),
      thread("b", { parent: "a", relationship: "fork" }),
      thread("self", { parent: "self", relationship: "fork" }),
      thread("sub-a", { parent: "sub-b" }),
      thread("sub-b", { parent: "sub-a" }),
    ];
    const { shape } = tree(threads, { expanded: { [key("b")]: true, [key("a")]: true } });
    expect(shape.toSorted()).toEqual(["  a", "b", "self"]);
  });
});

describe("flattenSidebarLineage", () => {
  it("opens parents with live descendants until the user toggles them", () => {
    const threads = [
      thread("idle-root"),
      thread("idle-child", { parent: "idle-root" }),
      thread("live-root"),
      thread("middle", { parent: "live-root" }),
      thread("live-grandchild", { parent: "middle", root: "live-root", live: true }),
    ];
    expect(tree(threads).shape).toEqual([
      "idle-root",
      "live-root",
      "  middle",
      "    live-grandchild",
    ]);
    expect(
      tree(threads, { expanded: { [key("live-root")]: false, [key("idle-root")]: true } }).shape,
    ).toEqual(["idle-root", "  idle-child", "live-root"]);
  });

  it("marks parents expandable from known children or omitted idle ones", () => {
    const { rows } = tree(
      [thread("parent"), thread("child", { parent: "parent" }), thread("lone"), thread("idle")],
      {
        idle: ["idle"],
      },
    );
    expect(rows.map((row) => [row.thread.id, row.expandable, row.expanded])).toEqual([
      ["parent", true, false],
      ["lone", false, false],
      ["idle", true, false],
    ]);
  });

  it("draws guides that continue past every child but the last", () => {
    const threads = [
      thread("root"),
      thread("first", { parent: "root", createdAt: "2026-01-02T00:00:00.000Z" }),
      thread("nested", { parent: "first", root: "root" }),
      thread("last", { parent: "root", createdAt: "2026-01-03T00:00:00.000Z" }),
    ];
    const allOpen = Object.fromEntries(threads.map((entry) => [key(entry.id), true]));
    expect(
      tree(threads, { expanded: allOpen }).rows.map((row) => [
        row.thread.id,
        row.parentKey,
        row.guides,
      ]),
    ).toEqual([
      ["root", null, []],
      ["first", key("root"), [true]],
      ["nested", key("first"), [true, false]],
      ["last", key("root"), [false]],
    ]);
  });
});

describe("resolveSidebarLineageRowKey", () => {
  it("stands an open thread in for itself, else for its nearest rendered ancestor", () => {
    const threads = [
      thread("root"),
      thread("child", { parent: "root" }),
      thread("grandchild", { parent: "child", root: "root" }),
    ];
    const { forest, rows } = tree(threads, { expanded: { [key("root")]: true } });
    const rendered = new Set(rows.map((row) => row.key));
    expect(resolveSidebarLineageRowKey(key("child"), forest, rendered)).toBe(key("child"));
    expect(resolveSidebarLineageRowKey(key("grandchild"), forest, rendered)).toBe(key("child"));
    expect(resolveSidebarLineageRowKey(key("elsewhere"), forest, rendered)).toBeNull();
    expect(sidebarLineageTopKey(key("grandchild"), forest)).toBe(key("root"));
  });
});
