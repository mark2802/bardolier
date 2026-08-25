/**
 * Schema loading + validation. The JSON Schema files in `cli/schema/` are the
 * machine-checkable half of the contract; the types in `src/model/` are the
 * compile-time half. `test/contracts.test.ts` keeps the two in step.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { CprojError } from './errors.ts'

export const SCHEMA_NAMES = [
  'project',
  'services',
  'status',
  'error',
  'config',
  'doctor',
  'list',
  'new',
  'up',
  'down',
  'delete',
  'build',
  'service-add',
  'service-remove',
  'service-list',
  'shell',
  'volumes-orphaned',
  'volumes-rm',
  'down-all',
  'eject',
  // Phase 6: the two commands the app needed that §6 did not name (§1 — "if
  // the app needs something, a CLI command grows to provide it").
  'catalogue',
  'config-get',
  'config-set',
] as const
export type SchemaName = (typeof SCHEMA_NAMES)[number]

export function schemaPath(name: SchemaName): string {
  return fileURLToPath(new URL(`../schema/${name}.schema.json`, import.meta.url))
}

export function loadSchema(name: SchemaName): Record<string, unknown> {
  return JSON.parse(readFileSync(schemaPath(name), 'utf8')) as Record<string, unknown>
}

const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats.default(ajv)

const compiled = new Map<SchemaName, ValidateFunction>()

function validator(name: SchemaName): ValidateFunction {
  let fn = compiled.get(name)
  if (!fn) {
    fn = ajv.compile(loadSchema(name))
    compiled.set(name, fn)
  }
  return fn
}

export type ValidationResult = { valid: boolean; errors: string[] }

export function validate(name: SchemaName, value: unknown): ValidationResult {
  const fn = validator(name)
  const valid = fn(value) as boolean
  const errors = (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`)
  return { valid, errors }
}

/** Validate or throw CONFIG_INVALID with every failure listed. */
export function assertValid<T>(name: SchemaName, value: unknown, source: string): T {
  const { valid, errors } = validate(name, value)
  if (!valid) {
    throw new CprojError('CONFIG_INVALID', `${source} does not match the ${name} schema:\n  ${errors.join('\n  ')}`)
  }
  return value as T
}
