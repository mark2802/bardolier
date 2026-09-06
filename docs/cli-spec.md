# CLI Spec — `bardolier` (Container Project Manager engine)

Status: draft for implementation. This is the **engine**. The menu-bar app is a
thin client over this CLI. **The CLI is the API; the app is a thin client.** All
orchestration lives here; the app only calls commands and renders their JSON.

Companion docs: `app-spec.md` (the client), `CLAUDE.md` (how to work here, the
environment boundary, the code map), `../INTENT.md` (the owner's invariants —
this spec must not contradict them).

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
  `PROJECT_EXISTS`, `PROJECT_NOT_FOUND`, `PROJECT_AMBIGUOUS`, `PROJECT_RUNNING`,
  `PROJECT_STOPPED`, `PROJECT_HAS_DATA`, `SERVICE_UNKNOWN`, `SERVICE_ATTACHED`,
  `SERVICE_NOT_ATTACHED`,
  `EXTRA_PORT_ATTACHED`, `EXTRA_PORT_NOT_ATTACHED`,
  `PACKAGE_ATTACHED`, `PACKAGE_NOT_ATTACHED`,
  `PORT_UNAVAILABLE`, `VOLUME_IN_USE`, `EJECT_BLOCKED`, `EJECT_NOT_APPLICABLE`,
  `ROOT_UNREADABLE`, `DOCKER_UNAVAILABLE`.
- **No partial mutation of a running project:** service add/remove, port
  add/remove and deps add/remove require the project stopped and fail
  `PROJECT_RUNNING` otherwise.
- **Idempotency:** `up` on a running project is a no-op success; `down` on a
  stopped project is a no-op success.
- **Read-only commands never mutate.** `status`, `list`, `volumes orphaned`.
- The CLI reads `roots` from config (see §8); `$BARDOLIER_ROOT` overrides the
  whole list with a single root.

## 3. On-disk layout

Projects live in more than one **root** at once — typically an
internal-disk root and an external SSD root; the CLI treats every configured
root the same way. Each root:

```
<root>/                            # e.g. /Volumes/ssd/claude-projects
  <project>/
    project.yml                    # manifest (source of truth per project)
    docker-compose.yml             # GENERATED from project.yml — never hand-edit
    .bardolier/                    # handoff.md (§12)
    work/    → /work               repositories, cloned or inited by the user
    data/    → /data:ro            service data, one directory per attached service
    local/   → /local              neither repository nor service data
    home/    → /state/home         the dev container's $HOME
    work/CLAUDE.md                 # seeded, archetype-specific boundary (§10)
```

- **A project directory is not a repository.** bardolier's files sit
  above the four folders and inside no working tree: nothing to gitignore, and
  `git clean -xdf` in a repo under `work/` cannot reach `data/`.
- The four are created by `new` and re-ensured by every `up`. Docker would
  otherwise create a missing bind source itself, as root, leaving `home/`
  unwritable by the container's own uid.
- `data/.metadata_never_index` keeps Spotlight off a multi-GB database, and so
  `mds` off the volume — one less holder for `eject` to filter (§6).
- **Service data is a bind mount, not a named volume.** A named volume lives in
  `Docker.raw` on the internal disk however external the root is: the disk with
  the least room holding the data that grows fastest. Bind-mounted from an APFS
  external SSD (`noowners`), Postgres 17 and Mongo 7 initialise clean; steady
  state is 0.69x native writes and 0.88x reads, bulk load 0.34x — the one
  visible penalty.
- `roots` is an ordered array of `{ name, path }` (§8); `roots[0]` is the default
  `new` targets. A project name is unique across **every** root, not within one:
  two roots each holding an `api` would collide on the container name and the
  home volume, both global to Docker.
- Docker's image/layer store stays on the internal disk, as do the shared
  toolchain caches (§4.3) — rebuildable bytes every project shares. Project data
  lives under a root, inside the project directory that owns it.

