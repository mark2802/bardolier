---
name: migrate-project
description: Bring an existing, non-bardolier project onto bardolier — surveys the source, asks at every decision the owner must make, and runs the migration. Use when asked to migrate, adopt, or "bardolier-ify" an existing repo.
---

# Migrate a project onto bardolier

This skill is a **driver for `docs/migration-guide.md`**, not a copy of it.
That guide, and `docs/development/migration-guide-gaps.md` beside it, are the single
source of truth for what to do and why — read both **in full** before doing
anything else. If either has moved or been renamed since this skill was
written, that is a bug in this file; fix the reference, don't guess at the
content.

**Argument:** the path to the project being migrated (`$ARGUMENTS`). If not
given, ask for it.

## What this adds on top of the guide

The guide is written for "whoever (human or agent) is doing the migration"
and already gives the steps, in order, with which ones are **STOP** points.
What it cannot do from a markdown file:

- **Turn a STOP into an actual question.** Every step the guide marks STOP —
  archetype choice, service mapping, the port-policy decision in Part 2,
  anything under "note anything bardolier couldn't do" — becomes a real
  question to the project's owner via whatever the current session's way of
  asking is. Never guess past one. State what you found and the options; let
  the owner decide.
- **Run the mechanical steps, not hand-compose them.** Part 1 steps 3–4
  (create the project, get the repository into `work/<repo>/`) are
  `bardolier adopt <source-path> <name> --archetype <a> [--services a,b]
  [--root <name>] [--move]` — one command, not a `bardolier new` followed by
  a hand-run `mv`/`git clone`. Run it with `--dry-run` first and show the
  plan before running it for real.
- **Never hand-compose a port, anywhere.** Not in `--dry-run`'s output (it
  reports none — see `cli-spec.md` §6), and not once the project exists
  either. After the real `bardolier adopt` (or a later `bardolier service
  add` / `bardolier port add`), read the actual numbers with `bardolier
  status <name> --json` before writing a single env var or connection
  string. This is the guide's own rule (Part 1 step 3, Part 2) and the
  single most common way a migration goes subtly wrong.
- **Never patch `docker-compose.yml`.** It is rendered from `project.yml` and
  overwritten on the next `up` (`cli-spec.md` §9, INTENT.md invariant 7). If
  something seems to need a compose edit, it needs a CLI capability instead —
  see "when the guide doesn't cover something" below.
- **Leave the repo's own files alone** (guide Part 1 step 5) — nothing
  inside `work/<repo>/` needs to change to run under bardolier; resist the
  urge to "clean up" what the migration merely relocated.

## Sequence

1. Read `docs/migration-guide.md` and `docs/development/migration-guide-gaps.md` in full.
2. Survey the source project the way Part 1 step 1 describes — compose
   files, Dockerfiles, env files, package manifests, dev scripts, an
   existing `CLAUDE.md` that assumes the old shape, large material that is
   neither code nor service data. Read-only; nothing is written yet.
3. Decide the archetype and service mapping (step 2) and confirm with the
   owner (STOP) rather than assuming.
4. `bardolier adopt <source-path> <name> --archetype <a> [--services a,b]
   --dry-run --json` — show the plan. On confirmation, run it for real
   (add `--move` if the source should stop existing at its old path).
5. Work through Part 1 steps 5–10 and Part 3's situational items, checking
   each against the actual project rather than assuming none apply. Point 6
   (service names, not `localhost`) and step 9 (bring up and verify) both end
   at `bardolier status <name> --json` for the real facts — port numbers,
   service state — never a guess.
6. Work through Part 2 (the port-policy decision) if the project has a
   frontend and a backend, or more than one process needing to be reached
   from outside the container. This is a STOP: ask which of A/B/both applies
   before wiring any env var.
7. **When the guide doesn't cover something the project needs:**
   - Check `docs/development/migration-guide-gaps.md`'s Open section first — it may
     already be tracked.
   - If it's a one-off that doesn't generalize, tell the owner directly and
     route around it in this project only (the guide's own instruction) —
     don't invent a bardolier/app capability for it.
   - If it looks like it would recur, propose a new entry for
     `docs/development/migration-guide-gaps.md`'s Open section — phrased generically,
     describing the situation and what's missing, **naming no project** —
     and ask the owner before adding it.
8. Finish by reporting what was migrated, what was asked and answered, and
   any gap filed — not by silently declaring success.

## What this skill does not do

It does not decide unsupervised. Every STOP in the guide stays a STOP here.
It does not invent workarounds for missing capabilities — it files them. And
it does not touch `docs/migration-guide.md` itself; if a step turns out to be
wrong or missing, say so and propose the fix as a separate change, the way
the guide's own review-prompt appendix does.
