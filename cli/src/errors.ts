/**
 * Stable error codes — THE single definition. Nothing else may declare one.
 *
 * `cli-spec.md` §2 lists these as "not exhaustive". The spec's own codes are
 * frozen contract: never rename or remove one once the app ships (Phase 5+).
 * Codes added by the implementation are grouped separately below so the
 * distinction stays visible; they are equally stable once shipped.
 *
 * On failure with `--json`, stdout is:
 *   { "error": { "code": "<STABLE_CODE>", "message": "<human>" } }
 * and the process exits non-zero.
 */

/** Codes named in cli-spec.md §2. */
const SPEC_ERROR_CODES = [
  'SSD_NOT_MOUNTED',
  'PROJECT_EXISTS',
  'PROJECT_NOT_FOUND',
  'PROJECT_RUNNING',
  'PROJECT_STOPPED',
  'SERVICE_UNKNOWN',
  'SERVICE_ATTACHED',
  'SERVICE_NOT_ATTACHED',
  'PORT_UNAVAILABLE',
  'VOLUME_IN_USE',
  'EJECT_BLOCKED',
  'DOCKER_UNAVAILABLE',
] as const

/** Codes this implementation adds under §2's "not exhaustive" allowance. */
const EXTENDED_ERROR_CODES = [
  /** Argument parsing rejected the invocation (missing/unknown arg or flag). */
  'INVALID_ARGUMENT',
  /** A known command exists but its behaviour is not built yet (Phase 0 stubs). */
  'NOT_IMPLEMENTED',
  /** Config file or service catalogue present but unparseable/invalid. */
  'CONFIG_INVALID',
  /** `volumes rm` was given a name Docker does not have. Distinct from VOLUME_IN_USE. */
  'VOLUME_NOT_FOUND',
  /** `port add` reused a name already declared on the project. */
  'EXTRA_PORT_ATTACHED',
  /** `port remove` named something not declared. */
  'EXTRA_PORT_NOT_ATTACHED',
  /** `deps add` reused a package name already declared on the project. */
  'PACKAGE_ATTACHED',
  /** `deps remove` named something not declared. */
  'PACKAGE_NOT_ATTACHED',
  /** `eject` on an `ssd_volume` that isn't a removable volume — use `down-all` instead. */
  'EJECT_NOT_APPLICABLE',
  /** Anything that escaped as an unexpected exception. */
  'INTERNAL_ERROR',
] as const

export const ERROR_CODES = [...SPEC_ERROR_CODES, ...EXTENDED_ERROR_CODES] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** Every failure exits with this. The stable code lives in the JSON, not the exit status. */
export const EXIT_FAILURE = 1
export const EXIT_SUCCESS = 0

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}

/** The wire shape of a failure under `--json`. */
export type ErrorPayload = {
  error: {
    code: ErrorCode
    message: string
    /** Optional code-specific detail, e.g. EJECT_BLOCKED's `holders`. */
    details?: Record<string, unknown>
  }
}

/**
 * The only error type commands should throw. Anything else is coerced to
 * INTERNAL_ERROR at the top level so no failure escapes without a stable code.
 */
export class BardolierError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'BardolierError'
    this.code = code
    this.details = details
  }

  toPayload(): ErrorPayload {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    }
  }
}

export function toBardolierError(cause: unknown): BardolierError {
  if (cause instanceof BardolierError) return cause
  const message = cause instanceof Error ? cause.message : String(cause)
  return new BardolierError('INTERNAL_ERROR', message)
}

/** Phase 0: every command is a stub. Removed command-by-command as behaviour lands. */
export function notImplemented(command: string): never {
  throw new BardolierError('NOT_IMPLEMENTED', `\`bardolier ${command}\` is not implemented yet.`)
}
