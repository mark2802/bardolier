/**
 * The command surface — cli-spec.md §6, complete.
 *
 * Phase 0 declared the whole surface so `cproj --help` is the contract you can
 * read from the terminal. Each command records the error codes §6 says it can
 * raise, so help output and the app's error mapping (app-spec.md §13) are
 * driven off one declaration rather than drifting apart.
 *
 * Commands land phase by phase — Phase 1 the read-only core, Phase 2 the
 * project lifecycle, Phase 3 services and port allocation — and the ones still
 * to come throw NOT_IMPLEMENTED. Nothing else about a command's declaration
 * changes when one is implemented: the usage, flags and error codes are the
 * frozen part.
 *
 * Every `run` here is a thin adapter: validate the shape of the invocation,
 * build a Context, call the command module, pair the payload with its human
 * renderer. Behaviour lives in the command modules, never in this file.
 */

import type { ErrorCode } from '../errors.ts'
import { CprojError, notImplemented } from '../errors.ts'
import { createContext } from '../context.ts'
import { collectStatus, renderStatus } from './status.ts'
import { collectList, renderList } from './list.ts'
import { collectDoctor, renderDoctor } from './doctor.ts'
import { renderNew, runNew } from './new.ts'
import { renderUp, runUp } from './up.ts'
import { renderDown, runDown } from './down.ts'
import { renderDelete, runDelete } from './delete.ts'
import { renderBuild, runBuild } from './build.ts'
import {
  collectServiceList,
  renderServiceAdd,
  renderServiceList,
  renderServiceRemove,
  runServiceAdd,
  runServiceRemove,
} from './service.ts'

export const COMMAND_GROUPS = ['Projects', 'Services', 'Shell', 'Volumes / disk', 'Lifecycle / SSD', 'Images'] as const
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
    throw new CprojError('INVALID_ARGUMENT', `\`cproj ${command}\` takes at most one ${placeholder}.`)
  }
  return inv.args[0] ?? null
}

/** Exactly `count` positionals, or INVALID_ARGUMENT naming the usage. */
function exactArgs(inv: Invocation, command: CommandNode, count: number): string[] {
  if (inv.args.length !== count) {
    throw new CprojError('INVALID_ARGUMENT', `Usage: cproj ${command.usage}`)
  }
  return [...inv.args]
}

function stringFlag(inv: Invocation, key: string): string | undefined {
  const value = inv.flags[key]
  return typeof value === 'string' ? value : undefined
}

function boolFlag(inv: Invocation, key: string): boolean {
  return inv.flags[key] === true
}

