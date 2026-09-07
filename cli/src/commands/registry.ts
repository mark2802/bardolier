/**
 * The command surface — cli-spec.md §6, complete.
 *
 * Phase 0 declared the whole surface so `bardolier --help` is the contract you can
 * read from the terminal. Each command records the error codes §6 says it can
 * raise, so help output and the app's error mapping (app-spec.md §13) are
 * driven off one declaration rather than drifting apart.
 *
 * Commands land phase by phase — Phase 1 the read-only core, Phase 2 the
 * project lifecycle, Phase 3 services and port allocation, Phase 4 shell,
 * volumes, down-all and eject. Nothing else about a command's declaration
 * changes when one is implemented: the usage, flags and error codes are the
 * frozen part.
 *
 * Every `run` here is a thin adapter: validate the shape of the invocation,
 * build a Context, call the command module, pair the payload with its human
 * renderer. Behaviour lives in the command modules, never in this file.
 */

import type { ErrorCode } from '../errors.ts'
import { BardolierError, notImplemented } from '../errors.ts'
import { createContext } from '../context.ts'
import { flagKey } from '../argv.ts'
import { collectStatus, renderStatus } from './status.ts'
import { collectList, renderList } from './list.ts'
import { collectDoctor, renderDoctor } from './doctor.ts'
import { collectCatalogue, renderCatalogue } from './catalogue.ts'
import { collectConfigGet, renderConfigGet, renderConfigSet, runConfigSet } from './config.ts'
import { renderNew, runNew } from './new.ts'
import { renderUp, runUp } from './up.ts'
import { renderDown, runDown } from './down.ts'
import { renderDelete, runDelete } from './delete.ts'
import { renderBuild, runBuild } from './build.ts'
import { renderShell, renderShellPrint, runShell } from './shell.ts'
import {
  collectOrphanedVolumes,
  renderOrphanedVolumes,
  renderVolumeRemove,
  runVolumeRemove,
} from './volumes.ts'
import { renderDownAll, renderEject, renderEjectAll, runDownAll, runEject, runEjectAll } from './ssd.ts'
import {
  collectServiceList,
  renderServiceAdd,
  renderServiceList,
  renderServiceRemove,
  runServiceAdd,
  runServiceRemove,
} from './service.ts'
import { collectPortList, renderPortAdd, renderPortList, renderPortRemove, runPortAdd, runPortRemove } from './port.ts'
import { collectDepsList, renderDepsAdd, renderDepsList, renderDepsRemove, runDepsAdd, runDepsRemove } from './deps.ts'
import { collectRootList, renderRootAdd, renderRootList, renderRootRemove, runRootAdd, runRootRemove } from './root.ts'

export const COMMAND_GROUPS = ['Projects', 'Services', 'Ports', 'Deps', 'Shell', 'Volumes / disk', 'Lifecycle / SSD', 'Roots', 'Images'] as const
export type CommandGroup = (typeof COMMAND_GROUPS)[number]

export type FlagSpec = {
  /** Canonical form, e.g. `--archetype`. */
  readonly name: string
  /** Placeholder when the flag takes a value, e.g. `<a>`. Absent = boolean flag. */
  readonly arg?: string
  readonly description: string
}

/** `--archetype <a>` for help output; `--force` for a boolean flag. */
export function flagLabel(flag: FlagSpec): string {
  return flag.arg ? `${flag.name} ${flag.arg}` : flag.name
}

/**
 * What a command produces. `json` is the app-facing payload; `human` renders
 * the same payload for a terminal. Two renderers, one payload — the app never
 * parses human output (cli-spec.md §2).
 */
export type CommandOutput<T = unknown> = {
  readonly json: T
  readonly human: (json: T) => string[]
}

export type Invocation = {
  /** Positional arguments after the command path. */
  readonly args: readonly string[]
  /** Flags present on the invocation, e.g. `{ force: true, archetype: 'web' }`. */
  readonly flags: Readonly<Record<string, string | boolean>>
  /**
   * Whether `--json` was given. A command must not RENDER differently for it —
   * that is main.ts's job — but a command that would otherwise prompt has to
   * know there is no one to ask (`delete`, §2).
   */
  readonly json: boolean
}

