import { basename, resolve } from "node:path";
import type { HindsightConfig } from "../config.js";

export interface ScopeContext {
  sessionId?: string;
  parentId?: string;
  cwd: string;
  projectName?: string;
}

const cleanPath = (cwd: string): string => resolve(cwd).replace(/\\/g, "/");
export const getBasedir = (cwd: string): string => basename(cleanPath(cwd));
export const getProjectName = (config: Pick<HindsightConfig, "projectName">, cwd: string): string => config.projectName?.trim() || getBasedir(cwd);

export const placeholderValues = (config: Pick<HindsightConfig, "projectName">, ctx: ScopeContext): Record<string, string> => {
  const cwd = cleanPath(ctx.cwd);
  const session = ctx.sessionId || "unknown";
  const parent = ctx.parentId || session;
  const basedir = getBasedir(cwd);
  const project = config.projectName?.trim() || basedir;
  return {
    "{session}": `session:${session}`,
    "{parent}": `parent:${parent}`,
    "{cwd}": `cwd:${cwd}`,
    "{basedir}": `basedir:${basedir}`,
    "{project}": `project:${project}`,
  };
};

export const expandTagPlaceholders = (tags: string[] | null | undefined, config: Pick<HindsightConfig, "projectName">, ctx: ScopeContext): string[] | undefined => {
  if (!tags) return undefined;
  const values = placeholderValues(config, ctx);
  return [...new Set(tags.map((tag) => values[tag] ?? tag).filter(Boolean))];
};

export const buildAutomaticTags = (config: Pick<HindsightConfig, "constantTags" | "projectName">, ctx: ScopeContext, _storeMethod: "auto" | "tool"): string[] => {
  // Bookkeeping identifiers (session, parent, cwd, basedir, store_method) belong
  // in document metadata, not in tags: every retain carried a session-unique tag
  // set, so each session landed in its own observation scope and consolidation
  // could no longer deduplicate across sessions. Tags stay audience-scoped:
  // constantTags plus project:. Metadata keeps the identifiers for audit.
  const cwd = cleanPath(ctx.cwd);
  return [...new Set([
    ...config.constantTags,
    `project:${getProjectName(config, cwd)}`,
  ])];
};

export const buildAutomaticMetadata = (ctx: ScopeContext, storeMethod: "auto" | "tool"): Record<string, string> => {
  const cwd = cleanPath(ctx.cwd);
  const session = ctx.sessionId || "unknown";
  const parent = ctx.parentId || session;
  return {
    session,
    parent,
    cwd,
    basedir: getBasedir(cwd),
    store_method: storeMethod,
  };
};

export const expandObservationScopes = (config: Pick<HindsightConfig, "observationScopes" | "projectName">, ctx: ScopeContext): HindsightConfig["observationScopes"] => {
  const scopes = config.observationScopes;
  if (!Array.isArray(scopes)) return scopes;
  const values = placeholderValues(config, ctx);
  return scopes.map((group) => group.map((tag) => values[tag] ?? tag));
};
