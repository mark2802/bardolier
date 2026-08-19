/**
 * `doctor` output — `cli-spec.md` §6 (Lifecycle / SSD): "returns structured
 * findings". The app calls this on launch (app-spec.md §13), so the shape is a
 * contract: additive changes only once the app ships.
 *
 * EXIT CODE: `doctor` exits 0 even when findings fail. A failing check is the
 * answer to the question asked, not a failure to answer it — the app renders
 * `ok: false` findings, and a non-zero exit would instead surface as an error
 * banner with nothing to show. Only a genuinely broken config (CONFIG_INVALID)
 * makes `doctor` exit non-zero.
 */

/** Check ids are stable strings — the app may key UI off them. */
export const DOCTOR_CHECKS = ['config', 'ssd', 'docker', 'base_images', 'catalogue', 'manifests'] as const
export type DoctorCheck = (typeof DOCTOR_CHECKS)[number]

export type DoctorFinding = {
  id: DoctorCheck
  /** Short human label, e.g. "SSD mounted". */
  title: string
  ok: boolean
  /** What was actually observed, including the path or version involved. */
  detail: string
  /** What to do about it. Present only when the finding is actionable. */
  remedy?: string
}

export type DoctorReport = {
  /** True when every finding is ok. */
  ok: boolean
  findings: DoctorFinding[]
}
