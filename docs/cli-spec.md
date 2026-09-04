# CLI Spec — `bardolier` (Container Project Manager engine)

Status: draft for implementation. This is the **engine**. The menu-bar app is a
thin client over this CLI. **The CLI is the API; the app is a thin client.** All
orchestration lives here; the app only calls commands and renders their JSON.

Companion docs: `app-spec.md` (the client), `CLAUDE.md` (principles +
boundaries).

---

## 1. Responsibilities

The CLI owns all truth and all side effects:

- Create / list / start / stop / delete projects on the external SSD.
- Maintain each project's manifest and generate its `docker-compose.yml`.
- Attach / detach backing services from an editable catalogue.
- Allocate, persist, and release **stable, unique host ports** per service.
- Open a shell into a running project's dev container.
- Stop everything and safely eject the SSD, refusing when the volume is held.
- Surface orphaned volumes and reclaim them on request.

The app holds no orchestration logic. If the app needs something, a CLI command
grows to provide it.

## 2. Global conventions

- **Every command supports `--json`** and prints a single JSON value on stdout.
  Without `--json`, output is human-readable and MUST NOT be parsed by the app.
- **Exit codes:** `0` success; non-zero on failure. On failure with `--json`,
  stdout is `{ "error": { "code": "<STABLE_CODE>", "message": "<human>" } }`.
- **Stable error codes** (not exhaustive): `SSD_NOT_MOUNTED`,
  `PROJECT_EXISTS`, `PROJECT_NOT_FOUND`, `PROJECT_RUNNING`, `PROJECT_STOPPED`,
  `SERVICE_UNKNOWN`, `SERVICE_ATTACHED`, `SERVICE_NOT_ATTACHED`,
  `EXTRA_PORT_ATTACHED`, `EXTRA_PORT_NOT_ATTACHED`,
  `PACKAGE_ATTACHED`, `PACKAGE_NOT_ATTACHED`,
  `PORT_UNAVAILABLE`, `VOLUME_IN_USE`, `EJECT_BLOCKED`, `EJECT_NOT_APPLICABLE`,
  `DOCKER_UNAVAILABLE`.
- **No partial mutation of a running project:** service add/remove, port
  add/remove and deps add/remove require the project stopped and fail
  `PROJECT_RUNNING` otherwise.
- **Idempotency:** `up` on a running project is a no-op success; `down` on a
  stopped project is a no-op success.
- **Read-only commands never mutate.** `status`, `list`, `volumes orphaned`.
- The CLI reads `$SSD_ROOT` and `$SSD_VOLUME` from config (see §8).

## 3. On-disk layout

```
$SSD_ROOT/                         # e.g. /Volumes/ssd/claude-projects
  <project>/
    project.yml                    # manifest (source of truth per project)
    docker-compose.yml             # GENERATED from project.yml — never hand-edit
    .gitignore                     # seeded
    .dockerignore                  # seeded
    CLAUDE.md                      # seeded, archetype-specific boundary
    <source code>
```

Docker's image/layer store stays on the **internal** disk. Only project data and
named volumes live on the SSD.

## 4. Data model

### 4.1 Service catalogue — `services.yml`

Single editable file (location in config; default `$SSD_ROOT/services.yml`,
falling back to a bundled default). Adding a service type = adding an entry, no
code change.

```yaml
services:
  postgres:
    display: "PostgreSQL"
    image: "postgres:17"
    container_port: 5432        # fixed port inside the container/network
    host_port_base: 5432        # start of this service's host-port band
    volume: "{project}_pgdata"  # named volume; {project} interpolated
    mount: "/var/lib/postgresql/data"
    env:
      POSTGRES_PASSWORD: "dev"
      POSTGRES_DB: "{project}"
  redis:
    display: "Redis"
    image: "redis:7"
    container_port: 6379
    host_port_base: 6379
    volume: "{project}_redisdata"
    mount: "/data"
  mongo:
    display: "MongoDB"
    image: "mongo:7"
    container_port: 27017
    host_port_base: 27017
    volume: "{project}_mongodata"
    mount: "/data/db"
```

### 4.2 Project manifest — `project.yml`

Source of truth for one project. The compose file is derived from this.

