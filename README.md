# bardolier

A CLI (`bardolier`) plus a macOS menu-bar app that manage containerised dev
projects — create one, hand it to an agent, stop it, unplug the disk it lives
on, without ever learning where Docker put anything. The CLI runs on your Mac
and drives Linux dev containers over Docker; the menu-bar app is a thin client
over the CLI — it shells out to `bardolier … --json` and renders the result,
nothing more.

A project's repositories, service data and the container's `$HOME` all live
under a configured **root** — typically an external SSD, but any local
directory works too (an SSD is optional, not assumed). The only bytes bardolier
puts on your internal disk are shared, re-downloadable base images and caches.

## Prerequisites

- **Docker Desktop**, running.
- **Node ≥ 22.18** (no build step — the CLI runs straight from TypeScript
  source; Node's native type-stripping is what makes that possible).
- **Xcode**, only if you want to build the menu-bar app from source.

## Install

```sh
git clone https://github.com/mark2802/bardolier.git
cd bardolier
npm install
npm run setup           # links `bardolier` (and `bdlr`) onto your PATH
bardolier doctor         # sanity-checks Docker, roots, base images
```

`npm run setup` (`bardolier install`) puts a symlink into the first writable
conventional bin directory it finds (`/opt/homebrew/bin`, `/usr/local/bin`,
`~/.local/bin`, …) — the same directories the menu-bar app searches, so
whichever finds it, both do. Pass `--bin-dir <dir>` to choose one yourself.

Then, optionally, the menu-bar app — built from source, no Xcode window
required:

```sh
npm run setup:app        # xcodebuild → /Applications/Bardolier.app
```

(`npm run setup:app` only runs on macOS with Xcode installed; the CLI has no
such restriction.)

## Quickstart

```sh
bardolier root add ~/bardolier-projects        # or point it at an external disk
bardolier new myapp --archetype web --services postgres
bardolier up myapp
bardolier status myapp --json                  # the real host port — never guess it
```

`up` starts a dev container (bind-mounting `myapp/work/` at `/work` inside it)
plus whatever services you attached, all on one Docker network. `bardolier
shell myapp` opens a shell in the container; the menu-bar app does the same
with one click, and offers it automatically after `up` if you enable that in
Preferences.

See `docs/cli-spec.md` for the full command surface, or run `bardolier --help`.

## Bringing an existing project on

`docs/migration-guide.md` is a runbook for moving a project you already have
onto bardolier — archetype choice, service mapping, the port-policy decision,
and the situational cases that come up in practice. If you're using Claude
Code, the `migrate-project` skill (`.claude/skills/migrate-project/`) drives
that guide directly: point it at a path and it surveys the project, asks at
every decision point, and runs the mechanical steps (`bardolier adopt`) for
you.

## The menu-bar app

A `MenuBarExtra` with no dock icon. It lists your projects, starts and stops
them, attaches services, opens a shell, and ejects a root's disk when you're
done — all of it by calling `bardolier … --json` and rendering the answer. No
orchestration logic lives in Swift; if the app needs something the CLI can't
already do, a CLI command grows to provide it. See `docs/app-spec.md`.

## Security

- **The dev container is an environment boundary, not a sandbox.** It runs
  as your own host uid/gid and bind-mounts real project files at `/work` —
  code inside it can read and write exactly what your own user account can
  reach on the mounted root. It is not a security boundary for untrusted
  code.
- **Host credentials can reach the container, deliberately, if you set them.**
  A small, explicit list of environment variables (`PASSTHROUGH_ENV` in
  `compose.ts`) is passed through in Compose's *list* form — an unset
  variable on the Mac stays unset in the container, never becomes an empty
  credential.
- **Claude Code is installed in the base images** and keeps its own
  permission prompts; bardolier does not change or bypass them. Nothing in
  this codebase passes `--dangerously-skip-permissions`.
- **`bardolier shell --root`** opens a root shell inside one running
  container — root in that container, and nothing beyond it.
- **Nothing here is a deployment, CI, or production tool**, and it doesn't
  manage remote or multi-user hosts. See `INTENT.md`'s non-goals.

## Documentation

- `docs/cli-spec.md` — the CLI: layout, data model, ports, commands, the
  `status` schema, config, compose generation, seeded files, the handoff note.
- `docs/app-spec.md` — the menu-bar app.
- `docs/migration-guide.md` — bringing an existing project onto bardolier.
- `INTENT.md` — the project's purpose, invariants and non-goals.
- `CONTRIBUTING.md` — how to work on bardolier itself.
- `docs/development/` — phase-by-phase design history, kept because the
  reasoning in it is most of what makes the repo worth reading.

## Licence

Apache License 2.0 — see `LICENSE` and `NOTICE`. This project is not
affiliated with, endorsed by, or sponsored by Anthropic.
