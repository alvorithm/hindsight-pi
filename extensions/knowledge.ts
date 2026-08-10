import { apiGet } from "./client.js";

// Response shapes as the server's OpenAPI declares them (KnowledgeTreeResponse,
// KnowledgePageSearchResponse, KnowledgePageResponse). The API is versioned and
// these are its documented fields, so each fetch asserts its named type once
// rather than re-guarding every field.

interface KnowledgeTreeNode {
  id: string;
  kind: "folder" | "page";
  name?: string;
  description?: string | null;
  tags?: string[];
  is_stale?: boolean;
  children?: KnowledgeTreeNode[];
}

interface KnowledgeTreeResponse {
  roots?: KnowledgeTreeNode[];
}

interface KnowledgePageSearchResponse {
  results?: Array<{ id: string; name?: string; snippet?: string; score?: number }>;
  total?: number;
}

interface KnowledgePageResponse {
  id: string;
  name?: string;
  description?: string | null;
  tags?: string[];
  timestamp?: string | null;
  body?: string;
  markdown?: string;
}

/** A page as the knowledge-base tree describes it, with its folder path resolved. */
export interface PageNode {
  id: string;
  name: string;
  path: string;
  description: string | null;
  tags: string[];
  stale: boolean;
}

/** One hit from hybrid page search, annotated from the tree where the id is known. */
export interface PageHit {
  id: string;
  name: string;
  snippet: string;
  score: number;
  path: string | null;
  tags: string[];
}

export interface PageDocument {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  timestamp: string | null;
  body: string;
  markdown: string;
}

const kbPath = (bankId: string, suffix: string): string =>
  `/v1/default/banks/${encodeURIComponent(bankId)}/knowledge-base${suffix}`;

const collectPages = (nodes: KnowledgeTreeNode[], prefix: string, out: PageNode[]): void => {
  for (const node of nodes) {
    if (!node?.id) continue;
    const name = node.name ?? node.id;
    if (node.kind === "page") {
      out.push({
        id: node.id,
        name,
        path: prefix,
        description: node.description ?? null,
        tags: node.tags ?? [],
        stale: node.is_stale === true,
      });
      continue;
    }
    collectPages(node.children ?? [], prefix ? `${prefix}/${name}` : name, out);
  }
};

/** Flatten a `GET /knowledge-base/tree` response into pages carrying folder paths. */
export const treePages = (tree: KnowledgeTreeResponse | null): PageNode[] => {
  const pages: PageNode[] = [];
  collectPages(tree?.roots ?? [], "", pages);
  return pages;
};

/**
 * A page is in scope when it carries no tags at all (a global, the convention
 * recall already uses for untagged memory) or shares a tag with the session's
 * scope. An empty scope means everything.
 */
export const pageInScope = (pageTags: string[], scopeTags: string[]): boolean =>
  scopeTags.length === 0 || pageTags.length === 0 || pageTags.some((tag) => scopeTags.includes(tag));

export const listPages = async (baseUrl: string, apiKey: string | undefined, bankId: string): Promise<PageNode[]> => {
  const tree = (await apiGet(baseUrl, apiKey, kbPath(bankId, "/tree"))) as KnowledgeTreeResponse | null;
  return treePages(tree);
};

/** Hybrid (BM25 + vector) search over whole pages. Hits carry no tags of their own. */
export const searchPages = async (
  baseUrl: string,
  apiKey: string | undefined,
  bankId: string,
  query: string,
  limit: number,
): Promise<PageHit[]> => {
  const path = kbPath(bankId, `/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  const response = (await apiGet(baseUrl, apiKey, path)) as KnowledgePageSearchResponse | null;
  return (response?.results ?? [])
    .filter((result) => Boolean(result?.id))
    .map((result) => ({
      id: result.id,
      name: result.name ?? result.id,
      snippet: result.snippet ?? "",
      score: result.score ?? 0,
      path: null,
      tags: [],
    }));
};

/**
 * Annotate search hits with the folder path and tags the tree knows, then drop
 * the ones outside the scope. Search itself has no tag filter, so scoping is
 * this join.
 */
export const scopeHits = (hits: PageHit[], pages: PageNode[], scopeTags: string[]): { hits: PageHit[]; dropped: number } => {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const annotated = hits.map((hit) => {
    const page = byId.get(hit.id);
    return page ? { ...hit, path: page.path, tags: page.tags } : hit;
  });
  const kept = annotated.filter((hit) => pageInScope(hit.tags, scopeTags));
  return { hits: kept, dropped: annotated.length - kept.length };
};

/** Search, annotate each hit from the tree, and drop what falls outside the scope. */
export const searchPagesInScope = async (
  baseUrl: string,
  apiKey: string | undefined,
  bankId: string,
  query: string,
  limit: number,
  scopeTags: string[],
): Promise<{ hits: PageHit[]; dropped: number }> => {
  const [hits, pages] = await Promise.all([
    searchPages(baseUrl, apiKey, bankId, query, limit),
    listPages(baseUrl, apiKey, bankId),
  ]);
  return scopeHits(hits, pages, scopeTags);
};

export const readPage = async (
  baseUrl: string,
  apiKey: string | undefined,
  bankId: string,
  pageId: string,
): Promise<PageDocument | null> => {
  const path = kbPath(bankId, `/pages/${encodeURIComponent(pageId)}`);
  const page = (await apiGet(baseUrl, apiKey, path)) as KnowledgePageResponse | null;
  if (!page?.id) return null;
  return {
    id: page.id,
    name: page.name ?? page.id,
    description: page.description ?? null,
    tags: page.tags ?? [],
    timestamp: page.timestamp ?? null,
    body: page.body ?? "",
    markdown: page.markdown ?? "",
  };
};
