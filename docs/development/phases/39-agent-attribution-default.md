# Phase 39 — no agent attribution by default

**Goal:** commits and PRs made inside any bardolier project carry no `Co-Authored-By: Claude`
trailer or "Generated with Claude Code" line, unless the project asks for them.

**Deliverables:**
- `cli/src/agent-settings.ts`: `ensureAttributionDefault` writes `attribution: {commit: "", pr: ""}`
  to `home/.claude/settings.json` when the key is absent; `up` calls it every run.
- `layout.ts` `holdsData`: the unedited default does not count as data (`delete` still works).
- `cli-spec.md` §6 (`up`), §9 (`$HOME`).

**Non-goals:** no seed in `new` (`home/` stays empty); no managed setting in the images, so
the default stays overridable.

**Done-check:** `test/agent-settings.test.ts`.