```yaml
name: myapp
archetype: web            # web | ios | android | library
base_image: bardolier-web    # resolved from archetype
extra_packages:            # OS packages beyond base_image (Phase 13); absent/empty = none
  - libnss3
services:
  postgres:
    host_port: 5433       # ASSIGNED at add-time, STABLE for life, persisted here
  redis:
    host_port: 6379
app_port: 3000            # dev-server host port (§9); absent when the
                          # archetype serves nothing, or predates the field
extra_ports:              # named ports beyond app_port (§5.1); absent/empty = none
  notebook:
    container_port: 8888
    host_port: 8888
created: 2026-08-19T10:00:00Z
```

### 4.3 Archetype → base image map

| Archetype | Base image   | In-container build?          | Host build step        |
|-----------|--------------|------------------------------|------------------------|
| web       | `bardolier-web` | full (Node/Next + Python via `uv`, services) | none    |
| ios       | `bardolier-ios` | edit + swiftlint + logic test| Xcode (build/sim/sign) |
| android   | `bardolier-and` | Gradle build + unit test     | emulator (host)        |
| library   | `bardolier-web` | full                         | none                   |

Base images carry the per-archetype toolchain, plus the two things every
archetype needs: **Claude Code** — the agent the whole tool exists to host,
installed as the pinned standalone binary to a system path rather than under
`$HOME`, which is a mounted volume (§9) — and the working kit (git, ripgrep, jq,
curl). See CLAUDE.md.

`bardolier-and` is built and run as `linux/amd64`: Google publishes the Linux
Android SDK build tools (aapt2 above all) for x86_64 only, so on Apple Silicon
that one image runs emulated. The pin lives in `cli/src/images.ts` and is read
by both `build` and compose generation (§9), which must agree.

`bardolier-and` also carries a SHARED dependency cache: `GRADLE_USER_HOME` is
`/cache/gradle`, a named volume (`bardolier-gradle-cache`) mounted into every
android dev container rather than a directory under the project's bind mount.
The Android Gradle Plugin and its transitive dependencies are hundreds of
megabytes of rebuildable data that is identical for every project, so it is kept
once, on the internal disk beside the image layers, and off the SSD. Declared in
`cli/src/images.ts` (`IMAGE_CACHE`) and read by compose generation (§9), `up`
(which creates the volume) and the volume scan (§6), which treats it as claimed
while any project's manifest names that base image.

`bardolier-web` carries the same shape of cache for `uv`, the Python toolchain it
gained so a project can run a Python API alongside its React frontend in the
one dev container: `UV_CACHE_DIR=/cache/uv`, volume `bardolier-uv-cache`, same
`IMAGE_CACHE` mechanism. `library` shares the image and the cache.

## 5. Port allocation (first-class)

Requirements, in priority order:
1. **Unique** across all projects and all services.
2. **Stable** — assigned once at service-add, persisted in `project.yml`, never
   reassigned on restart. Released only on service-remove or project-delete.
3. **Host-exposed** — every service publishes its `host_port` to the Mac so GUI
   debuggers (TablePlus, Postico, RedisInsight) can connect.
4. **Readable bands** — each service allocated within its `host_port_base` band
   (postgres 5432→5433→5434…, redis 6379→6380…).

Algorithm at service-add:
1. Read the base port for the service from the catalogue.
2. Scan **all** projects' `project.yml` for host ports already assigned (the
   manifests are the single source of truth — no separate registry to desync).
3. From `host_port_base` upward, pick the first port that is BOTH unassigned in
   any manifest AND not currently bound on the host (probe the host socket).
4. Persist it in this project's manifest.

