import { describe, expect, it } from "vitest";
import { pageInScope, scopeHits, treePages, type PageHit, type PageNode } from "../extensions/knowledge.js";

const tree = {
  roots: [
    {
      id: "kf-1",
      kind: "folder" as const,
      name: "penpot",
      tags: [],
      children: [
        {
          id: "kp-1",
          kind: "page" as const,
          name: "Backend organization",
          description: "How is the backend organized?",
          tags: ["project:penpot"],
          is_stale: true,
          children: [],
        },
        {
          id: "kf-2",
          kind: "folder" as const,
          name: "Runbooks",
          children: [
            { id: "kp-2", kind: "page" as const, name: "Devenv", tags: ["project:penpot"], children: [] },
          ],
        },
      ],
    },
    { id: "kp-3", kind: "page" as const, name: "House style", tags: [], children: [] },
  ],
};

describe("knowledge-base tree", () => {
  it("flattens folders into page paths and keeps the stale flag", () => {
    expect(treePages(tree)).toEqual([
      {
        id: "kp-1",
        name: "Backend organization",
        path: "penpot",
        description: "How is the backend organized?",
        tags: ["project:penpot"],
        stale: true,
      },
      { id: "kp-2", name: "Devenv", path: "penpot/Runbooks", description: null, tags: ["project:penpot"], stale: false },
      { id: "kp-3", name: "House style", path: "", description: null, tags: [], stale: false },
    ]);
  });

  it("survives an empty or absent tree", () => {
    expect(treePages(null)).toEqual([]);
    expect(treePages({})).toEqual([]);
  });
});

describe("page scoping", () => {
  it("admits an untagged page as a global and rejects another project's page", () => {
    expect(pageInScope([], ["project:penpot"])).toBe(true);
    expect(pageInScope(["project:penpot"], ["project:penpot"])).toBe(true);
    expect(pageInScope(["project:beadpot"], ["project:penpot"])).toBe(false);
  });

  it("admits everything when the scope is empty", () => {
    expect(pageInScope(["project:beadpot"], [])).toBe(true);
  });
});

describe("scopeHits", () => {
  const pages: PageNode[] = treePages(tree);
  const hit = (id: string): PageHit => ({ id, name: id, snippet: "s", score: 1, path: null, tags: [] });

  it("annotates hits from the tree and drops out-of-scope ones", () => {
    const result = scopeHits([hit("kp-1"), hit("kp-3")], pages, ["project:beadpot"]);
    expect(result.hits.map((h) => h.id)).toEqual(["kp-3"]);
    expect(result.dropped).toBe(1);
    expect(result.hits[0].path).toBe("");
  });

  it("carries the folder path and tags onto a kept hit", () => {
    const result = scopeHits([hit("kp-2")], pages, ["project:penpot"]);
    expect(result.dropped).toBe(0);
    expect(result.hits[0]).toMatchObject({ path: "penpot/Runbooks", tags: ["project:penpot"] });
  });

  it("keeps a hit the tree does not know, rather than hiding it", () => {
    const result = scopeHits([hit("kp-unknown")], pages, ["project:penpot"]);
    expect(result.hits.map((h) => h.id)).toEqual(["kp-unknown"]);
  });
});
