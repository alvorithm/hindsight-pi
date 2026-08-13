import { describe, expect, it } from "vitest";
import type { HindsightConfig } from "../extensions/config.js";
import { buildAutomaticMetadata, buildAutomaticTags, expandObservationScopes, expandTagPlaceholders, getProjectName } from "../extensions/retain/tags.js";

describe("retain tags and scopes", () => {
  const config = { constantTags: ["harness:pi"], projectName: "stable-project", observationScopes: [["{project}"], ["{cwd}"]] } as any;
  const ctx = { cwd: "/tmp/somewhere/project", sessionId: "s1", parentId: "p1" };

  it("expands project independent of cwd", () => {
    expect(getProjectName(config, ctx.cwd)).toBe("stable-project");
    expect(expandTagPlaceholders(["{project}", "user:me"], config, ctx)).toEqual(["project:stable-project", "user:me"]);
  });

  it("builds automatic retain tags without bookkeeping identifiers", () => {
    expect(buildAutomaticTags(config, ctx, "auto")).toEqual(["harness:pi", "project:stable-project"]);
  });

  it("carries bookkeeping identifiers as document metadata", () => {
    expect(buildAutomaticMetadata(ctx, "auto")).toEqual({
      session: "s1",
      parent: "p1",
      cwd: "/tmp/somewhere/project",
      basedir: "project",
      store_method: "auto",
    });
  });

  it("expands observation scopes at queue time", () => {
    const scopes = expandObservationScopes(config, ctx) as string[][];
    expect(scopes[0]).toEqual(["project:stable-project"]);
    expect(scopes[1][0]).toMatch(/cwd:.*\/tmp\/somewhere\/project$/);
  });
});

describe("project label folding", () => {
  // `projectName: undefined` is the case under test: no override, so the label is
  // derived from the directory. It is written out because the functions take a
  // `Pick<…, "projectName">` and an object with no property in common with it is
  // not assignable.
  const config = { constantTags: ["harness:pi"], projectName: undefined, observationScopes: [["{project}"]] } satisfies Pick<HindsightConfig, "constantTags" | "projectName" | "observationScopes">;

  it("folds the case of a derived label, so one directory is one scope", () => {
    expect(getProjectName(config, "/home/u/code/NLP-beta")).toBe("nlp-beta");
    expect(getProjectName(config, "/home/u/Ask/General")).toBe("general");
  });

  it("folds underscores, matching the curation adapter's fallback slug", () => {
    expect(getProjectName(config, "/home/u/code/My_Project")).toBe("my-project");
  });

  it("folds an explicit override too", () => {
    expect(getProjectName({ projectName: " Corne36_Layout " }, "/tmp/whatever")).toBe("corne36-layout");
  });

  it("folds the label everywhere it is written, tags and scopes alike", () => {
    const ctx = { cwd: "/home/u/code/NLP-beta", sessionId: "s1", parentId: "p1" };
    expect(buildAutomaticTags(config, ctx, "auto")).toEqual(["harness:pi", "project:nlp-beta"]);
    expect(expandTagPlaceholders(["{project}"], config, ctx)).toEqual(["project:nlp-beta"]);
    const scopes = expandObservationScopes(config, ctx);
    expect(Array.isArray(scopes) ? scopes[0] : scopes).toEqual(["project:nlp-beta"]);
    expect(buildAutomaticMetadata(ctx, "auto").basedir).toBe("NLP-beta");
  });
});