## 4. Data model

### 4.1 Service catalogue — `services.yml`

Single editable file (location in config; default `<default root>/services.yml`
— the default root only, never per-root — falling back to
a bundled default). Adding a service type = adding an entry, no code change.
There is no `volume` key: a service's data directory is its catalogue KEY, under
the project's own `data/` (§3).

```yaml
services:
  postgres:
    display: "PostgreSQL"
    image: "postgres:17"
    container_port: 5432        # fixed port inside the container/network
    host_port_base: 5432        # start of this service's host-port band
    mount: "/var/lib/postgresql/data"   # where <project>/data/postgres binds
    env:
      POSTGRES_PASSWORD: "dev"
      POSTGRES_DB: "{project}"
  redis:
    display: "Redis"
    image: "redis:7"
    container_port: 6379
    host_port_base: 6379
    mount: "/data"
  mongo:
    display: "MongoDB"
    image: "mongo:7"
    container_port: 27017
    host_port_base: 27017
    mount: "/data/db"
```

### 4.2 Project manifest — `project.yml`

Source of truth for one project. The compose file is derived from this.

```yaml
name: myapp
archetype: web            # web | ios | android | library
base_image: bardolier-web    # resolved from archetype
extra_packages:            # OS packages beyond base_image; absent/empty = none
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

That boundary is built into the images: the ios base ships no `xcodebuild`,
`xcrun` or simulator, the android base no `adb`, so a host-only step cannot be
attempted in a container by mistake.

Every base image also carries **Claude Code** — the agent the whole tool exists
to host, installed as a standalone binary on a system path rather than under
`$HOME`, which is a mounted directory (§3, §9) — and the working kit (git,
ripgrep, jq, curl). Versions: §6, Images.

**`bardolier-and` is built and run as `linux/amd64`.** Google publishes the Linux
Android SDK build tools (aapt2 above all) for x86_64 only, so on Apple Silicon
that one image runs emulated. The pin lives in `cli/src/images.ts` and is read by
both `build` and compose generation (§9), which must agree.

**Shared toolchain caches.** `bardolier-and` sets `GRADLE_USER_HOME=/cache/gradle`,
a named volume (`bardolier-gradle-cache`); `bardolier-web` sets
`UV_CACHE_DIR=/cache/uv`, volume `bardolier-uv-cache`, for the Python toolchain it
gained so an API and its React frontend run in one dev container. `library`
shares the web image and its cache. Hundreds of megabytes of identical,
re-downloadable dependencies belong once, on the internal disk beside the image
layers — not per project on the SSD. Declared as `IMAGE_CACHE` in
`cli/src/images.ts` and read by compose generation (§9), `up` (which creates the
volume) and the volume scan (§6), which treats a cache as claimed while any
manifest names its base image.

## 5. Port allocation (first-class)

Requirements, in priority order:
1. **Unique** across all projects and services in **every** root — a
   project's root is otherwise invisible to whoever reads a connection string.
2. **Stable** — assigned once at service-add, persisted in `project.yml`, never
   reassigned on restart. Released only on service-remove or project-delete.
3. **Host-exposed** — every service publishes its `host_port`, so GUI debuggers
   (TablePlus, Postico, RedisInsight) can connect.
4. **Readable bands** — allocated within the service's `host_port_base`
   (postgres 5432→5433→5434…, redis 6379→6380…).

At service-add:
1. Read the service's base port from the catalogue.
2. Scan every project's `project.yml` in **every** configured root for assigned
   ports — the manifests are the only registry, so there is nothing to desync. A
   root that cannot be read refuses the scan (`ROOT_UNREADABLE`) rather than
   allocating from a partial view: an unreadable root's assignments are
   unknowable, and handing one out is no different from never having scanned.
3. From `host_port_base` upward, take the first port both unassigned in any
   manifest and unbound on the host (probe the socket).
4. Persist it in this project's manifest.

Adding a root re-allocates nothing: uniqueness is enforced going forward, and a
collision between two previously separate roots is a `doctor` finding, not a
silent repair.

At `up`, every recorded `host_port` is re-validated as bindable. One squatted
while the project was down fails `PORT_UNAVAILABLE` naming it — never a silent
remap, which would break the user's saved connection strings.

The dev app reaches services over the Docker network by name (`postgres:5432`),
as in prod. The host port is a debugging tap; `CLAUDE.md` states this so the
agent never wires the app to `localhost`.

### 5.1 Extra ports (named, archetype-independent)

A **named** port published from the dev container, independent of archetype —
`extra_ports` in `project.yml`. Unlike `app_port` (§9) it is not fixed by the
archetype; unlike a service it has no catalogue entry, image or data directory.
Two needs, one mechanism: a mobile client or a second UI app that must reach the
project's own process directly, and a browser-reachable dev tool (a notebook
server, a debugger UI) on `library`/`ios`/`android`, which otherwise publish
nothing at all.

- `bardolier port add <project> <name> --container-port <n>` — the caller states
  the container side and the allocator searches upward from that number, there
  being no catalogue band to start from. Persisted as
  `extra_ports.<name>.{container_port,host_port}`; assigned once and stable for
  life, like any port in §5. `port remove` releases it, `port list` reports what
  is declared (§6). Both require the project stopped.
- Compose publishes them from the dev container after `app_port`, sorted by name
  (§9's determinism rule). `status` and `up` report `extra_ports`, each with a
  ready-to-open `url` (`http://localhost:<host_port>`) — the same reason a
  service carries `connection_hint`: the app renders the string, it never
  composes one.