At `up`: validate each recorded `host_port` is still bindable on the host. If a
port was squatted by another process while the project was down, fail
`PORT_UNAVAILABLE` with the offending port named — do not silently remap (a
silent remap would break the user's saved connection strings).

Dev app connects to services over the **internal Docker network** by service
name (`postgres:5432`), matching prod. The host port is a debugging tap only.
This is stated in CLAUDE.md so the agent never wires the app to `localhost`.

### 5.1 Extra ports (named, archetype-independent)

A **named** port published from the dev container, independent of archetype —
`extra_ports` in `project.yml`. Unlike `app_port` (§9), it is not fixed by the
archetype; unlike a service, it has no catalogue entry, no image and no
volume. It exists for two shapes of need, both closed by the same mechanism:

- A second, real, host-published port a **mobile client or another browser
  tab** must reach directly — the project's own backend, or a second
  frontend/UI app, beside the one `app_port` already covers.
- A **browser-reachable dev tool** (a notebook server, a debugger UI) on an
  archetype that otherwise publishes nothing at all (`library`, `ios`,
  `android`).

`bardolier port add <project> <name> --container-port <n>` declares one: the
caller states the container-side port, and the allocator finds a free host
port starting there — same rule as `app_port`, no catalogue band to start
from instead. Persisted as `extra_ports.<name>.{container_port,host_port}`,
assigned once and stable for life like any other port in §5. `bardolier port
remove <project> <name>` detaches it and releases the host port; `bardolier port
list <project>` reports what is declared, manifest-only, no daemon consulted.
Add/remove require the project stopped, exactly as service add/remove do (§6).

Compose publishes every declared extra port from the dev container alongside
`app_port` when present — the same `ports:` list, app_port first, then extra
ports sorted by name (§9's determinism rule). `status` and `up`'s JSON report
them as `extra_ports`, each with a ready-to-open `url`
(`http://localhost:<host_port>`) for the same reason `connection_hint` exists
for a service — the app renders it, it does not compose it.

## 6. Command surface

All commands accept `--json`. `<name>` is a project; `<svc>` a catalogue key.

### Projects
- `bardolier new <name> --archetype <a> [--services a,b]`
  Creates dir, manifest, compose, `.gitignore`, `.dockerignore`, `CLAUDE.md`.
  Assigns ports for any initial services. Errors: `SSD_NOT_MOUNTED`,
  `PROJECT_EXISTS`.
- `bardolier list` — array of projects with archetype + running state.
- `bardolier status [<name>]` — full status object(s) (see §7). No arg = all.
- `bardolier up <name> [--no-shell]`
  Brings the project up (app dev container + attached services on one network).
  Validates ports. By default the app-layer opens a shell after; `--no-shell`
  suppresses the app's shell-open (the CLI itself doesn't spawn terminals — it
  reports the exec command; see §6 shell).
- `bardolier down <name> [--no-handoff]` — stop + remove this project's containers.
  Data persists. Writes the handoff note first (§12) unless `--no-handoff`.
- `bardolier delete <name>` — remove containers, then the project dir. Prompts unless
  `--force`. Releases the project's ports. Named volumes: see `--keep-data`
  (default) vs `--purge` (also removes this project's volumes).

### Services
- `bardolier service add <project> <svc>` — attach; assign host port; regenerate
  compose. Errors `PROJECT_RUNNING`, `SERVICE_ATTACHED`, `SERVICE_UNKNOWN`.
- `bardolier service remove <project> <svc>` — detach; regenerate compose; **keep the
  volume** (it becomes an orphan). Release the host port. Errors
  `PROJECT_RUNNING`, `SERVICE_NOT_ATTACHED`.
- `bardolier service list <project>` — attached services + resolved host ports.

### Ports
- `bardolier port add <project> <name> --container-port <n>` — declare an extra
  port (§5.1); assign its host port; regenerate compose. Errors
  `PROJECT_RUNNING`, `EXTRA_PORT_ATTACHED`.
- `bardolier port remove <project> <name>` — remove it; regenerate compose;
  release the host port. Errors `PROJECT_RUNNING`, `EXTRA_PORT_NOT_ATTACHED`.
- `bardolier port list <project>` — declared extra ports + resolved host ports.

### Deps
- `bardolier deps add <project> <package...>` — declare one or more apt package
  names; the derived image (§9) is built at the next `up`. Errors
  `PROJECT_RUNNING`, `PACKAGE_ATTACHED`, `INVALID_ARGUMENT`.
- `bardolier deps remove <project> <package...>` — undeclare them; the next `up`
  reverts to the plain base image (or a smaller derived one) if it was the
  last package. Errors `PROJECT_RUNNING`, `PACKAGE_NOT_ATTACHED`.
- `bardolier deps list <project>` — declared packages + the image the dev
  container builds/runs from. Manifest-only, no daemon consulted.

### Shell
- `bardolier shell <name> [--print] [--root]`
  For a running project, resolves the dev container and returns the exec
  invocation. With `--json`, returns `{ "container": "...", "exec": ["docker",
  "exec","-it","<c>","bash"] }`. The **app** spawns the terminal; the CLI names
  the command. `--print` (human mode) prints the command to run. Errors
  `PROJECT_STOPPED`.
  `--root` swaps the invocation to `["docker","exec","-u","root","-it","<c>",
  "bash"]` — same container, same checks, one argv difference. It is
  ephemeral: nothing installed while root survives a `down` any more than any
  other runtime change (§6 Deps). Anything meant to persist belongs in
  `extra_packages`, not this shell.

### Volumes / disk
- `bardolier volumes orphaned` — array of `{ name, size_bytes, size_human,
  last_project }` for volumes not referenced by any current compose file.
- `bardolier volumes rm <name>` — remove one orphaned volume (confirm unless
  `--force`). Errors `VOLUME_IN_USE` if still referenced.

### Lifecycle / SSD
- `bardolier down-all` — stop + remove all bardolier containers.
- `bardolier eject` — first checks that `ssd_volume` is actually a removable
  volume (`diskutil info -plist`). It may not be: `ssd_root` is a fully
  supported, first-class mode when it's an ordinary directory on the internal
  disk (§8), and `diskutil eject`-ing `/` or another non-removable mount is
  not a smaller version of ejecting, it's the wrong command. Not removable
  fails `EJECT_NOT_APPLICABLE` immediately — no project is stopped on the way
  to that refusal — naming `bardolier down-all` as the thing to run instead.
  Otherwise: `down-all`, then check host holders (Xcode, Simulator, shells
  cd'd into the SSD via `lsof`), then `diskutil eject`. If held, fail
  `EJECT_BLOCKED` with `{ holders: [...] }` and do not force.
  A holder is only something the user can act on. The container runtime and the
  OS's own volume agents — Spotlight's `mds`/`mds_stores` above all, which map an
  indexed volume for as long as it is mounted — are excluded, because counting
  them makes the command refuse forever with nothing to quit. They are
  DiskArbitration clients, so the `diskutil eject` that follows is what actually
  asks them to let go; if one dissents, its PID and name are parsed out of the
  refusal into the same `holders` array. A blocked eject therefore always names
  something, including the root processes unprivileged `lsof` cannot see.
  The runtime is the one holder with a third answer. Docker Desktop shares
  `/Volumes` into its VM and keeps descriptors on the SSD for as long as that VM
  lives, so a disk whose containers are all down can still be dissented — with
  no window to close and no retry that ever succeeds, which made "quit Docker
  Desktop" the standing price of an eject. When that (and only that) is what
  refused, `eject` offers to stop the ENGINE (`docker desktop stop`) and try
  again: with `--stop-docker`, or by confirming at the prompt. Declining is
  `EJECT_BLOCKED` with `reason: "runtime-holds-volume"`, the runtime named in
  `holders`, and the command to run. A successful eject reports
  `docker_stopped`. This is not a force — nothing is unmounted from under
  anything, and `docker desktop start` puts the engine back.
  What follows the stop is a WAIT, not an immediate retry. `docker desktop
  stop` returns when the engine reports itself down; the VM helper that
  actually holds `/Volumes` is torn down after that and takes seconds about it,
  so retrying at once loses the race and the user is told to go and do by hand
  the thing that has just been done. `eject` polls `lsof` until the runtime is
  no longer on the volume (bounded — 15s), then attempts the unmount, and
  retries a dissent from the runtime a couple of times. A budget that runs out
  is `EJECT_BLOCKED` with `reason: "runtime-holds-volume-after-stop"`: the same
  refusal, but with no engine left to stop, so it never advises `--stop-docker`
  again. If the runtime has let go and the unmount still fails, that refusal is
  somebody else's and is reported as it came.
- `bardolier doctor` — environment check: Docker running, SSD mounted, base images
  present, catalogue valid. Returns structured findings. (Useful first call for
  the app on launch.)

### Images
- `bardolier build [--archetype <a>] [--claude-code-version <v>]` — build base
  image(s) with host UID/GID build args. No arg builds all archetypes' bases.
  Claude Code defaults to `latest`, resolved and checksum-verified against the
  publisher's manifest at build time; `--claude-code-version <X.Y.Z>` pins an
  exact release instead (e.g. to reproduce an old image, or isolate a
  regression to a specific agent build) and is checksum-verified the same way.
  Every other toolchain version in these images (Swift, Gradle, the Android
  SDK, …) stays a fixed pin — this default applies to Claude Code alone.
  Errors: `INVALID_ARGUMENT` for a malformed version.

### App support

Added in Phase 6 under §1 ("if the app needs something, a CLI command grows to
provide it"), not part of the original surface. Additive: no existing schema
changed to accommodate them.

- `bardolier catalogue` — every service type the catalogue defines, with its image,
  container port and host-port band, plus the `services.yml` that answered and
  which step of §4.1's chain it came from. The app's Services submenu and
  New-project window render this rather than keeping a copy of the catalogue.
  Reports the BAND START only; an assigned port comes from a manifest.
  Errors: `CONFIG_INVALID`.
- `bardolier config get` — the effective configuration (§8): defaults, then the
  file, then the environment, plus the file path and which env vars overrode a
  value. Errors: `CONFIG_INVALID`.
- `bardolier config set <key> <value>` — set one §8 key; an empty value clears it.
  Paths are expanded on the way in, keys are written in a stable order, and the
  effective config after the write is reported. Never validates that a path
  exists — the SSD is routinely absent, and refusing to record where it will be
  would make the setting unusable exactly when it is needed. Errors:
  `INVALID_ARGUMENT`, `CONFIG_INVALID`.

## 7. `status` JSON schema (the app's primary contract)

```json
{
  "ssd": { "mounted": true, "root": "/Volumes/ssd/claude-projects" },
  "docker": { "available": true },
  "projects": [
    {
      "name": "myapp",
      "archetype": "web",
      "state": "running",              // running | stopped | partial
      "services": [
        {
          "key": "postgres",
          "display": "PostgreSQL",
          "state": "running",          // running | stopped
          "host_port": 5433,
          "container_port": 5432,
          "connection_hint": "postgresql://localhost:5433"
        }
      ],
      "dev_container": "bardolier-myapp",   // null if stopped
      "app_port": 3000,                 // dev-server host port (§9); null if none
      "app_url": "http://localhost:3000", // null alongside it
      "extra_ports": [                  // named ports beyond app_port (§5.1)
        { "name": "notebook", "host_port": 8888, "container_port": 8888,
          "url": "http://localhost:8888" }
      ]
    }
  ],
  "orphaned_volumes": [
    { "name": "oldapp_pgdata", "size_bytes": 20971520, "size_human": "20 MB",
      "last_project": "oldapp" }
  ]
}
```

Schema stability is the contract. Additive changes only once the app ships.

## 8. Configuration

- Config file `~/.config/bardolier/config.yml` (internal disk — must be readable when
  SSD is absent, so `doctor`/`status` can report "SSD not mounted").
  Keys: `ssd_root`, `ssd_volume`, `catalogue_path`, `terminal` (for the app's
  shell-open preference, surfaced here for a single source).
- CLI reads env overrides `BDLR_SSD_ROOT`, `BDLR_SSD_VOLUME`.
- The app never edits this file itself: it reads it with `bardolier config get` and
  writes it with `bardolier config set`, so precedence, path expansion and the
  "`ssd_root` defaults inside `ssd_volume`" rule have one implementation.
- `ssd_root` may be any local directory — an external SSD is not required. The
  project lifecycle (`new`/`up`/`down`/services/volumes) never assumes a
  removable volume; only `eject` does, and it is simply unavailable
  (`EJECT_NOT_APPLICABLE`) when `ssd_volume` isn't one. Use `bardolier down-all` to
  stop everything in that mode.

## 9. Compose generation rules

- Generated file is deterministic and idempotent for a given manifest (stable
  ordering, so regeneration produces no spurious diffs).
- One user-defined network per project; services + dev container attached.
- **Image selection rule** (Phase 13): the dev container's `image:` is
  `<base_image>:latest` when `extra_packages` is empty, or the content-addressed
  derived image `bardolier-deps-<base_image>:<hash>` otherwise — `hash` a short
  sha256 of the base image plus the sorted package list, so two projects
  declaring the same base image and packages resolve to the same tag and share
  one build (`deps.ts`). `up` builds it (§6, Deps) before `docker compose up`,
  since Compose references a local tag and never builds one itself.
- Dev container: base image for the archetype, bind-mount project dir → `/work`,
  `sleep infinity`; plus `platform:` when the archetype's base image is pinned
  to one architecture (§4.3), so it starts the way `build` built it. The key is
  absent otherwise — an unpinned project's generated file must not change.
- Dev container, cont.: plus the base image's shared toolchain cache volume
  (§4.3) when it declares one, mounted at the image's own path. It is declared
  `external: true` so Compose neither creates nor claims a volume every project
  on that image shares — `up` creates it, labelled `bardolier.role: cache`. Both
  keys are absent for an image with no cache, for the same reason `platform:`
  is: an existing project's generated file must not change.
- Dev container, cont.: plus its `$HOME`, a named volume `bardolier-<project>-home`
  mounted at the images' shared `CONTAINER_HOME`, labelled `bardolier.project` and
  `bardolier.role: home`. `down` removes the container, so a home in its writable
  layer would lose the shell history, the dotfiles and the agent's login on
  every stop. It is PER PROJECT, not shared like the toolchain cache: it holds
  the user's own state, and Claude Code files its sessions by working directory
  — every dev container works in `/work`, so one shared home would file every
  project's sessions together and `claude --continue` would resume the wrong
  one. It is the project's, so `delete --purge` takes it and a plain `delete`
  leaves it as a listed orphan.
- Dev container, cont.: an `environment:` block in Compose's LIST form naming
  the host variables the container may inherit — the agent's credentials and
  git's identity variables. A bare name (no `=`) is passed through when the
  environment running `compose up` has a value and left UNSET otherwise; an
  empty-string token is a credential that fails rather than a login prompt. The
  list is fixed and sorted, so the file is identical on a machine holding every
  token and one holding none. `up` fills the `GIT_*` names from the host's own
  `git config`, so a commit made in the container is attributed to the human
  rather than failing on an unset `user.email`.
- Services: image from catalogue, named volume, `host_port:container_port`
  published, env interpolated (`{project}` → name).
- The dev container publishes NOTHING except its archetype's dev server, where
  the archetype has one (`ARCHETYPE_APP_PORT`; `web` → 3000), plus any extra
  ports declared on it (§5.1). `app_port` is a service-like allocation: fixed
  inside the container so every project's server config is identical,
  allocated from a band on the host so two web projects cannot clash, assigned
  once and persisted as `app_port` (§5). `PORT` is set in the container to the
  fixed side. A project created before the field existed is assigned one on
  its next `up` — the only moment its manifest is being written anyway. This
  and extra ports are the only exceptions to the rule that services' host
  ports are debugging taps: a browser on the Mac cannot join the Docker
  network, and a native client outside the project entirely cannot either.
  Extra ports have no such retrofit — `port add` always writes both sides at
  once — and publish in `ports:` sorted by name, after `app_port` when present.

## 10. Seeded files (by `new`)

- `.gitignore` — `.build/ .swiftpm/ DerivedData/ node_modules/`
  (archetype-tuned), plus `.bardolier/`, which holds the handoff note (§12):
  regenerated on every stop, so churn rather than history. Track it deliberately
  if you want the notes in the repo.
- `.dockerignore` — excludes `node_modules`, build output, `.git`,
  DerivedData, so image builds/context stays small (serves the disk goal).
- `CLAUDE.md` — archetype-specific, references the boundary rules (host vs
  container build), and for an archetype with a dev server (§9) the instruction
  to bind `0.0.0.0` rather than `localhost` — a server on the container's own
  loopback is unreachable from the Mac and looks like a broken port mapping.

## 11. Testing expectations

- The full lifecycle is drivable and assertable from the terminal with `--json`
  before any app work: new → add service → up → shell command resolves → status
  shows ports → down → remove service → orphan appears → reclaim → delete →
  eject (holder-blocked and clear paths).
- Port allocation has unit coverage: uniqueness, stability across restart,
  band assignment, host-squat detection.

## 12. The handoff note (by `down`)

A project resumed after three weeks is a project whose state has been forgotten.
`down` is the one moment when everything needed to describe that state is still
true and still reachable — so the note is written there, into
`<project>/.bardolier/handoff.md`, and nowhere else.

- **Two sources, failing independently.** The repository, via `git` on the host:
  branch, recent commits, what is still uncommitted. And the agent's own
  account, via `claude --print --continue` run INSIDE the dev container, which
  is the half that knows what was being *attempted* — no amount of git
  archaeology recovers that.
- **Written before `compose down`.** The session being summarised lives in the
  dev container and dies with it. Asking afterwards is asking nobody.
- **`--continue` resolves correctly** only because each project has its own
  `$HOME` and therefore its own Claude config dir (§9).
- **Best-effort is the contract.** No container, no agent, no session, no
  credentials, a timeout, a read-only disk: each degrades to a smaller note or
  to no note, and NONE fails the `down`. A stop that refused because it could
  not write a memo would be worse than a tool that never wrote memos — the user
  asked for a stop. A non-zero exit or empty output is not a summary; the note
  says so rather than pasting a refusal under the heading.
- **Appended, not overwritten.** Each stop adds a new entry, newest at the
  bottom; none is ever rewritten or dropped — a quiet "just said hello" session
  reporting no work honestly must not destroy a substantive entry above it, and
  `.bardolier/` is gitignored by default (§10), so there is usually no git history
  underneath to fall back on.
- `--no-handoff` skips it. `delete` always passes it — there is no point
  summarising a project a second before its directory is removed.
