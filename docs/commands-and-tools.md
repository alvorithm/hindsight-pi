# Hindsight-pi Commands and Tools

This document defines exact user-facing contract for commands and LLM tools.

## Naming Rule

Use `hindsight_*` for LLM-callable tools.
Use `/hindsight:*` for slash commands.

Reason:
- clear namespace
- avoids collision with Honcho and generic memory packages
- readable for model and operator

## LLM Tools

## 1. `hindsight_search`

Purpose:
- raw retrieval from Hindsight using `recall`

When model should use it:
- user asks for past facts, prior decisions, preferences, project history, or architecture details
- low-cost context lookup is enough
- raw evidence is preferable to synthesis

Implemented parameters:

```ts
{
  query: string;
  budget?: 'low' | 'mid' | 'high';
}
```

Behavior:
- uses configured `recallTypes` from `config.json`
- searches active bank
- also searches `globalBankId` when configured
- also fans out to linked hosts when configured

Output:
- numbered raw memory snippets
- optional memory type labels
- no heavy synthesis

## 2. `hindsight_context`

Purpose:
- synthesized answer from Hindsight using `reflect`

When model should use it:
- user asks for summary, synthesis, or "what should I know"
- question needs integration across many memories
- raw recall output would be noisy

Proposed parameters:

```ts
{
  query: string;
  context?: string;
  budget?: 'low' | 'mid' | 'high';
}
```

Output:
- `reflect` text answer
- optionally short source summary if available from response

## 3. `hindsight_retain`

Purpose:
- explicit durable write for high-value facts, preferences, and decisions

When model should use it:
- user explicitly says to remember something
- a durable preference or decision is established
- storing this in memory is more appropriate than waiting for async upload

Proposed parameters:

```ts
{
  content: string;
  context?: string;
}
```

Output:
- short confirmation text

## 4. `hindsight_bank_profile`

Purpose:
- inspect current bank identity/debug info

When model should use it:
- user asks what bank is active
- user asks whether memory is connected
- debugging configuration

Proposed parameters:

```ts
{}
```

Output:
- bank ID
- bank name/background when available
- base URL / environment summary
- mode summary

## 5. `hindsight_pages_find`

Purpose:
- find knowledge pages, the living documents a bank maintains, one per question

When model should use it:
- the question is how something works here, what a convention is, or how a subsystem is organized
- a reconciled document serves better than the individual facts `hindsight_search` returns
- the user asks what standing answers exist for this project

Parameters:

```ts
{
  query?: string;   // omit to list every page in scope
  limit?: number;   // per bank, 1 to 50, default 10
  scope?: string;   // "project" (default) or "all"
}
```

Scope: `project` keeps pages that share a tag with auto-recall's tags (`{project}` by default) plus untagged pages, which are the globals. Page search has no server-side tag filter, so the extension joins each hit against the knowledge-base tree and drops what falls outside the scope; `details.dropped` reports how many.

Output:
- one numbered line per page: bank label, folder path and name, page id, a `stale` mark when the page is behind its memory, and the page question or the search snippet

## 6. `hindsight_page_read`

Purpose:
- read one page in full, by id

When model should use it:
- `hindsight_pages_find` named a page worth reading
- the user asks for the standing answer rather than a summary

Parameters:

```ts
{
  page_id: string;      // from hindsight_pages_find, for example kp-1a2b3c4d
  frontmatter?: boolean; // portable markdown with YAML frontmatter instead of the body, default false
}
```

Output:
- one identity line (name, id, bank, the question the page answers) followed by the page body, or the portable markdown when `frontmatter` is set
- the page is searched for in the active bank and then the global bank; an unknown id is an error, never an empty answer

## Optional Later Tools

Not required for MVP:
- `hindsight_list_mental_models`
- `hindsight_refresh_mental_model`
- `hindsight_recall_trace`

## Slash Commands

## 1. `/hindsight:setup`

Purpose:
- first-time setup flow

Responsibilities:
- collect enabled flag
- collect base URL
- collect API key if needed
- choose bank strategy
- optionally set manual bank ID
- optionally set global bank ID
- collect recall types
- collect write frequency and save-messages behavior
- collect reasoning level/cap and preview length
- save config
- reconnect and validate

## 2. `/hindsight:status`

Purpose:
- show current connection and runtime status

Should display:
- enabled/disabled
- connected/offline
- active bank ID
- global bank ID
- base URL
- recall mode
- recall types
- reasoning level/cap
- write frequency
- cache freshness info if available

## 3. `/hindsight:config`

Purpose:
- show effective config with secrets redacted

Use:
- debugging normalization and env overrides

## 4. `/hindsight:doctor`

Purpose:
- preflight health check

Checks should include:
- config readable
- base URL valid
- API reachable
- auth valid
- bank resolved
- bank exists or can be created
- simple recall works with configured `recallTypes`

## 5. `/hindsight:mode`

Purpose:
- switch between `hybrid`, `context`, `tools`, `off`

Use:
- let user control injection/tool behavior without editing config file manually

## 6. `/hindsight:sync`

Purpose:
- force immediate context refresh

Use:
- after major decisions
- after setup changes
- when user says memory feels stale

## 7. `/hindsight:map`

Purpose:
- map current path/repo to explicit bank ID

Use:
- override derived strategy for one project

## Prompt Guidance Contract

Extension should add prompt guidance similar to:
- use `hindsight_search` for raw facts and evidence
- use `hindsight_context` for synthesized memory answers
- use `hindsight_retain` for explicit durable memories
- use `hindsight_pages_find` and `hindsight_page_read` for standing answers: pages are reconciled documents, so prefer them for "how does X work here" over assembling facts by hand

In hybrid mode injected prompt should also mention:
- persistent memory block may be stale between refreshes
- explicit Hindsight tools exist for deeper or fresher lookup

## Differences From Honcho Tooling

Replace Honcho tools:
- `honcho_search` → `hindsight_search`
- `honcho_context` → `hindsight_context`
- `honcho_conclude` → `hindsight_retain`
- `honcho_profile` / `honcho_seed_identity` do not map directly

Why no direct `profile` analog in MVP:
- Hindsight is bank-first, not peer-card-first
- profile-like summaries should come from recall, reflect, or later mental models

## Recommended MVP Surface

Implemented:
- tools: `hindsight_search`, `hindsight_context`, `hindsight_retain`, `hindsight_bank_profile`, `hindsight_pages_find`, `hindsight_page_read`
- commands: `/hindsight:setup`, `/hindsight:status`, `/hindsight:config`, `/hindsight:doctor`, `/hindsight:mode`, `/hindsight:sync`, `/hindsight:map`, `/hindsight:recall`, `/hindsight:retain`, `/hindsight:settings`

## v3 Commands

- `/hindsight:popup` — show exact last recall payload from extension-owned state.
- `/hindsight:flush` — flush current session queue with retainBatch append payloads.
- `/hindsight:profile broad|project|cwd|global|isolated` — apply a v3 memory routing preset.
- `/hindsight:toggle-retain` — toggle automatic retention for the current session.
- `/hindsight:tag <tag>` — add a session tag included on flush.
- `/hindsight:remove-tag <tag>` — remove a session tag.
- `/hindsight:parse-session` — parse current session to JSON for inspection.
- `/hindsight:parse-and-upsert-session` — upsert current session as one stable Hindsight document.
- `/hindsight:prune-recall-messages confirm` — remove persisted `hindsight-recall` entries from the current session file.
