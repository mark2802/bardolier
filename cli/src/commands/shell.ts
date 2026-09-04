/**
 * `bandolier shell <name> [--print]` — `cli-spec.md` §6 (Shell).
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
import { BandolierError } from '../errors.ts'
import { WORKDIR } from '../compose.ts'
import { devContainerName } from '../naming.ts'
import type { ShellOutput } from '../model/shell.ts'
import { requireProject, runningNames } from '../workspace.ts'

export async function runShell(
  ctx: Context,
  name: string | undefined,
  options: { root?: boolean } = {},
): Promise<ShellOutput> {
  const project = requireProject(ctx, name)
  const container = devContainerName(project.name)

  if (!(await ctx.docker.available())) {
    throw new BandolierError(
      'DOCKER_UNAVAILABLE',
      `Cannot resolve a shell for \`${project.name}\`: the Docker daemon is not reachable.`,
    )
  }

  const running = runningNames(await ctx.docker.runningContainers())
  if (!running.has(container)) {
    throw new BandolierError(
      'PROJECT_STOPPED',
      `\`${project.name}\` is not running, so there is no container to open a shell in. Run \`bandolier up ${project.name}\` first.`,
      { project: project.name, container },
    )
  }

  return {
    project: project.name,
    container,
    // `-it` because this argv is handed to a terminal, where a shell without a
    // TTY is useless. The app runs it verbatim — no shell, no quoting.
    // `-u root` (only when asked) is `docker exec` overriding the image's own
    // USER for this one exec — ephemeral, same as any other runtime change.
    exec: options.root
      ? ['docker', 'exec', '-u', 'root', '-it', container, 'bash']
      : ['docker', 'exec', '-it', container, 'bash'],
    workdir: WORKDIR,
  }
}

/** Default human rendering: what it resolved, and how to use it. */
export function renderShell(output: ShellOutput): string[] {
  return [
    `${output.project} is running in ${output.container}.`,
    `  ${output.exec.join(' ')}`,
    '',
    `The shell lands in ${output.workdir} — the project directory, bind-mounted from the SSD.`,
    'bandolier does not open terminals; run the command above, or let the menu-bar app do it.',
  ]
}

/** `--print`: the command alone, so it can be pasted or `$(…)`-substituted. */
export function renderShellPrint(output: ShellOutput): string[] {
  return [output.exec.join(' ')]
}
