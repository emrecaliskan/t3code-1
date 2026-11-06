import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarLineageForest,
  flattenSidebarLineage,
  resolveSidebarLineageRowKey,
  sidebarLineageDescendants,
  sidebarLineageRowTitle,
  sidebarLineageTopKey,
  sidebarSettledGroupKey,
  type SidebarLineageRow,
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
const label = (row: SidebarLineageRow<SidebarLineageThread>) =>
  row.kind === "thread" ? row.thread.id : `${row.count} settled`;

function tree(
  threads: ReadonlyArray<SidebarLineageThread>,
  options: {
    readonly candidates?: ReadonlyArray<SidebarLineageThread>;
    readonly expanded?: Record<string, boolean>;
    readonly idle?: ReadonlyArray<string>;
    readonly settled?: ReadonlyArray<string>;
    readonly route?: string;
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
    unloadedParentKeys: new Set((options.idle ?? []).map(key)),
    isSettled: (candidate) => options.settled?.includes(candidate.id) ?? false,
    routeKey: options.route === undefined ? null : key(options.route),
  });
  return {
    forest,
    rows,
    shape: rows.map((row) => `${"  ".repeat(row.depth)}${label(row)}`),
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

  it("nests a fork only under a placed parent in its own section", () => {
    const threads = [
      thread("parent"),
      thread("fork", { parent: "parent", relationship: "fork" }),
      thread("worker", { parent: "parent" }),
      thread("fork-worker", { parent: "fork", root: "parent" }),
    ];
    const nestedWith = (
      placed: ReadonlyArray<string>,
      sections: Readonly<Record<string, string>>,
    ) =>
      [
        ...buildSidebarLineageForest({
          candidates: threads,
          threads,
          placement: {
            placed: new Set(placed.map(key)),
            sectionOf: new Map(Object.entries(sections).map(([id, section]) => [key(id), section])),
          },
        }).nested,
      ].toSorted();
    expect(nestedWith(["fork"], { parent: "settled", fork: "active" })).toEqual([
      key("fork-worker"),
    ]);
    expect(nestedWith(["parent", "fork"], { parent: "settled", fork: "active" })).toEqual([
      key("fork-worker"),
      key("worker"),
    ]);
    expect(nestedWith(["parent", "fork"], { parent: "active", fork: "active" })).toEqual([
      key("fork"),
      key("fork-worker"),
      key("worker"),
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

describe("sidebarLineageDescendants", () => {
  const nested = tree([
    thread("root"),
    thread("child", { parent: "root" }),
    thread("grandchild", { parent: "child", root: "root" }),
    thread("sibling", { parent: "root", createdAt: "2026-01-02T00:00:00.000Z" }),
  ]).forest;
  const a = thread("a", { parent: "b", relationship: "fork" });
  const b = thread("b", { parent: "a", relationship: "fork" });
  const cycle = {
    childrenByKey: new Map([
      [key("a"), [b]],
      [key("b"), [a]],
    ]),
  };
  it.each([
    ["every level below a parent", nested, "root", ["child", "grandchild", "sibling"]],
    ["nothing below a leaf", nested, "grandchild", []],
    ["each thread of a cycle once, never the parent itself", cycle, "a", ["b"]],
  ])("collects %s", (_case, forest, parent, expected) => {
    expect(sidebarLineageDescendants(key(parent), forest).map((entry) => entry.id)).toEqual(
      expected,
    );
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
    expect(
      rows.map((row) => [label(row), row.kind === "thread" && row.expandable, row.expanded]),
    ).toEqual([
      ["parent", true, false],
      ["lone", false, false],
      ["idle", true, false],
    ]);
  });

  it("draws guides that continue past every child but the last, the settled group", () => {
    const threads = [
      thread("root"),
      thread("first", { parent: "root", createdAt: "2026-01-02T00:00:00.000Z" }),
      thread("nested", { parent: "first", root: "root" }),
      thread("last", { parent: "root", createdAt: "2026-01-03T00:00:00.000Z" }),
      thread("done", { parent: "root", createdAt: "2026-01-04T00:00:00.000Z" }),
    ];
    const allOpen = Object.fromEntries(
      [...threads.map((entry) => key(entry.id)), sidebarSettledGroupKey(key("root"))].map(
        (rowKey) => [rowKey, true],
      ),
    );
    expect(
      tree(threads, { expanded: allOpen, settled: ["done"] }).rows.map((row) => [
        label(row),
        row.parentKey,
        row.guides,
      ]),
    ).toEqual([
      ["root", null, []],
      ["first", key("root"), [true]],
      ["nested", key("first"), [true, false]],
      ["last", key("root"), [true]],
      ["1 settled", key("root"), [false]],
      ["done", sidebarSettledGroupKey(key("root")), [false, false]],
    ]);
  });

  it("folds settled children into one closed group after the others", () => {
    const threads = [
      thread("root"),
      thread("early", { parent: "root", createdAt: "2026-01-02T00:00:00.000Z" }),
      thread("open", { parent: "root", createdAt: "2026-01-03T00:00:00.000Z" }),
      thread("late", { parent: "root", createdAt: "2026-01-04T00:00:00.000Z" }),
      thread("late-worker", { parent: "late", root: "root" }),
    ];
    const expanded = { [key("root")]: true, [key("late")]: true };
    expect(tree(threads, { expanded }).shape).toEqual([
      "root",
      "  early",
      "  open",
      "  late",
      "    late-worker",
    ]);
    const settled = ["early", "late"];
    expect(tree(threads, { expanded, settled }).shape).toEqual(["root", "  open", "  2 settled"]);
    expect(
      tree(threads, {
        expanded: { ...expanded, [sidebarSettledGroupKey(key("root"))]: true },
        settled,
      }).shape,
    ).toEqual(["root", "  open", "  2 settled", "    early", "    late", "      late-worker"]);
  });

  it("keeps the open thread's line and settled work with a live descendant unfolded", () => {
    const threads = [
      thread("root"),
      thread("done", { parent: "root", createdAt: "2026-01-02T00:00:00.000Z" }),
      thread("waiting", { parent: "root", createdAt: "2026-01-03T00:00:00.000Z" }),
      thread("running", { parent: "waiting", root: "root", live: true }),
      thread("viewed", { parent: "root", createdAt: "2026-01-04T00:00:00.000Z" }),
      thread("route", { parent: "viewed", root: "root" }),
    ];
    expect(
      tree(threads, {
        expanded: { [key("viewed")]: true },
        settled: ["done", "waiting", "viewed", "route"],
        route: "route",
      }).shape,
    ).toEqual(["root", "  waiting", "    running", "  viewed", "    route", "  1 settled"]);
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

describe("sidebarLineageRowTitle", () => {
  it.each([
    [
      "🐝 deploy-prod-decide: psql schema check in decide",
      "🦫 deploy-prod-decide lead",
      "🐝 psql schema check in decide",
    ],
    ["deploy-prod-decide: review PR 9761", "deploy-prod-decide", "review PR 9761"],
    ["🦅 Deploy-Prod: review", "🦫 deploy-prod lead", "🦅 review"],
    [
      "Async calls: S1c chat helpers",
      "Operation concept overhaul",
      "Async calls: S1c chat helpers",
    ],
    ["🐝 deploy-prod: check", "🦫 deploy-production lead", "🐝 deploy-prod: check"],
    ["🐝 deploy-prod check", "🦫 deploy-prod lead", "🐝 deploy-prod check"],
    ["🐝 deploy-prod:check", "🦫 deploy-prod lead", "🐝 deploy-prod:check"],
    ["🐝 deploy-prod:   ", "🦫 deploy-prod lead", "🐝 deploy-prod:   "],
  ])("shows %j under %j as %j", (title, parentTitle, expected) => {
    expect(sidebarLineageRowTitle(title, parentTitle)).toBe(expected);
  });
});
