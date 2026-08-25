# CLI Spec — `cproj` (Container Project Manager engine)

Status: draft for implementation. This is the **engine**. The menu-bar app is a
thin client over this CLI. **The CLI is the API; the app is a thin client.** All
orchestration lives here; the app only calls commands and renders their JSON.

Companion docs: `app-spec.md` (the client), `implementation-plan.md` (phasing),
`CLAUDE.md` (principles + boundaries).

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
  `PORT_UNAVAILABLE`, `VOLUME_IN_USE`, `EJECT_BLOCKED`, `DOCKER_UNAVAILABLE`.
- **No partial mutation of a running project:** service add/remove require the
  project stopped and fail `PROJECT_RUNNING` otherwise.
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
base_image: claude-web    # resolved from archetype
services:
  postgres:
    host_port: 5433       # ASSIGNED at add-time, STABLE for life, persisted here
  redis:
    host_port: 6379
created: 2026-08-19T10:00:00Z
```

### 4.3 Archetype → base image map

| Archetype | Base image   | In-container build?          | Host build step        |
|-----------|--------------|------------------------------|------------------------|
| web       | `claude-web` | full (Node/Next, services)   | none                   |
| ios       | `claude-ios` | edit + swiftlint + logic test| Xcode (build/sim/sign) |
| android   | `claude-and` | Gradle build + unit test     | emulator (host)        |
| library   | `claude-web` | full                         | none                   |

Base images carry the per-archetype toolchain only. See CLAUDE.md.

`claude-and` is built and run as `linux/amd64`: Google publishes the Linux
Android SDK build tools (aapt2 above all) for x86_64 only, so on Apple Silicon
that one image runs emulated. The pin lives in `cli/src/images.ts` and is read
by both `build` and compose generation (§9), which must agree.

`claude-and` also carries a SHARED dependency cache: `GRADLE_USER_HOME` is
`/cache/gradle`, a named volume (`cproj-gradle-cache`) mounted into every
android dev container rather than a directory under the project's bind mount.
The Android Gradle Plugin and its transitive dependencies are hundreds of
megabytes of rebuildable data that is identical for every project, so it is kept
once, on the internal disk beside the image layers, and off the SSD. Declared in
`cli/src/images.ts` (`IMAGE_CACHE`) and read by compose generation (§9), `up`
(which creates the volume) and the volume scan (§6), which treats it as claimed
while any project's manifest names that base image.

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

## 6. Command surface

All commands accept `--json`. `<name>` is a project; `<svc>` a catalogue key.

### Projects
- `cproj new <name> --archetype <a> [--services a,b]`
  Creates dir, manifest, compose, `.gitignore`, `.dockerignore`, `CLAUDE.md`.
  Assigns ports for any initial services. Errors: `SSD_NOT_MOUNTED`,
  `PROJECT_EXISTS`.
- `cproj list` — array of projects with archetype + running state.
- `cproj status [<name>]` — full status object(s) (see §7). No arg = all.
- `cproj up <name> [--no-shell]`
  Brings the project up (app dev container + attached services on one network).
  Validates ports. By default the app-layer opens a shell after; `--no-shell`
  suppresses the app's shell-open (the CLI itself doesn't spawn terminals — it
  reports the exec command; see §6 shell).
- `cproj down <name>` — stop + remove this project's containers. Data persists.
- `cproj delete <name>` — remove containers, then the project dir. Prompts unless
  `--force`. Releases the project's ports. Named volumes: see `--keep-data`
  (default) vs `--purge` (also removes this project's volumes).

### Services
- `cproj service add <project> <svc>` — attach; assign host port; regenerate
  compose. Errors `PROJECT_RUNNING`, `SERVICE_ATTACHED`, `SERVICE_UNKNOWN`.
- `cproj service remove <project> <svc>` — detach; regenerate compose; **keep the
  volume** (it becomes an orphan). Release the host port. Errors
  `PROJECT_RUNNING`, `SERVICE_NOT_ATTACHED`.
- `cproj service list <project>` — attached services + resolved host ports.

### Shell
- `cproj shell <name> [--print]`
  For a running project, resolves the dev container and returns the exec
  invocation. With `--json`, returns `{ "container": "...", "exec": ["docker",
  "exec","-it","<c>","bash"] }`. The **app** spawns the terminal; the CLI names
  the command. `--print` (human mode) prints the command to run. Errors
  `PROJECT_STOPPED`.

### Volumes / disk
- `cproj volumes orphaned` — array of `{ name, size_bytes, size_human,
  last_project }` for volumes not referenced by any current compose file.
- `cproj volumes rm <name>` — remove one orphaned volume (confirm unless
  `--force`). Errors `VOLUME_IN_USE` if still referenced.

### Lifecycle / SSD
- `cproj down-all` — stop + remove all cproj containers.
- `cproj eject` — `down-all`, then check host holders (Xcode, Simulator, shells
  cd'd into the SSD via `lsof`), then `diskutil eject`. If held, fail
  `EJECT_BLOCKED` with `{ holders: [...] }` and do not force.
- `cproj doctor` — environment check: Docker running, SSD mounted, base images
  present, catalogue valid. Returns structured findings. (Useful first call for
  the app on launch.)

### Images
- `cproj build [--archetype <a>]` — build base image(s) with host UID/GID build
  args. No arg builds all archetypes' bases.

### App support

Added in Phase 6 under §1 ("if the app needs something, a CLI command grows to
provide it"), not part of the original surface. Additive: no existing schema
changed to accommodate them.

- `cproj catalogue` — every service type the catalogue defines, with its image,
  container port and host-port band, plus the `services.yml` that answered and
  which step of §4.1's chain it came from. The app's Services submenu and
  New-project window render this rather than keeping a copy of the catalogue.
  Reports the BAND START only; an assigned port comes from a manifest.
  Errors: `CONFIG_INVALID`.
- `cproj config get` — the effective configuration (§8): defaults, then the
  file, then the environment, plus the file path and which env vars overrode a
  value. Errors: `CONFIG_INVALID`.
- `cproj config set <key> <value>` — set one §8 key; an empty value clears it.
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
      "dev_container": "cproj-myapp"    // null if stopped
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

- Config file `~/.config/cproj/config.yml` (internal disk — must be readable when
  SSD is absent, so `doctor`/`status` can report "SSD not mounted").
  Keys: `ssd_root`, `ssd_volume`, `catalogue_path`, `terminal` (for the app's
  shell-open preference, surfaced here for a single source).
- CLI reads env overrides `CPROJ_SSD_ROOT`, `CPROJ_SSD_VOLUME`.
- The app never edits this file itself: it reads it with `cproj config get` and
  writes it with `cproj config set`, so precedence, path expansion and the
  "`ssd_root` defaults inside `ssd_volume`" rule have one implementation.

## 9. Compose generation rules

- Generated file is deterministic and idempotent for a given manifest (stable
  ordering, so regeneration produces no spurious diffs).
- One user-defined network per project; services + dev container attached.
- Dev container: base image for the archetype, bind-mount project dir → `/work`,
  `sleep infinity`; plus `platform:` when the archetype's base image is pinned
  to one architecture (§4.3), so it starts the way `build` built it. The key is
  absent otherwise — an unpinned project's generated file must not change.
- Dev container, cont.: plus the base image's shared toolchain cache volume
  (§4.3) when it declares one, mounted at the image's own path. It is declared
  `external: true` so Compose neither creates nor claims a volume every project
  on that image shares — `up` creates it, labelled `cproj.role: cache`. Both
  keys are absent for an image with no cache, for the same reason `platform:`
  is: an existing project's generated file must not change.
- Services: image from catalogue, named volume, `host_port:container_port`
  published, env interpolated (`{project}` → name).
- Never publish the dev container's own ports unless an archetype needs it
  (web/next dev server: publish an allocated app port too — treat the web app's
  dev-server port as a service-like allocation so multiple web projects don't
  clash).

## 10. Seeded files (by `new`)

- `.gitignore` — `.build/ .swiftpm/ DerivedData/ node_modules/`
  (archetype-tuned).
- `.dockerignore` — excludes `node_modules`, build output, `.git`,
  DerivedData, so image builds/context stays small (serves the disk goal).
- `CLAUDE.md` — archetype-specific, references the boundary rules (host vs
  container build).

## 11. Testing expectations

- The full lifecycle is drivable and assertable from the terminal with `--json`
  before any app work: new → add service → up → shell command resolves → status
  shows ports → down → remove service → orphan appears → reclaim → delete →
  eject (holder-blocked and clear paths).
- Port allocation has unit coverage: uniqueness, stability across restart,
  band assignment, host-squat detection.
