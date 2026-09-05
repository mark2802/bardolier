/**
 * `bardolier doctor` — `cli-spec.md` §6 (Lifecycle / SSD). The app's first call on
 * launch, so it must answer under every degraded condition: no config file, no
 * SSD, no Docker, a broken catalogue.
 *
 * Each check is INDEPENDENT and failure-tolerant — one bad answer must not stop
 * the others being asked. The command exits 0 whatever the findings say (see
 * `model/doctor.ts`); a check that could not be performed reports `ok: false`
 * with a detail explaining why, never a silent pass.
 */

import type { Context } from '../context.ts'
import { toBardolierError } from '../errors.ts'
import { BASE_IMAGES } from '../model/archetype.ts'
import type { DoctorFinding, DoctorReport, DoctorRootState } from '../model/doctor.ts'
import { discoverProjects, probeRoot } from '../projects.ts'
import type { ServiceCatalogue } from '../model/catalogue.ts'

function configFinding(ctx: Context): DoctorFinding {
  const { path, exists, overrides } = ctx.loaded
  const envNote = overrides.length > 0 ? `; overridden by ${overrides.join(', ')}` : ''
  const rootsNote = ctx.config.roots.map((r) => `${r.name}=${r.path}`).join(', ')
  return {
    id: 'config',
    title: 'Config',
    ok: true,
    detail: exists
      ? `Loaded ${path}${envNote}. roots: ${rootsNote}; terminal=${ctx.config.terminal}`
      // A missing config file is a supported state, not a fault: the defaults
      // are usable and `doctor` runs before the user has written anything.
      : `No config file at ${path}; using defaults${envNote}. roots: ${rootsNote}`,
  }
}

/** `ssd` keeps its frozen id (§6) even though it now speaks for every configured root (phase 18). */
async function ssdFinding(ctx: Context): Promise<DoctorFinding> {
  const lines: string[] = []
  const roots: DoctorRootState[] = []
  let anyReadable = false
  for (const root of ctx.config.roots) {
    const probe = probeRoot(root)
    if (!probe.mounted) {
      lines.push(`${root.name}: ${root.path} is not readable`)
      roots.push({ name: root.name, path: root.path, mounted: false, removable: null })
      continue
    }
    anyReadable = true
    const removable = probe.volume ? await ctx.device.removable(probe.volume) : false
    roots.push({ name: root.name, path: root.path, mounted: true, removable })
    if (removable) {
      lines.push(`${root.name}: ${root.path} is readable (volume ${probe.volume})`)
    } else {
      // A local root (phase 10) is a supported, first-class mode, not a
      // fault — no "plug in" remedy, because there is nothing to plug in.
      lines.push(
        `${root.name}: ${root.path} is readable, on the internal disk rather than a removable volume — \`bardolier eject\` does not apply to it; use \`bardolier down-all\` to stop everything instead`,
      )
    }
  }

  return {
    id: 'ssd',
    title: 'SSD mounted',
    ok: anyReadable,
    detail: lines.join('; '),
    roots,
    ...(anyReadable
      ? {}
      : { remedy: `Plug in a disk, or add a reachable root with \`bardolier root add\` (${ctx.loaded.path}).` }),
  }
}

async function dockerFinding(ctx: Context): Promise<DoctorFinding> {
  const available = await ctx.docker.available()
  return available
    ? { id: 'docker', title: 'Docker daemon', ok: true, detail: 'The Docker daemon responded.' }
    : {
        id: 'docker',
        title: 'Docker daemon',
        ok: false,
        detail: 'The Docker daemon did not respond (not running, or `docker` is not on PATH).',
        remedy: 'Start Docker Desktop, then re-run `bardolier doctor`.',
      }
}