export type CommandNode = {
  /** Path segments, e.g. `['service', 'add']`. */
  readonly path: readonly string[]
  readonly group: CommandGroup
  /** Full usage line including positionals and flags. */
  readonly usage: string
  readonly summary: string
  readonly flags: readonly FlagSpec[]
  /** Error codes cli-spec.md §6 attributes to this command. */
  readonly errors: readonly ErrorCode[]
  readonly run: (inv: Invocation) => CommandOutput | Promise<CommandOutput>
  /** Present on grouping commands (`service`, `volumes`). */
  readonly children?: readonly CommandNode[]
}

/**
 * Pair a payload with its human renderer. The cast is contained here so a
 * command can keep a precisely typed renderer while the registry stays generic.
 */
export function output<T>(json: T, human: (value: T) => string[]): CommandOutput {
  return { json, human: (value) => human(value as T) }
}

/** Reject stray positionals rather than ignoring them (§2, INVALID_ARGUMENT). */
function atMostOneArg(inv: Invocation, command: string, placeholder: string): string | null {
  if (inv.args.length > 1) {
    throw new BardolierError('INVALID_ARGUMENT', `\`bardolier ${command}\` takes at most one ${placeholder}.`)
  }
  return inv.args[0] ?? null
}

/** Exactly `count` positionals, or INVALID_ARGUMENT naming the usage. */
function exactArgs(inv: Invocation, command: CommandNode, count: number): string[] {
  if (inv.args.length !== count) {
    throw new BardolierError('INVALID_ARGUMENT', `Usage: bardolier ${command.usage}`)
  }
  return [...inv.args]
}

/** At least `count` positionals, or INVALID_ARGUMENT naming the usage — `deps add/remove`'s variadic package list. */
function minArgs(inv: Invocation, command: CommandNode, count: number): string[] {
  if (inv.args.length < count) {
    throw new BardolierError('INVALID_ARGUMENT', `Usage: bardolier ${command.usage}`)
  }
  return [...inv.args]
}

/**
 * `name` is the flag's declared form (`--stop-docker`, matching `flags:`
 * below) rather than a hand-typed camelCase key — `flagKey` derives the one
 * `parse()` actually used, so a call site can't drift from its declaration
 * the way `boolFlag(inv, 'stop-docker')` once silently did (it never matched
 * `parse()`'s `stopDocker`, so the flag was always false).
 */
function stringFlag(inv: Invocation, name: string): string | undefined {
  const value = inv.flags[flagKey(name)]
  return typeof value === 'string' ? value : undefined
}

function boolFlag(inv: Invocation, name: string): boolean {
  return inv.flags[flagKey(name)] === true
}

function noArgs(inv: Invocation, command: string): void {
  if (inv.args.length > 0) {
    throw new BardolierError('INVALID_ARGUMENT', `\`bardolier ${command}\` takes no arguments.`)
  }
}

/** Placeholder for grouping nodes, which are never invoked directly. */
function group(name: string): CommandNode['run'] {
  return () => notImplemented(name)
}

const JSON_FLAG: FlagSpec = { name: '--json', description: 'Emit a single JSON value on stdout.' }