## 6. Command surface

All commands accept `--json`. `<name>` is a project; `<svc>` a catalogue key.

### Projects
- `bardolier new <name> --archetype <a> [--services a,b] [--root <name>]`
  Creates dir, manifest, compose, the four folders of §3, and
  `work/CLAUDE.md`, under the named root (default: the first configured root
  — §8).
  Assigns ports for any initial services. Errors: `ROOT_UNREADABLE` (the
  target root, or another root the port allocation cannot see past),
  `PROJECT_EXISTS` (in any root), `PROJECT_AMBIGUOUS`, `INVALID_ARGUMENT`
  (unknown `--root`, naming the configured roots).
- `bardolier list` — array of projects with archetype + running state + root

- `bardolier status [<name>]` — full status object(s) (see §7). No arg = all.
  A name found in more than one root is `PROJECT_AMBIGUOUS`.
- `bardolier up <name> [--no-shell]`
  Brings the project up (app dev container + attached services on one network).
  Validates ports. By default the app-layer opens a shell after; `--no-shell`
  suppresses the app's shell-open (the CLI itself doesn't spawn terminals — it
  reports the exec command; see §6 shell).
- `bardolier down <name> [--no-handoff]` — stop + remove this project's containers.
  Data persists. Writes the handoff note first (§12) unless `--no-handoff`.
- `bardolier delete <name> [--force] [--purge]` — remove containers, then the
  project dir. Prompts unless `--force`. Releases the project's ports. The
  project's data is INSIDE the directory (§3), so removing the directory
  destroys it and "keep the data" cannot mean anything — there is no
  `--keep-data`. A project whose `data/` or `home/` holds anything fails
  `PROJECT_HAS_DATA`, naming what would go and its size; `--purge` is the only
  way through. `--force` governs the prompt, never the data.

### Services
- `bardolier service add <project> <svc>` — attach; assign host port; regenerate
  compose. Errors `PROJECT_RUNNING`, `SERVICE_ATTACHED`, `SERVICE_UNKNOWN`.
