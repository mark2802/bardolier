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
import type { DoctorFinding, DoctorReport } from '../model/doctor.ts'
import { discoverProjects, probeSsd } from '../projects.ts'
import type { ServiceCatalogue } from '../model/catalogue.ts'

function configFinding(ctx: Context): DoctorFinding {
  const { path, exists, overrides } = ctx.loaded
  const envNote = overrides.length > 0 ? `; overridden by ${overrides.join(', ')}` : ''
  return {
    id: 'config',
    title: 'Config',
    ok: true,
    detail: exists
      ? `Loaded ${path}${envNote}. ssd_root=${ctx.config.ssd_root}, ssd_volume=${ctx.config.ssd_volume}, terminal=${ctx.config.terminal}`
      // A missing config file is a supported state, not a fault: the defaults
      // are usable and `doctor` runs before the user has written anything.
      : `No config file at ${path}; using defaults${envNote}. ssd_root=${ctx.config.ssd_root}, ssd_volume=${ctx.config.ssd_volume}`,
  }
}

async function ssdFinding(ctx: Context): Promise<DoctorFinding> {
  const ssd = probeSsd(ctx.config)
  if (ssd.mounted) {
    if (await ctx.device.removable(ssd.volume)) {
      return { id: 'ssd', title: 'SSD mounted', ok: true, detail: `${ssd.root} is readable (volume ${ssd.volume}).` }
    }
    // A local `ssd_root` (phase 10) is a supported, first-class mode, not a
    // fault — no "plug in" remedy, because there is nothing to plug in.
    return {
      id: 'ssd',
      title: 'SSD mounted',
      ok: true,
      detail: `${ssd.root} is readable, on the internal disk rather than a removable volume — \`bardolier eject\` does not apply; use \`bardolier down-all\` to stop everything instead.`,
    }
  }
  return {
    id: 'ssd',
    title: 'SSD mounted',
    ok: false,
    detail: ssd.volumePresent
      ? `Volume ${ssd.volume} is present but ${ssd.root} does not exist.`
      : `Nothing mounted at ${ssd.volume}; ${ssd.root} is unreachable.`,
    remedy: ssd.volumePresent
      ? `Create ${ssd.root}, or point ssd_root at the right directory in ${ctx.loaded.path}.`
      : 'Plug in the SSD, or set ssd_volume / BDLR_SSD_VOLUME to where it mounts.',
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
      detail: `Could not check: ${discovery.root} is unreachable.`,
      remedy: 'Plug in the SSD, then re-run `bardolier doctor`.',
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
      detail: count === 0 ? `No projects under ${discovery.root}.` : `${count} project${count === 1 ? '' : 's'} parsed and validated.`,
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