function noArgs(inv: Invocation, command: string): void {
  if (inv.args.length > 0) {
    throw new CprojError('INVALID_ARGUMENT', `\`cproj ${command}\` takes no arguments.`)
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
    usage: 'new <name> --archetype <a> [--services a,b]',
    summary: 'Create a project: dir, manifest, compose, .gitignore, .dockerignore, CLAUDE.md.',
    flags: [
      { name: '--archetype', arg: '<a>', description: 'web | ios | android | library. Required.' },
      { name: '--services', arg: '<a,b>', description: 'Catalogue keys to attach immediately; ports assigned now.' },
    ],
    errors: ['SSD_NOT_MOUNTED', 'PROJECT_EXISTS', 'SERVICE_UNKNOWN', 'PORT_UNAVAILABLE'],
    run: async (inv) => {
      const [name] = exactArgs(inv, byPath('new'), 1)
      return output(
        await runNew(createContext(), {
          name,
          archetype: stringFlag(inv, 'archetype'),
          services: stringFlag(inv, 'services'),
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
    errors: ['PROJECT_NOT_FOUND'],
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
    errors: ['SSD_NOT_MOUNTED', 'PROJECT_NOT_FOUND', 'PORT_UNAVAILABLE', 'DOCKER_UNAVAILABLE'],
    run: async (inv) => {
      const [name] = exactArgs(inv, byPath('up'), 1)
      return output(await runUp(createContext(), { name, noShell: boolFlag(inv, 'noShell') }), renderUp)
    },
  },
  {
    path: ['down'],
    group: 'Projects',
    usage: 'down <name>',
    summary: "Stop and remove the project's containers. Data persists. Idempotent.",
    flags: [],
    errors: ['SSD_NOT_MOUNTED', 'PROJECT_NOT_FOUND', 'DOCKER_UNAVAILABLE'],
    run: async (inv) => {
      const [name] = exactArgs(inv, byPath('down'), 1)
      return output(await runDown(createContext(), name), renderDown)
    },
  },
  {
    path: ['delete'],
    group: 'Projects',
    usage: 'delete <name> [--force] [--keep-data | --purge]',
    summary: 'Remove containers then the project dir. Releases its ports. Prompts unless --force.',
    flags: [
      { name: '--force', description: 'Skip the confirmation prompt.' },
      { name: '--keep-data', description: "Keep the project's named volumes (default); they become orphans." },
      { name: '--purge', description: "Also remove the project's named volumes. Destroys data." },
    ],
    errors: ['SSD_NOT_MOUNTED', 'PROJECT_NOT_FOUND', 'DOCKER_UNAVAILABLE', 'VOLUME_IN_USE'],
    run: async (inv) => {
      const [name] = exactArgs(inv, byPath('delete'), 1)
      return output(
        await runDelete(createContext(), {
          name,
          force: boolFlag(inv, 'force'),
          keepData: boolFlag(inv, 'keepData'),
          purge: boolFlag(inv, 'purge'),
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
        errors: ['PROJECT_NOT_FOUND', 'PROJECT_RUNNING', 'SERVICE_ATTACHED', 'SERVICE_UNKNOWN', 'PORT_UNAVAILABLE'],
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
        errors: ['PROJECT_NOT_FOUND', 'PROJECT_RUNNING', 'SERVICE_NOT_ATTACHED'],
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
        errors: ['PROJECT_NOT_FOUND'],
        run: (inv) => {
          const [project] = exactArgs(inv, byPath('service list'), 1)
          return output(collectServiceList(createContext(), project), renderServiceList)
        },
      },
    ],
  },

  // ── Shell ──────────────────────────────────────────────────────────────────
  {
    path: ['shell'],
    group: 'Shell',
    usage: 'shell <name> [--print]',
    summary: 'Resolve the dev container and RETURN the exec invocation. The CLI spawns no terminal.',
    flags: [{ name: '--print', description: 'Human mode: print the command to run.' }],
    errors: ['PROJECT_NOT_FOUND', 'PROJECT_STOPPED'],
    run: () => notImplemented('shell'),
  },

  // ── Volumes / disk ─────────────────────────────────────────────────────────
  {
    path: ['volumes'],
    group: 'Volumes / disk',
    usage: 'volumes <orphaned | rm>',
    summary: 'Inspect and reclaim named volumes no longer referenced by any compose file.',
    flags: [],
    errors: [],
    run: group('volumes'),
    children: [
      {
        path: ['volumes', 'orphaned'],
        group: 'Volumes / disk',
        usage: 'volumes orphaned',
        summary: 'Volumes referenced by no current compose file, with sizes.',
        flags: [],
        errors: ['DOCKER_UNAVAILABLE'],
        run: () => notImplemented('volumes orphaned'),
      },
      {
        path: ['volumes', 'rm'],
        group: 'Volumes / disk',
        usage: 'volumes rm <name> [--force]',
        summary: 'Remove one orphaned volume. Confirms unless --force. Destroys data.',
        flags: [{ name: '--force', description: 'Skip the confirmation prompt.' }],
        errors: ['VOLUME_IN_USE', 'DOCKER_UNAVAILABLE'],
        run: () => notImplemented('volumes rm'),
      },
    ],
  },

  // ── Lifecycle / SSD ────────────────────────────────────────────────────────
  {
    path: ['down-all'],
    group: 'Lifecycle / SSD',
    usage: 'down-all',
    summary: 'Stop and remove all cproj containers.',
    flags: [],
    errors: ['DOCKER_UNAVAILABLE'],
    run: () => notImplemented('down-all'),
  },
  {
    path: ['eject'],
    group: 'Lifecycle / SSD',
    usage: 'eject',
    summary: 'down-all, check host holders via lsof, then eject the SSD. Never forces.',
    flags: [],
    errors: ['SSD_NOT_MOUNTED', 'EJECT_BLOCKED', 'DOCKER_UNAVAILABLE'],
    run: () => notImplemented('eject'),
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

  // ── Images ─────────────────────────────────────────────────────────────────
  {
    path: ['build'],
    group: 'Images',
    usage: 'build [--archetype <a>]',
    summary: "Build base image(s) with host UID/GID build args. No arg builds every archetype's base.",
    flags: [{ name: '--archetype', arg: '<a>', description: 'Build only this archetype’s base image.' }],
    errors: ['DOCKER_UNAVAILABLE'],
    run: async (inv) => {
      noArgs(inv, 'build')
      return output(await runBuild(createContext(), stringFlag(inv, 'archetype')), renderBuild)
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
  if (!found) throw new CprojError('INTERNAL_ERROR', `No command declared at \`${path}\`.`)
  return found
}

export const ROOT: CommandNode = {
  path: [],
  group: 'Projects',
  usage: 'cproj',
  summary: 'Container Project Manager',
  flags: [JSON_FLAG],
  errors: [],
  run: group('cproj'),
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