- `bardolier service remove <project> <svc>` — detach; regenerate compose; **keep
  `data/<svc>`** (it becomes an orphan of this project). Release the host port.
  Errors `PROJECT_RUNNING`, `SERVICE_NOT_ATTACHED`.
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
- `bardolier shell <name> [--print] [--root]` — for a running project, resolves the
  dev container and returns the exec invocation: `{ "container": "...", "exec":
  ["docker","exec","-it","<c>","bash"] }`. The **app** spawns the terminal; the
  CLI only names the command (`--print` prints it in human mode). Errors
  `PROJECT_STOPPED`.
  `--root` swaps in `["docker","exec","-u","root","-it","<c>","bash"]` — same
  container, same checks, one argv difference. It is ephemeral: nothing installed
  while root survives a `down`. Anything meant to persist belongs in
  `extra_packages` (Deps, above).

### Volumes / disk
- `bardolier volumes orphaned` — array of `{ name, kind, path, size_bytes,
  size_human, last_project }` for everything ours nothing claims. Two `kind`s
  a `directory` under some project's `data/` whose key its manifest
  no longer attaches — named `<project>/<key>`, needing only that one root
  readable, with no labels and no cross-root reasoning — and a named `volume`,
  now only the shared toolchain caches plus whatever an older layout left
  behind. Errors `SSD_NOT_MOUNTED` (no root readable at all) and
  `ROOT_UNREADABLE` (some, but not all, roots readable — a partial view is
  refused rather than calling another root's cache orphaned).
- `bardolier volumes rm <name>` — reclaim one orphan of either kind, by its name
  or (for a directory) its path; confirm unless `--force`. Errors
  `VOLUME_IN_USE` if still claimed.

### Lifecycle / SSD
- `bardolier down-all` — stop + remove all bardolier containers, across every root.
  Containers don't belong to a root, so this stays global.
- `bardolier eject [<root>]` — the volume is derived from the named root's path
  (the last ancestor directory sharing its `st_dev`); there is no
  `ssd_volume` key that could disagree with it. `[<root>]` may be omitted only
  when exactly one configured root is a mounted, removable volume
  (`diskutil info -plist`); otherwise its absence is `INVALID_ARGUMENT` naming
  every configured root.
  - **Not removable → `EJECT_NOT_APPLICABLE`, immediately**, before anything is
    stopped, naming `bardolier down-all` as the command to run instead. A root on
    the internal disk is a first-class mode (§8), and `diskutil eject`-ing `/`
    is not a smaller version of ejecting — it is the wrong command.
  - Otherwise: `down-all` → host holders (`lsof`) → `diskutil eject`. Held
    means `EJECT_BLOCKED` with `{ holders: [...] }`. **Never forced.**
  - **A holder is something the user can act on.** The container runtime and the
    OS volume agents — `mds`/`mds_stores` above all, which map an indexed volume
    for as long as it is mounted — are excluded, because counting them makes the
    command refuse forever with nothing to quit. They are DiskArbitration
    clients, so the `diskutil eject` that follows is itself the request to let
    go; a dissenter's PID and name are parsed out of the refusal into the same
    `holders` array, reduced to its last path component first (recent macOS
    reports a full executable path). A blocked eject therefore always names
    something, including root processes unprivileged `lsof` cannot see.
  - **The runtime has a third answer.** Docker Desktop shares `/Volumes` into
    its VM and holds descriptors for as long as that VM lives: nothing to quit,
    no retry that works. When that alone refused, `eject` offers to stop the
    engine (`docker desktop stop`) and try again — via `--stop-docker` or the
    prompt. Declining is `EJECT_BLOCKED`, `reason: "runtime-holds-volume"`, the
    runtime named in `holders`, and the command to run. Success reports
    `docker_stopped`. Not a force: nothing is unmounted from under anything, and
    `docker desktop start` puts the engine back.
  - **Then wait for the signal, not the command.** `docker desktop stop` returns
    before the VM helper holding `/Volumes` is torn down, so `eject` polls `lsof`
    until the runtime is off the volume (bounded, 15s), unmounts, and retries a
    runtime dissent a couple more times. A spent budget is `EJECT_BLOCKED`,
    `reason: "runtime-holds-volume-after-stop"` — no engine left to stop, so it
    never re-advises the flag just used. If the runtime has let go and the
    unmount still fails, that refusal is somebody else's and is relayed as it
    came.
- `bardolier doctor` — environment check: Docker running, every configured root's
  readable state (the `ssd` finding, id frozen — `ok` is false only when *none*
  is readable), base images present, catalogue valid. Structured findings; a
  useful first call for the app on launch. The `ssd` finding carries a `roots`
  array with per-root `mounted`/`removable` (null when unmounted — nothing to
  ask `diskutil`), so the app can tell an actual SSD from an internal-disk root
  instead of calling both "SSD".

### Roots

`roots` is list-valued (§8), which `config set` cannot edit — the same reason
`catalogue` and `config get|set` got their own commands.

- `bardolier root add <path> [--name <name>]` — register a root; `--name` defaults
  to the path's basename. Names and paths must each be unique across the list.
  Errors: `INVALID_ARGUMENT` (unusable name), `CONFIG_INVALID` (collision).
- `bardolier root remove <name>` — forget a root. Never touches the directory or
  anything in it: bookkeeping, not deletion. `roots` is never empty (§8), so
  removing the only configured root is refused rather than silently
  rematerialising the built-in default in its place — add a replacement first.
  Errors: `INVALID_ARGUMENT` (unknown name, or the only root).
- `bardolier root list` — every configured root, in order, with whether it is
  currently readable. `roots[0]` is the default `new` targets.

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

Commands that exist because the app asked, under §1 ("if the app needs
something, a CLI command grows to provide it"). Additive: no existing schema
changed to accommodate them.

- `bardolier catalogue` — every service type the catalogue defines, with image,
  container port and host-port BAND START (an assigned port comes from a
  manifest), plus which `services.yml` answered and which step of §4.1's chain it
  came from. The app's Services submenu and New-project window render this
  instead of keeping a copy of the catalogue. Errors: `CONFIG_INVALID`.
- `bardolier config get` — the effective configuration (§8): defaults, then file,
  then environment, plus the file path and which env vars overrode a value.
  Errors: `CONFIG_INVALID`.
- `bardolier config set <key> <value>` — set one single-valued §8 key
  (`catalogue_path`, `terminal`); an empty value clears it. Paths are expanded on
  the way in, keys written in a stable order, and the effective config reported
  after the write. Never validates that a path exists — a root is routinely
  absent, and refusing to record where it will be would make the setting
  unusable exactly when it is needed. `roots` is list-valued: see Roots, above.
  Errors: `INVALID_ARGUMENT`, `CONFIG_INVALID`.

## 7. `status` JSON schema (the app's primary contract)

```json
{
  "ssd": { "mounted": true, "root": "/Volumes/ssd/claude-projects" }, // default root's path (roots[0])
  "roots": [                          // every configured root; additive
    { "name": "ssd", "path": "/Volumes/ssd/claude-projects", "mounted": true }
  ],
  "docker": { "available": true },
  "projects": [
    {
      "name": "myapp",
      "archetype": "web",
      "state": "running",              // running | stopped | partial
      "root": "ssd",                    // configured root's name; additive
      "work_dir": "/Volumes/ssd/claude-projects/myapp/work", // §3; additive
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
  "orphaned_volumes": [                 // kind/path are additive; older clients ignore them
    { "name": "oldapp/postgres", "kind": "directory",
      "path": "/Volumes/ssd/claude-projects/oldapp/data/postgres",
      "size_bytes": 20971520, "size_human": "20 MB", "last_project": "oldapp" }
  ]
}
```

Schema stability is the contract. Additive changes only once the app ships.

## 8. Configuration

- `~/.config/bardolier/config.yml`, on the internal disk — it must be readable
  when every root is absent, so `doctor`/`status` can say so. Keys: `roots`
  (§3 — ordered `{ name, path }`, `roots[0]` the default `new` targets, names
  and paths each unique), `catalogue_path`, `terminal` (the app's shell-open
  preference, kept here for a single source).
- No `ssd_volume` key: a root's mount point is derived from its
  `path` by walking `st_dev` boundaries, so the two can never disagree.
- `$BARDOLIER_ROOT` REPLACES `roots` wholesale
  with a single root named after the path's basename — one variable, so a
  done-check stays hermetic with a temp dir.
- `roots` is list-valued and not settable through `config set`; see
  `bardolier root add | remove | list` (§6). The app never edits the file itself,
  so precedence and path expansion have one implementation.
- **A root's path may be any local directory** — an external SSD is not
  required, and the default when nothing is configured is one root at
  `~/bardolier-projects`, since a published tool must not assume `/Volumes/ssd`
  exists. Only `eject` assumes a removable volume, and it is simply unavailable
  (`EJECT_NOT_APPLICABLE`) otherwise; `down-all` is the equivalent in that mode.

## 9. Compose generation rules

- **Deterministic and idempotent** for a given manifest (stable ordering, no
  spurious diffs). Rendered on every `new`, `up` and service/port/deps change —
  never patched, and never read back for facts, so a hand edit is lost rather
  than honoured. Writes go through `workspace.ts`, which skips a write whose
  bytes already match the file on disk: determinism made observable.
- One user-defined network per project; services and dev container attached.
- **Image selection**: the dev container's `image:` is
  `<base_image>:latest` when `extra_packages` is empty, else the
  content-addressed `bardolier-deps-<base_image>:<hash>`, `hash` being a short
  sha256 of the base image plus the sorted package list — so two projects
  declaring the same pair resolve to one tag and share one build (`deps.ts`).
  `up` builds it before `docker compose up`; Compose references a local tag and
  never builds one itself.
- **Four RELATIVE binds on the dev container** — resolved against the compose
  file's own directory, so the file holds no absolute path and the project stays
  a self-contained, relocatable folder: `./work` → `/work` (also `working_dir`),
  `./data` → `/data` **read-only**, `./local` → `/local`, `./home` →
  `CONTAINER_HOME`. Plus `sleep infinity`. `/data` is read-only because writing
  a live data directory from a second container corrupts it; the service that
  owns one mounts the same bytes read-write.
- `platform:` only when the archetype's base image is pinned to one architecture
  (§4.3), so it starts the way `build` built it. The shared cache volume only
  when the image declares one (§4.3), mounted at the image's own path and
  declared `external: true` — Compose must neither create nor claim what every
  project on that image shares; `up` creates it, labelled `bardolier.role: cache`.
  Both keys are absent otherwise: an existing project's file must not change.
- **`$HOME` is the `./home` bind**, at the images' shared `CONTAINER_HOME`.
  `down` removes the container, so a home in its writable layer would lose the
  shell history, the dotfiles and the agent's login on every stop. It is PER
  PROJECT, not shared like the toolchain cache: Claude Code files its sessions by
  working directory and every dev container works in `/work`, so one shared home
  would make `claude --continue` resume whichever project ran last. Being inside
  the project directory attributes it — no label, and `delete` takes it with the
  folder.
- **`environment:` in Compose's LIST form**, naming the host variables the
  container may inherit (the agent's credentials, git's identity). A bare name
  (no `=`) passes a value through when the environment running `compose up` has
  one and leaves it UNSET otherwise; `${NAME:-}` would inject an empty
  credential — a failing login instead of a prompt. Fixed and sorted, so the
  file is byte-identical on a Mac holding every token and one holding none. `up`
  fills the `GIT_*` names from the host's own `git config`, so a commit made in
  the container is attributed to the human rather than failing on an unset
  `user.email`.
- **Services**: image from the catalogue, `./data/<catalogue key>` bound at the
  catalogue's `mount`, `host_port:container_port` published, env interpolated
  (`{project}` → name).
- The top-level `volumes:` block is therefore the shared toolchain cache and
  nothing else, absent entirely for an image that declares none. A project owns
  no named volume.
- **The dev container publishes only its archetype's dev server**
  (`ARCHETYPE_APP_PORT`; `web` → 3000) plus any extra ports declared on it
  (§5.1). `app_port` is a service-like allocation: fixed inside the container so
  every project's server config is identical, allocated from a host band so two
  web projects cannot clash, assigned once and persisted (§5), with `PORT` set to
  the fixed side. A project predating the field is assigned one on its next `up`,
  the only moment its manifest is being written anyway. These are the only
  exceptions to "a host port is a debugging tap": a browser on the Mac, or a
  native client outside the project, cannot join the Docker network. Extra ports
  get no such retrofit — `port add` writes both sides at once — and publish after
  `app_port`, sorted by name.

## 10. Seeded files (by `new`)

One file, `work/CLAUDE.md`: archetype-specific, describing where the agent is
(§3's layout, `/data` read-only), the host-vs-container boundary, and — for an
archetype with a dev server (§9) — the instruction to bind `0.0.0.0` rather than
`localhost`, since a server on the container's own loopback is unreachable from
the Mac and looks like a broken port mapping. It goes in `work/` because that is
the agent's working directory, and because a repository cloned in beside it then
never contains it.

No `.gitignore` and no `.dockerignore`: there is no repo root to seed
— bardolier's files sit above `work/`, inside no working tree — and nothing takes
a build context from a project directory (`deps.ts` builds from a generated
context under the config dir).

## 11. Testing expectations

- The full lifecycle is drivable and assertable from the terminal with `--json`
  before any app work: new → add service → up → shell command resolves → status
  shows ports → down → remove service → orphan appears → reclaim → delete →
  eject (holder-blocked and clear paths).
- Port allocation has unit coverage: uniqueness, stability across restart,
  band assignment, host-squat detection.
- **Checks are named for what they cover, not for when they were written.**
  `test/<name>-done-check.sh` drives one function from the terminal — services,
  ports, eject, roots, images — each building its own temp root and config, so
  it runs alone and in any order; `test/regression.sh` runs them all, cheapest
  first. The TypeScript suites in `test/<name>.test.ts` mirror the same split.

## 12. The handoff note (by `down`)

A project resumed after three weeks is a project whose state has been forgotten.
`down` is the one moment when everything needed to describe that state is still
true and still reachable, so the note is written there, into
`<project>/.bardolier/handoff.md`, and nowhere else.

- **Two sources, failing independently.** The repositories, via `git` on the
  host: `work/` may hold several (§3), so every direct subdirectory that is a
  working tree is reported — branch, recent commits, what is uncommitted — and a
  project with none says so. And the agent's own account, via
  `claude --print --continue` run INSIDE the dev container, the half that knows
  what was being
  *attempted*; no git archaeology recovers that.
- **Written before `compose down`.** The session lives in the dev container and
  dies with it; asking afterwards is asking nobody. `--continue` resolves
  correctly only because each project has its own `$HOME` (§9).
- **Best-effort is the contract.** No container, no agent, no session, no
  credentials, a timeout, a read-only disk: each degrades the note or skips it,
  and none fails the `down` — a stop that refused because it could not write a
  memo would be worse than a tool that never wrote memos. A non-zero exit or
  empty output is reported as such, not pasted under the heading as a summary.
- **Appended, newest at the bottom; never rewritten or dropped.** A quiet "just
  said hello" session must not destroy a substantive entry above it, and
  `.bardolier/` sits above `work/`, inside no repository (§3), so there is no git
  history underneath to fall back on.
- `--no-handoff` skips it. `delete` always passes it — there is no point
  summarising a project a second before its directory is removed.
