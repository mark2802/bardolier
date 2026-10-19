/**
 * `bardolier shell <name> [--print]` — `cli-spec.md` §6 (Shell).
 *
 * This command spawns NOTHING. It resolves the dev container and returns the
 * `docker exec` invocation for someone else to run: the app opens the user's
 * configured terminal (app-spec.md §7), and `--print` puts the same command on
 * a human's screen to paste.
 *
 * That division is deliberate. A CLI that opened Terminal.app would be a second
 * place where "how do we start a shell" lives, and the app would have to parse
 * or duplicate it. Here the CLI stays the API and the app stays a thin client.
 *
 * A stopped project is PROJECT_STOPPED, not an auto-start: `up` is the command
 * that starts things, and silently starting a project from a shell request
 * would hide a failing start behind a shell that never opens.
 */

import type { Context } from '../context.ts'
import { BardolierError } from '../errors.ts'
import { CONTAINER_WORK, agentWorkdir } from '../layout.ts'
import { devContainerName } from '../naming.ts'
import type { ShellOutput } from '../model/shell.ts'
import { requireProject, runningNames } from '../workspace.ts'

/** zsh (oh-my-zsh) when the image has it, bash for a project not yet rebuilt. */
const SHELL_ARGV = ['sh', '-c', 'command -v zsh >/dev/null && exec zsh || exec bash']

export async function runShell(
  ctx: Context,
  name: string | undefined,
  options: { root?: boolean } = {},
): Promise<ShellOutput> {
  const project = requireProject(ctx, name)
  const container = devContainerName(project.name)

  if (!(await ctx.docker.available())) {
    throw new BardolierError(
      'DOCKER_UNAVAILABLE',
      `Cannot resolve a shell for \`${project.name}\`: the Docker daemon is not reachable.`,
    )
  }

  const running = runningNames(await ctx.docker.runningContainers())
  if (!running.has(container)) {
    throw new BardolierError(
      'PROJECT_STOPPED',
      `\`${project.name}\` is not running, so there is no container to open a shell in. Run \`bardolier up ${project.name}\` first.`,
      { project: project.name, container },
    )
  }

  // The recorded `work_folder` is where the agent should start: Claude Code reads
  // CLAUDE.md from its starting directory upward, never downward (§10).
  const workdir = agentWorkdir(project.manifest, project.dir)
  const dir = workdir === CONTAINER_WORK ? [] : ['-w', workdir]

  return {
    project: project.name,
    container,
    // `-it` because this argv is handed to a terminal, where a shell without a
    // TTY is useless. The app runs it verbatim — no shell, no quoting.
    // `-u root` (only when asked) is `docker exec` overriding the image's own
    // USER for this one exec — ephemeral, same as any other runtime change.
    exec: options.root
      ? ['docker', 'exec', '-u', 'root', ...dir, '-it', container, ...SHELL_ARGV]
      : ['docker', 'exec', ...dir, '-it', container, ...SHELL_ARGV],
    workdir,
  }
}

/** POSIX-quote an argv word for display, so `--print` output can be pasted. */
function quoted(word: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`
}

/** Default human rendering: what it resolved, and how to use it. */
export function renderShell(output: ShellOutput): string[] {
  return [
    `${output.project} is running in ${output.container}.`,
    `  ${output.exec.map(quoted).join(' ')}`,
    '',
    `The shell lands in ${output.workdir} — the project directory, bind-mounted from the SSD.`,
    'bardolier does not open terminals; run the command above, or let the menu-bar app do it.',
  ]
}

/** `--print`: the command alone, so it can be pasted or `$(…)`-substituted. */
export function renderShellPrint(output: ShellOutput): string[] {
  return [output.exec.map(quoted).join(' ')]
}