export const COMMANDS: readonly CommandNode[] = [
  // ── Projects ───────────────────────────────────────────────────────────────
  {
    path: ['new'],
    group: 'Projects',
    usage: 'new <name> --archetype <a> [--services a,b] [--root <name>]',
    summary: 'Create a project: dir, manifest, compose, work/ data/ local/ home/, work/CLAUDE.md.',
    flags: [
      { name: '--archetype', arg: '<a>', description: 'web | ios | android | library. Required.' },
      { name: '--services', arg: '<a,b>', description: 'Catalogue keys to attach immediately; ports assigned now.' },
      { name: '--root', arg: '<name>', description: 'Which configured root to create it under. Defaults to the first.' },
    ],
    errors: ['ROOT_UNREADABLE', 'PROJECT_EXISTS', 'PROJECT_AMBIGUOUS', 'SERVICE_UNKNOWN', 'PORT_UNAVAILABLE', 'INVALID_ARGUMENT'],
    run: async (inv) => {
      const [name] = exactArgs(inv, byPath('new'), 1)
      const root = stringFlag(inv, '--root')
      return output(
        await runNew(createContext(), {
          name,
          archetype: stringFlag(inv, '--archetype'),
          services: stringFlag(inv, '--services'),
          ...(root !== undefined ? { root } : {}),
        }),
        renderNew,
      )
    },
  },
  {
    path: ['list'],
    group: 'Projects',
    usage: 'list',
    summary: 'List projects with archetype and running state.',
    flags: [],
    errors: ['SSD_NOT_MOUNTED'],
    run: async (inv) => {
      noArgs(inv, 'list')
      return output(await collectList(createContext()), renderList)
    },
  },
  {
    path: ['status'],
    group: 'Projects',
    usage: 'status [<name>]',
    summary: 'Full status object(s) per cli-spec.md §7. No arg = all projects.',
    flags: [],
    errors: ['PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS'],
    run: async (inv) => {
      const name = atMostOneArg(inv, 'status', '<name>')
      return output(await collectStatus(createContext(), name), renderStatus)
    },
  },
  {
    path: ['up'],
    group: 'Projects',
    usage: 'up <name> [--no-shell]',
    summary: 'Bring the dev container and attached services up. Validates ports. Idempotent.',
    flags: [{ name: '--no-shell', description: "Suppress the app's shell-open after start. The CLI never spawns a terminal." }],
    errors: ['SSD_NOT_MOUNTED', 'PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS', 'PORT_UNAVAILABLE', 'ROOT_UNREADABLE', 'DOCKER_UNAVAILABLE'],
    run: async (inv) => {
      const [name] = exactArgs(inv, byPath('up'), 1)
      return output(await runUp(createContext(), { name, noShell: boolFlag(inv, '--no-shell') }), renderUp)
    },
  },
  {
    path: ['down'],
    group: 'Projects',
    usage: 'down <name> [--no-handoff]',
    summary: "Stop and remove the project's containers. Data persists. Idempotent.",
    flags: [
      {
        name: '--no-handoff',
        description: "Skip the handoff note. By default `down` records the repository's state and asks the agent in the dev container to summarise the session before it goes.",
      },
    ],
    errors: ['SSD_NOT_MOUNTED', 'PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS', 'DOCKER_UNAVAILABLE'],
    run: async (inv) => {
      const [name] = exactArgs(inv, byPath('down'), 1)
      return output(await runDown(createContext(), name, { noHandoff: boolFlag(inv, '--no-handoff') }), renderDown)
    },
  },
  {
    path: ['delete'],
    group: 'Projects',
    usage: 'delete <name> [--force] [--purge]',
    summary: 'Remove containers then the project dir. Releases its ports. Prompts unless --force.',
    flags: [
      { name: '--force', description: 'Skip the confirmation prompt.' },
      { name: '--purge', description: "Destroy the project's data (data/ and home/) with it. Required when it holds any." },
    ],
    errors: [
      'SSD_NOT_MOUNTED',
      'PROJECT_NOT_FOUND',
      'PROJECT_AMBIGUOUS',
      'PROJECT_HAS_DATA',
      'DOCKER_UNAVAILABLE',
      'VOLUME_IN_USE',
    ],
    run: async (inv) => {
      const [name] = exactArgs(inv, byPath('delete'), 1)
      return output(
        await runDelete(createContext(), {
          name,
          force: boolFlag(inv, '--force'),
          purge: boolFlag(inv, '--purge'),
          json: inv.json,
        }),
        renderDelete,
      )
    },
  },

  // ── Services ───────────────────────────────────────────────────────────────
  {
    path: ['service'],
    group: 'Services',
    usage: 'service <add | remove | list>',
    summary: 'Attach, detach, and inspect backing services. Add/remove require the project stopped.',
    flags: [],
    errors: [],
    run: group('service'),
    children: [
      {
        path: ['service', 'add'],
        group: 'Services',
        usage: 'service add <project> <svc>',
        summary: 'Attach a service, assign its host port, regenerate compose.',
        flags: [],
        errors: ['PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS', 'PROJECT_RUNNING', 'SERVICE_ATTACHED', 'SERVICE_UNKNOWN', 'PORT_UNAVAILABLE', 'ROOT_UNREADABLE'],
        run: async (inv) => {
          const [project, service] = exactArgs(inv, byPath('service add'), 2)
          return output(await runServiceAdd(createContext(), { project, service }), renderServiceAdd)
        },
      },
      {
        path: ['service', 'remove'],
        group: 'Services',
        usage: 'service remove <project> <svc>',
        summary: 'Detach a service and release its port. KEEPS the volume — it becomes an orphan.',
        flags: [],
        errors: ['PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS', 'PROJECT_RUNNING', 'SERVICE_NOT_ATTACHED'],
        run: async (inv) => {
          const [project, service] = exactArgs(inv, byPath('service remove'), 2)
          return output(await runServiceRemove(createContext(), { project, service }), renderServiceRemove)
        },
      },
      {
        path: ['service', 'list'],
        group: 'Services',
        usage: 'service list <project>',
        summary: 'Attached services with their resolved host ports.',
        flags: [],
        errors: ['PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS'],
        run: (inv) => {
          const [project] = exactArgs(inv, byPath('service list'), 1)
          return output(collectServiceList(createContext(), project), renderServiceList)
        },
      },
    ],
  },

  {
    path: ['catalogue'],
    group: 'Services',
    usage: 'catalogue',
    summary: 'Every service type the catalogue defines, with its image and host-port band.',
    flags: [],
    errors: ['CONFIG_INVALID'],
    run: (inv) => {
      noArgs(inv, 'catalogue')
      return output(collectCatalogue(createContext()), renderCatalogue)
    },
  },

  // ── Ports ──────────────────────────────────────────────────────────────────
  {
    path: ['port'],
    group: 'Ports',
    usage: 'port <add | remove | list>',
    summary: 'Named ports published from the dev container, beyond the archetype\'s own app_port. Add/remove require the project stopped.',
    flags: [],
    errors: [],
    run: group('port'),
    children: [
      {
        path: ['port', 'add'],
        group: 'Ports',
        usage: 'port add <project> <name> --container-port <n>',
        summary: 'Declare an extra port, assign its host port, regenerate compose.',
        flags: [{ name: '--container-port', arg: '<n>', description: 'Fixed port inside the container. Required.' }],
        errors: ['PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS', 'PROJECT_RUNNING', 'EXTRA_PORT_ATTACHED', 'PORT_UNAVAILABLE', 'ROOT_UNREADABLE', 'INVALID_ARGUMENT'],
        run: async (inv) => {
          const [project, name] = exactArgs(inv, byPath('port add'), 2)
          return output(
            await runPortAdd(createContext(), { project, name, containerPort: stringFlag(inv, '--container-port') }),
            renderPortAdd,
          )
        },
      },
      {
        path: ['port', 'remove'],
        group: 'Ports',
        usage: 'port remove <project> <name>',
        summary: 'Remove a declared extra port and release its host port.',
        flags: [],
        errors: ['PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS', 'PROJECT_RUNNING', 'EXTRA_PORT_NOT_ATTACHED'],
        run: async (inv) => {
          const [project, name] = exactArgs(inv, byPath('port remove'), 2)
          return output(await runPortRemove(createContext(), { project, name }), renderPortRemove)
        },
      },
      {
        path: ['port', 'list'],
        group: 'Ports',
        usage: 'port list <project>',
        summary: 'Declared extra ports with their resolved host ports.',
        flags: [],
        errors: ['PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS'],
        run: (inv) => {
          const [project] = exactArgs(inv, byPath('port list'), 1)
          return output(collectPortList(createContext(), project), renderPortList)
        },
      },
    ],
  },

  // ── Deps ───────────────────────────────────────────────────────────────────
  {
    path: ['deps'],
    group: 'Deps',
    usage: 'deps <add | remove | list>',
    summary: 'OS packages a project\'s toolchain needs beyond its base image. Add/remove require the project stopped.',
    flags: [],
    errors: [],
    run: group('deps'),
    children: [
      {
        path: ['deps', 'add'],
        group: 'Deps',
        usage: 'deps add <project> <package...>',
        summary: 'Declare one or more apt packages; built into a derived image on the next `up`.',
        flags: [],
        errors: ['PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS', 'PROJECT_RUNNING', 'PACKAGE_ATTACHED', 'INVALID_ARGUMENT'],
        run: async (inv) => {
          const [project, ...packages] = minArgs(inv, byPath('deps add'), 2)
          return output(await runDepsAdd(createContext(), { project, packages }), renderDepsAdd)
        },
      },
      {
        path: ['deps', 'remove'],
        group: 'Deps',
        usage: 'deps remove <project> <package...>',
        summary: 'Remove one or more declared packages.',
        flags: [],
        errors: ['PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS', 'PROJECT_RUNNING', 'PACKAGE_NOT_ATTACHED', 'INVALID_ARGUMENT'],
        run: async (inv) => {
          const [project, ...packages] = minArgs(inv, byPath('deps remove'), 2)
          return output(await runDepsRemove(createContext(), { project, packages }), renderDepsRemove)
        },
      },
      {
        path: ['deps', 'list'],
        group: 'Deps',
        usage: 'deps list <project>',
        summary: 'Declared packages and the image the dev container builds/runs from.',
        flags: [],
        errors: ['PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS'],
        run: (inv) => {
          const [project] = exactArgs(inv, byPath('deps list'), 1)
          return output(collectDepsList(createContext(), project), renderDepsList)
        },
      },
    ],
  },

  // ── Shell ──────────────────────────────────────────────────────────────────
  {
    path: ['shell'],
    group: 'Shell',
    usage: 'shell <name> [--print] [--root]',
    summary: 'Resolve the dev container and RETURN the exec invocation. The CLI spawns no terminal.',
    flags: [
      { name: '--print', description: 'Human mode: print the command to run.' },
      { name: '--root', description: 'Open as root (`docker exec -u root`) instead of the image user. Ephemeral.' },
    ],
    errors: ['PROJECT_NOT_FOUND', 'PROJECT_AMBIGUOUS', 'PROJECT_STOPPED', 'DOCKER_UNAVAILABLE'],
    run: async (inv) => {
      const [name] = exactArgs(inv, byPath('shell'), 1)
      // Same payload either way; `--print` only chooses the human renderer, so
      // the machine contract cannot drift from the flag (§2).
      const result = await runShell(createContext(), name, { root: boolFlag(inv, '--root') })
      return output(result, boolFlag(inv, '--print') ? renderShellPrint : renderShell)
    },
  },

  // ── Volumes / disk ─────────────────────────────────────────────────────────
  {
    path: ['volumes'],
    group: 'Volumes / disk',
    usage: 'volumes <orphaned | rm>',
    summary: 'Inspect and reclaim volumes and data directories no project claims any more.',
    flags: [],
    errors: [],
    run: group('volumes'),
    children: [
      {
        path: ['volumes', 'orphaned'],
        group: 'Volumes / disk',
        usage: 'volumes orphaned',
        summary: 'Named volumes and leftover data directories no manifest claims, with sizes.',
        flags: [],
        // SSD_NOT_MOUNTED is not in §6's list but is a safety requirement:
        // with no manifests to read, every volume would look reclaimable.
        // ROOT_UNREADABLE is the same safety net for a PARTIAL view (phase 18).
        errors: ['SSD_NOT_MOUNTED', 'ROOT_UNREADABLE', 'DOCKER_UNAVAILABLE'],
        run: async (inv) => {
          noArgs(inv, 'volumes orphaned')
          return output(await collectOrphanedVolumes(createContext()), renderOrphanedVolumes)
        },
      },
      {
        path: ['volumes', 'rm'],
        group: 'Volumes / disk',
        usage: 'volumes rm <name> [--force]',
        summary: 'Remove one orphan — a volume or a data directory. Confirms unless --force. Destroys data.',
        flags: [{ name: '--force', description: 'Skip the confirmation prompt.' }],
        errors: ['SSD_NOT_MOUNTED', 'ROOT_UNREADABLE', 'VOLUME_IN_USE', 'VOLUME_NOT_FOUND', 'DOCKER_UNAVAILABLE'],
        run: async (inv) => {
          const [name] = exactArgs(inv, byPath('volumes rm'), 1)
          return output(
            await runVolumeRemove(createContext(), { name, force: boolFlag(inv, '--force'), json: inv.json }),
            renderVolumeRemove,
          )
        },
      },
    ],
  },

  // ── Lifecycle / SSD ────────────────────────────────────────────────────────
  {
    path: ['down-all'],
    group: 'Lifecycle / SSD',
    usage: 'down-all',
    summary: 'Stop and remove all bardolier containers.',
    flags: [],
    errors: ['DOCKER_UNAVAILABLE'],
    run: async (inv) => {
      noArgs(inv, 'down-all')
      return output(await runDownAll(createContext()), renderDownAll)
    },
  },
  {
    path: ['eject'],
    group: 'Lifecycle / SSD',
    usage: 'eject [<root> | --all] [--stop-docker]',
    summary:
      'down-all, check host holders via lsof, then eject a root\'s volume. Never forces. The root name is required unless exactly one configured root is a removable volume, or --all is given to eject every removable root, best-effort.',
    flags: [
      {
        name: '--all',
        description: 'Eject every mounted, removable root instead of exactly one. Mutually exclusive with <root>.',
      },
      {
        name: '--stop-docker',
        description: "Stop the Docker engine without asking, if its VM is what holds the volume.",
      },
    ],
    errors: ['SSD_NOT_MOUNTED', 'EJECT_BLOCKED', 'EJECT_NOT_APPLICABLE', 'INVALID_ARGUMENT', 'DOCKER_UNAVAILABLE'],
    run: async (inv) => {
      const root = atMostOneArg(inv, 'eject', '<root>')
      const all = boolFlag(inv, '--all')
      const stopDocker = boolFlag(inv, '--stop-docker')
      if (all && root !== null) {
        throw new BardolierError('INVALID_ARGUMENT', '`bardolier eject` takes either <root> or --all, not both.')
      }
      if (all) {
        return output(await runEjectAll(createContext(), { stopDocker }), renderEjectAll)
      }
      return output(
        await runEject(createContext(), { ...(root !== null ? { root } : {}), stopDocker }),
        renderEject,
      )
    },
  },
  {
    path: ['doctor'],
    group: 'Lifecycle / SSD',
    usage: 'doctor',
    summary: 'Environment check: Docker running, SSD mounted, base images present, catalogue valid.',
    flags: [],
    errors: [],
    run: async (inv) => {
      noArgs(inv, 'doctor')
      return output(await collectDoctor(createContext()), renderDoctor)
    },
  },

  {
    path: ['config'],
    group: 'Lifecycle / SSD',
    usage: 'config <get | set>',
    summary: 'Read and write ~/.config/bardolier/config.yml (§8) — the app’s Preferences write through here.',
    flags: [],
    errors: [],
    run: group('config'),
    children: [
      {
        path: ['config', 'get'],
        group: 'Lifecycle / SSD',
        usage: 'config get',
        summary: 'The effective config — defaults, then the file, then the environment.',
        flags: [],
        errors: ['CONFIG_INVALID'],
        run: (inv) => {
          noArgs(inv, 'config get')
          return output(collectConfigGet(createContext()), renderConfigGet)
        },
      },
      {
        path: ['config', 'set'],
        group: 'Lifecycle / SSD',
        usage: 'config set <key> <value>',
        summary: 'Set one config key. An empty value clears it. Never validates that a path exists.',
        flags: [],
        errors: ['INVALID_ARGUMENT', 'CONFIG_INVALID'],
        run: (inv) => {
          const [key, value] = exactArgs(inv, byPath('config set'), 2)
          return output(runConfigSet(createContext(), { key, value }), renderConfigSet)
        },
      },
    ],
  },

  // ── Roots ──────────────────────────────────────────────────────────────────
  {
    path: ['root'],
    group: 'Roots',
    usage: 'root <add | remove | list>',
    summary: 'Where projects live (§8, phase 18) — an ordered list of {name, path}; roots[0] is the default `new` targets.',
    flags: [],
    errors: [],
    run: group('root'),
    children: [
      {
        path: ['root', 'add'],
        group: 'Roots',
        usage: 'root add <path> [--name <name>]',
        summary: 'Register a root. Name defaults to the path\'s basename.',
        flags: [{ name: '--name', arg: '<name>', description: "This root's name. Defaults to the path's basename." }],
        errors: ['INVALID_ARGUMENT', 'CONFIG_INVALID'],
        run: (inv) => {
          const [path] = exactArgs(inv, byPath('root add'), 1)
          return output(runRootAdd(createContext(), { path, name: stringFlag(inv, '--name') }), renderRootAdd)
        },
      },
      {
        path: ['root', 'remove'],
        group: 'Roots',
        usage: 'root remove <name>',
        summary: 'Forget a root. Never touches the directory or anything in it.',
        flags: [],
        errors: ['INVALID_ARGUMENT'],
        run: (inv) => {
          const [name] = exactArgs(inv, byPath('root remove'), 1)
          return output(runRootRemove(createContext(), { name }), renderRootRemove)
        },
      },
      {
        path: ['root', 'list'],
        group: 'Roots',
        usage: 'root list',
        summary: 'Every configured root, with whether it is currently readable.',
        flags: [],
        errors: [],
        run: (inv) => {
          noArgs(inv, 'root list')
          return output(collectRootList(createContext()), renderRootList)
        },
      },
    ],
  },

  // ── Images ─────────────────────────────────────────────────────────────────
  {
    path: ['build'],
    group: 'Images',
    usage: 'build [--archetype <a>] [--claude-code-version <v>]',
    summary: "Build base image(s) with host UID/GID build args. No arg builds every archetype's base.",
    flags: [
      { name: '--archetype', arg: '<a>', description: 'Build only this archetype’s base image.' },
      {
        name: '--claude-code-version',
        arg: '<v>',
        description:
          'Claude Code version to install — defaults to `latest`. Pass an exact `X.Y.Z` to pin, e.g. to reproduce an old image. Always checksum-verified either way.',
      },
    ],
    errors: ['DOCKER_UNAVAILABLE', 'INVALID_ARGUMENT'],
    run: async (inv) => {
      noArgs(inv, 'build')
      return output(
        await runBuild(createContext(), stringFlag(inv, '--archetype'), stringFlag(inv, '--claude-code-version')),
        renderBuild,
      )
    },
  },
]

