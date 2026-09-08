# INTENT

The owner's document. **The agent may quote it and must never edit it.** Where
the code, a spec or `CLAUDE.md` conflicts with anything here, the conflict is
raised, not reconciled: the spec follows implementation on its own, which is
exactly what this file exists to make observable.

## Purpose

One tool that makes a containerised dev project — its repositories, its
services, its data — a thing you can create, hand to an agent, stop, and
unplug, without ever learning where Docker put anything.

## Invariants

Each is meant to be checkable from outside the code. A phase that breaks one is
wrong even if its own check passes.

1. **Storage.** The only bardolier bytes on the internal disk are shared,
   re-downloadable images and caches. Everything project-specific — manifests,
   repositories, service data, `$HOME` — lives under a configured root.
2. **The CLI is the whole API.** Every state change is reachable from a
   terminal with `--json`; the app spawns nothing but `bardolier`.
3. **Nothing is destroyed that the owner did not name.** Detaching keeps data,
   deleting a project with data refuses, eject reports holders and never forces.
4. **A published port, once allocated, never moves.** Connection strings the
   owner wrote down stay correct.
5. **`down` loses only the container.** Work, service data, `$HOME` and the
   agent's login survive every stop.
6. **The container is an environment boundary, not a sandbox.** It runs as the
   host user over bind-mounted real files; macOS-native work stays on the host.
7. **Generated files are never authoritative.** `project.yml` is the truth;
   compose is rendered from it, byte-stably, and never read back for facts.

## Non-goals

Not a sandbox for untrusted code. Not a deployment, CI or production tool. Not
a general-purpose container manager — no arbitrary compose, no remote or
multi-user hosts. Not affiliated with, endorsed by or sponsored by Anthropic.

## Decisions taken

Irreversible choices are settled here, by the owner, before the work that
depends on them — never inside a plan bullet.

| Decision | Answer | Date |
| --- | --- | --- |
| CLI language/runtime | TypeScript on Node ≥ 22.18, no build step | 2026-08-20 |
| Name | `bardolier`, shared by CLI and app | 2026-09-04 |
| Licence | Apache 2.0, plus a NOTICE disclaiming affiliation | 2026-09-04 |
| Where project data lives | bind mounts under the root, not named volumes | 2026-09-06 |
| Number of roots | many, each with a derived mount point | 2026-09-05 |
| Per-project truth | one `project.yml`; no second registry | 2026-08-20 |
| Cross-root knowledge while a root is offline | a derived index on the internal disk, rebuilt from the manifests, never authoritative | 2026-09-07 |
