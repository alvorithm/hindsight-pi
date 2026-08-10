import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ensureBank, getBankInsights, getHandles, type HindsightHandles } from "./client.js";
import { getRecallMode, type ReasoningLevel, type SearchBudget } from "./config.js";
import { sessionRetained } from "./meta.js";
import { listPages, pageInScope, readPage, searchPagesInScope } from "./knowledge.js";
import { expandTagPlaceholders, getProjectName } from "./retain/tags.js";

const sanitizeTag = (value: string): string => value.toLowerCase().replace(/[^a-z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

const LEVELS: readonly ReasoningLevel[] = ["low", "medium", "high"];
const LEVEL_TO_BUDGET: Record<ReasoningLevel, SearchBudget> = {
  low: "low",
  medium: "mid",
  high: "high",
};

const nextLevel = (level: ReasoningLevel): ReasoningLevel => {
  const idx = LEVELS.indexOf(level);
  return LEVELS[Math.min(idx + 1, LEVELS.length - 1)];
};

const dynamicBudget = (query: string, baseLevel: ReasoningLevel, dynamic: boolean, cap: ReasoningLevel | null): SearchBudget => {
  let level = baseLevel;
  if (dynamic) {
    if (query.length >= 120) level = nextLevel(level);
    if (query.length >= 400) level = nextLevel(level);
  }
  if (cap && LEVELS.indexOf(level) > LEVELS.indexOf(cap)) level = cap;
  return LEVEL_TO_BUDGET[level];
};

const activeBankIds = (handles: HindsightHandles): string[] => {
  const ids = [handles.bankId, handles.config.globalBankId].filter((value): value is string => Boolean(value));
  return [...new Set(ids)];
};

const ensureHandles = async () => {
  const handles = getHandles();
  if (!handles) throw new Error("Hindsight is not connected. Run /hindsight:setup first.");
  await ensureBank(handles.client, handles.bankId, handles.config);
  if (handles.config.globalBankId && handles.config.globalBankId !== handles.bankId) {
    await ensureBank(handles.client, handles.config.globalBankId, handles.config);
  }
  return handles;
};

const formatResults = (results: Array<{ text?: string; type?: string; sourceHost?: string }>, preview: number): string => {
  if (results.length === 0) return "No relevant memory found.";
  return results
    .map((entry, index) => `${index + 1}. [${entry.sourceHost ?? "pi"} | ${entry.type ?? "memory"}] ${(entry.text ?? "").slice(0, preview)}`)
    .join("\n\n");
};

const PAGE_SNIPPET_LIMIT = 240;

const compactSnippet = (value: string, limit: number): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

/**
 * The tags a page must share to count as in scope: whatever auto-recall is
 * configured to ask for, falling back to this session's project. Untagged
 * pages are always in scope, which `pageInScope` handles.
 */
const pageScopeTags = (handles: HindsightHandles, cwd: string): string[] => {
  const configured = expandTagPlaceholders(handles.config.autoRecallTags, handles.config, { cwd });
  if (configured && configured.length > 0) return configured;
  return [`project:${getProjectName(handles.config, cwd)}`];
};

const formatPageLine = (
  index: number,
  label: string,
  page: { id: string; name: string; path: string | null; stale?: boolean },
  detail: string,
): string => {
  const where = page.path ? `${page.path}/${page.name}` : page.name;
  const marks = page.stale ? `${page.id}, stale` : page.id;
  const head = `${index}. [${label}] ${where} (${marks})`;
  return detail ? `${head}\n   ${detail}` : head;
};

export const registerTools = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: "hindsight_search",
    label: "Hindsight Search",
    description: "Search raw durable memory from Hindsight using recall.",
    promptSnippet: "Search raw durable memory in Hindsight.",
    promptGuidelines: ["Use this tool for past facts, user preferences, project history, or architecture details when raw evidence is best."],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      budget: Type.Optional(Type.String({ description: "Recall budget: low, mid, or high" })),
    }),
    async execute(_toolCallId: string, params: any) {
      if (getRecallMode() === "off") throw new Error("Hindsight memory is disabled.");
      const handles = await ensureHandles();
      const results: Array<{ text?: string; type?: string; sourceHost?: string }> = [];
      for (const bankId of activeBankIds(handles)) {
        const main = await handles.client.recall(bankId, params.query, {
          budget: params.budget ?? handles.config.searchBudget,
          maxTokens: Math.max(handles.config.contextTokens * 2, 512),
          types: handles.config.recallTypes,
        });
        const sourceHost = bankId === handles.bankId ? handles.config.workspace : `${handles.config.workspace}:global`;
        results.push(...(main?.results ?? []).map((r: any) => ({ ...r, sourceHost })));
      }

      for (const linked of handles.linked) {
        try {
          const hostResult = await linked.client.recall(linked.bankId, params.query, {
            budget: params.budget ?? handles.config.searchBudget,
            maxTokens: Math.max(handles.config.contextTokens * 2, 512),
            types: handles.config.recallTypes,
          });
          results.push(...(hostResult?.results ?? []).map((r: any) => ({ ...r, sourceHost: linked.name })));
        } catch (error) {
          if (handles.config.logging) console.warn(`[hindsight-pi] linked search failed for ${linked.name}:`, error instanceof Error ? error.message : error);
        }
      }

      return {
        content: [{ type: "text", text: formatResults(results, handles.config.toolPreviewLength) }],
        details: { count: results.length },
      };
    },
  });

  pi.registerTool({
    name: "hindsight_context",
    label: "Hindsight Context",
    description: "Synthesize memory context from Hindsight using reflect.",
    promptSnippet: "Synthesize memory context from Hindsight.",
    promptGuidelines: ["Use this tool when the user asks for a summary, synthesis, or deeper memory-backed guidance."],
    parameters: Type.Object({
      query: Type.String({ description: "Question to ask Hindsight" }),
      context: Type.Optional(Type.String({ description: "Optional extra context" })),
      budget: Type.Optional(Type.String({ description: "Reflect budget: low, mid, or high" })),
    }),
    async execute(_toolCallId: string, params: any) {
      if (getRecallMode() === "off") throw new Error("Hindsight memory is disabled.");
      const handles = await ensureHandles();
      const budget = (params.budget as SearchBudget | undefined) ?? dynamicBudget(
        params.query,
        handles.config.reasoningLevel,
        handles.config.dialecticDynamic,
        handles.config.reasoningLevelCap,
      );

      const reflectQuery = params.context
        ? `${params.query}\n\nAdditional context:\n${params.context}`
        : params.query;
      const sections: string[] = [];
      for (const bankId of activeBankIds(handles)) {
        const primary = await handles.client.reflect(bankId, reflectQuery, {
          budget,
        });
        const label = bankId === handles.bankId ? handles.config.workspace : `${handles.config.workspace}:global`;
        sections.push(`=== [${label}] ===\n${primary?.text ?? "No synthesized context returned."}`);
      }

      for (const linked of handles.linked) {
        try {
          const hostResult = await linked.client.reflect(linked.bankId, reflectQuery, {
            budget,
          });
          sections.push(`=== [${linked.name}] ===\n${hostResult?.text ?? "No synthesized context returned."}`);
        } catch (error) {
          if (handles.config.logging) console.warn(`[hindsight-pi] linked context failed for ${linked.name}:`, error instanceof Error ? error.message : error);
        }
      }

      return {
        content: [{ type: "text", text: sections.join("\n\n") }],
        details: { budget },
      };
    },
  });

  pi.registerTool({
    name: "hindsight_pages_find",
    label: "Hindsight Pages",
    description: "Find knowledge pages: living documents the bank maintains, one per question, each rewritten as memory consolidates. Omit the query to list every page in scope.",
    promptSnippet: "Find knowledge pages in Hindsight.",
    promptGuidelines: [
      "Prefer this over hindsight_search when the question is how something works here, what a convention is, or how a subsystem is organized: a page is a reconciled document, while recall returns individual facts.",
      "Every result carries a page id; read the page itself with hindsight_page_read.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Question or topic; omit to list every page in scope" })),
      limit: Type.Optional(Type.Number({ description: "Maximum pages per bank, 1 to 50, default 10" })),
      scope: Type.Optional(Type.String({ description: "project (default: this project's pages plus untagged ones) or all" })),
    }),
    async execute(
      _toolCallId: string,
      params: { query?: string; limit?: number; scope?: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      if (getRecallMode() === "off") throw new Error("Hindsight memory is disabled.");
      const handles = await ensureHandles();
      const limit = Math.min(Math.max(Math.trunc(params.limit ?? 10), 1), 50);
      const scopeTags = (params.scope ?? "project") === "all" ? [] : pageScopeTags(handles, ctx.cwd);
      const lines: string[] = [];
      let dropped = 0;
      let count = 0;

      for (const bankId of activeBankIds(handles)) {
        const label = bankId === handles.bankId ? handles.config.workspace : `${handles.config.workspace}:global`;
        if (params.query) {
          const found = await searchPagesInScope(handles.config.baseUrl, handles.config.apiKey, bankId, params.query, limit, scopeTags);
          dropped += found.dropped;
          for (const hit of found.hits) lines.push(formatPageLine(++count, label, hit, compactSnippet(hit.snippet, PAGE_SNIPPET_LIMIT)));
          continue;
        }
        const pages = (await listPages(handles.config.baseUrl, handles.config.apiKey, bankId))
          .filter((page) => pageInScope(page.tags, scopeTags))
          .sort((a, b) => `${a.path}/${a.name}`.localeCompare(`${b.path}/${b.name}`));
        for (const page of pages.slice(0, limit)) lines.push(formatPageLine(++count, label, page, compactSnippet(page.description ?? "", PAGE_SNIPPET_LIMIT)));
      }

      const scopeLabel = scopeTags.length > 0 ? scopeTags.join(", ") : "every page";
      const text = lines.length > 0
        ? lines.join("\n")
        : `No knowledge page in scope (${scopeLabel}). Pages are created deliberately, so a project may have none.`;
      return {
        content: [{ type: "text", text }],
        details: { count, dropped, limit, scope: scopeTags.length > 0 ? scopeTags : "all" },
      };
    },
  });

  pi.registerTool({
    name: "hindsight_page_read",
    label: "Hindsight Page",
    description: "Read one knowledge page in full, by id.",
    promptSnippet: "Read a Hindsight knowledge page.",
    promptGuidelines: [
      "Ids come from hindsight_pages_find.",
      "A page is a projected view over consolidated memory rather than a file in the repository, so it states what currently holds and cites no line numbers.",
    ],
    parameters: Type.Object({
      page_id: Type.String({ description: "Page id, for example kp-1a2b3c4d" }),
      frontmatter: Type.Optional(Type.Boolean({ description: "Return the portable markdown with YAML frontmatter instead of the body, default false" })),
    }),
    async execute(_toolCallId: string, params: { page_id: string; frontmatter?: boolean }) {
      if (getRecallMode() === "off") throw new Error("Hindsight memory is disabled.");
      const handles = await ensureHandles();
      const banks = activeBankIds(handles);
      for (const bankId of banks) {
        const page = await readPage(handles.config.baseUrl, handles.config.apiKey, bankId, params.page_id);
        if (!page) continue;
        const question = page.description ? ` answers: ${page.description}` : "";
        const text = params.frontmatter
          ? page.markdown
          : `Page "${page.name}" (${page.id}, bank ${bankId})${question}\n\n${page.body}`;
        return {
          content: [{ type: "text", text }],
          details: { id: page.id, bankId, tags: page.tags, builtAt: page.timestamp, chars: text.length },
        };
      }
      throw new Error(`No knowledge page ${params.page_id} in ${banks.join(", ")}.`);
    },
  });

  pi.registerTool({
    name: "hindsight_retain",
    label: "Hindsight Retain",
    description: "Store explicit durable memory in Hindsight.",
    promptSnippet: "Store explicit durable memory in Hindsight.",
    promptGuidelines: ["Use this tool when the user explicitly says to remember a preference, fact, or decision."],
    parameters: Type.Object({
      content: Type.String({ description: "Durable memory to store" }),
      context: Type.Optional(Type.String({ description: "Optional context for the memory" })),
    }),
    async execute(_toolCallId: string, params: any) {
      const handles = await ensureHandles();
      const maybeEntries = (params.__sessionEntries ?? undefined) as any[] | undefined;
      if (maybeEntries && !sessionRetained(maybeEntries, true)) {
        return { content: [{ type: "text", text: "Hindsight retention is disabled for this session." }], details: { refused: true } };
      }
      await handles.client.retainBatch(handles.bankId, [{
        content: params.content,
        context: params.context,
        metadata: {
          source: "pi",
          explicit: "true",
          kind: "explicit",
          origin: "explicit",
          workspace: handles.config.workspace,
          peer: handles.config.peerName,
          aiPeer: handles.config.aiPeer,
        },
        tags: [
          "source:pi",
          `workspace:${sanitizeTag(handles.config.workspace)}`,
          `bank:${sanitizeTag(handles.bankId)}`,
          "kind:explicit",
          "origin:explicit",
        ],
      }], { async: false });
      return {
        content: [{ type: "text", text: `Saved durable memory to ${handles.bankId}.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "hindsight_bank_profile",
    label: "Hindsight Bank Profile",
    description: "Inspect current Hindsight bank profile and runtime connection info.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string) {
      const handles = await ensureHandles();
      const insights = await getBankInsights(handles.config.baseUrl, handles.config.apiKey, handles.bankId);
      const profile = insights.profile ?? await handles.client.getBankProfile(handles.bankId);
      const disposition = profile?.disposition
        ? `skepticism=${profile.disposition.skepticism ?? "?"}, literalism=${profile.disposition.literalism ?? "?"}, empathy=${profile.disposition.empathy ?? "?"}`
        : "none";
      const linked = handles.linked.length > 0 ? handles.linked.map((h) => `${h.name}:${h.bankId}`).join(", ") : "none";
      const text = [
        `Bank ID: ${handles.bankId}`,
        `Name: ${profile?.name ?? handles.bankId}`,
        `Background: ${profile?.background ?? ""}`,
        `Disposition: ${disposition}`,
        `Directives: ${insights.directivesCount ?? "unknown"}`,
        `Mental models: ${insights.mentalModelsCount ?? "unknown"}`,
        `Documents: ${insights.documentsCount ?? "unknown"}`,
        `Entities: ${insights.entitiesCount ?? "unknown"}`,
        `Workspace: ${handles.config.workspace}`,
        `Global bank: ${handles.config.globalBankId ?? "none"}`,
        `Linked hosts: ${linked}`,
        `Base URL: ${handles.config.baseUrl}`,
        `Recall mode: ${handles.config.recallMode}`,
        `Memory query mode: fresh recall across all memory types for auto-context`,
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          profile,
          directivesCount: insights.directivesCount,
          mentalModelsCount: insights.mentalModelsCount,
          documentsCount: insights.documentsCount,
          entitiesCount: insights.entitiesCount,
          linkedHosts: handles.linked.map((h) => ({ name: h.name, bankId: h.bankId })),
        },
      };
    },
  });
};