/**
 * Usage strings for the commands that report their own usage on a bad
 * invocation. Resolved from the declared surface so the error text and
 * `--help` can never drift apart.
 */
function byPath(path: string): CommandNode {
  const found = walk(ROOT).find((command) => command.path.join(' ') === path)
  if (!found) throw new BardolierError('INTERNAL_ERROR', `No command declared at \`${path}\`.`)
  return found
}

export const ROOT: CommandNode = {
  path: [],
  group: 'Projects',
  usage: 'bardolier',
  summary: 'Container Project Manager',
  flags: [JSON_FLAG],
  errors: [],
  run: group('bardolier'),
  children: COMMANDS,
}

/** Flatten to leaf commands (grouping nodes excluded) in declaration order. */
export function walk(node: CommandNode): CommandNode[] {
  const out: CommandNode[] = []
  for (const child of node.children ?? []) {
    if (child.children && child.children.length > 0) out.push(...walk(child))
    else out.push(child)
  }
  return out
}

/** Resolve argv to a command, returning it plus the unconsumed positionals. */
export function resolve(argv: readonly string[]): { command: CommandNode | null; rest: string[] } {
  let node: CommandNode = ROOT
  let index = 0
  while (index < argv.length) {
    const token = argv[index]
    if (token === undefined || token.startsWith('-')) break
    const child = (node.children ?? []).find((c) => c.path[c.path.length - 1] === token)
    if (!child) break
    node = child
    index += 1
  }
  if (node === ROOT) return { command: null, rest: [...argv] }
  return { command: node, rest: argv.slice(index) }
}