async function baseImagesFinding(ctx: Context, dockerOk: boolean): Promise<DoctorFinding> {
  if (!dockerOk) {
    return {
      id: 'base_images',
      title: 'Base images',
      ok: false,
      detail: 'Could not check: the Docker daemon is unavailable.',
      remedy: 'Start Docker, then re-run `bardolier doctor`.',
    }
  }

  try {
    const images = await ctx.docker.images()
    const present = new Set(images.map((image) => image.repository))
    const missing = BASE_IMAGES.filter((name) => !present.has(name))
    if (missing.length === 0) {
      return { id: 'base_images', title: 'Base images', ok: true, detail: `Present: ${BASE_IMAGES.join(', ')}.` }
    }
    return {
      id: 'base_images',
      title: 'Base images',
      ok: false,
      detail: `Missing: ${missing.join(', ')}.`,
      remedy: 'Run `bardolier build` to build the missing base images.',
    }
  } catch (cause) {
    return {
      id: 'base_images',
      title: 'Base images',
      ok: false,
      detail: `Could not list images: ${toBardolierError(cause).message}`,
    }
  }
}

function catalogueFinding(ctx: Context): { finding: DoctorFinding; catalogue: ServiceCatalogue | null } {
  try {
    const resolved = ctx.catalogue()
    const keys = Object.keys(resolved.catalogue.services).sort()
    return {
      finding: {
        id: 'catalogue',
        title: 'Service catalogue',
        ok: true,
        detail: `${resolved.path} (${resolved.origin}) defines ${keys.length} service${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}.`,
      },
      catalogue: resolved.catalogue,
    }
  } catch (cause) {
    return {
      finding: {
        id: 'catalogue',
        title: 'Service catalogue',
        ok: false,
        detail: toBardolierError(cause).message,
        remedy: 'Fix the catalogue YAML, or unset catalogue_path to fall back to the bundled default.',
      },
      catalogue: null,
    }
  }
}

function manifestsFinding(ctx: Context, catalogue: ServiceCatalogue | null): DoctorFinding {
  const discovery = discoverProjects(ctx.config)
  if (!discovery.mounted) {
    return {
      id: 'manifests',
      title: 'Project manifests',
      ok: false,
      detail: 'Could not check: no configured root is reachable.',
      remedy: 'Plug in a disk, or fix the configured roots, then re-run `bardolier doctor`.',
    }
  }

  const problems = discovery.invalid.map((p) => `${p.name}: ${p.reason}`)
  if (catalogue) {
    for (const project of discovery.projects) {
      for (const key of Object.keys(project.manifest.services ?? {})) {
        // A manifest key the catalogue no longer defines is why `status` omits
        // that service — say so here rather than letting it vanish quietly.
        if (!catalogue.services[key]) {
          problems.push(`${project.name}: references service \`${key}\`, which the catalogue does not define`)
        }
      }
    }
  }

  const count = discovery.projects.length
  if (problems.length === 0) {
    return {
      id: 'manifests',
      title: 'Project manifests',
      ok: true,
      detail: count === 0 ? 'No projects under any reachable root.' : `${count} project${count === 1 ? '' : 's'} parsed and validated.`,
    }
  }
  return {
    id: 'manifests',
    title: 'Project manifests',
    ok: false,
    detail: problems.join('; '),
    remedy: 'Fix the offending project.yml — bardolier skips projects it cannot read.',
  }
}

export async function collectDoctor(ctx: Context): Promise<DoctorReport> {
  const findings: DoctorFinding[] = [configFinding(ctx), await ssdFinding(ctx)]

  const docker = await dockerFinding(ctx)
  findings.push(docker)
  findings.push(await baseImagesFinding(ctx, docker.ok))

  const catalogue = catalogueFinding(ctx)
  findings.push(catalogue.finding)
  findings.push(manifestsFinding(ctx, catalogue.catalogue))

  return { ok: findings.every((finding) => finding.ok), findings }
}

export function renderDoctor(report: DoctorReport): string[] {
  const lines = report.findings.map((finding) => {
    const mark = finding.ok ? '✓' : '✗'
    const head = `${mark} ${finding.title}: ${finding.detail}`
    return finding.remedy ? `${head}\n    → ${finding.remedy}` : head
  })
  lines.push('')
  lines.push(report.ok ? 'All checks passed.' : 'Some checks failed — see the suggestions above.')
  return lines
}
