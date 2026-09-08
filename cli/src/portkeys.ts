/**
 * The name the dev-server host-port allocation answers to, shared by
 * `allocator.ts` and `rootindex.ts` so a `PORT_UNAVAILABLE` refusal and an
 * offline root's projection always agree on it. Not a catalogue key —
 * nothing in `services.yml` may be called this. Its own file because the two
 * modules that need it must not import each other.
 */
export const DEV_SERVER_KEY = 'dev server'
