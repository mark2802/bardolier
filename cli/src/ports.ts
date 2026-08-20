/**
 * Host-port probing — the machine half of `cli-spec.md` §5.
 *
 * The probe answers one question: is this port bindable right now? `up` asks it
 * of every host port recorded in the manifest, and fails PORT_UNAVAILABLE with
 * the offending port named when the answer is no. §5 forbids a silent remap —
 * the user's saved connection strings are the reason.
 *
 * The allocator that CHOOSES ports (`allocator.ts`) sits on top of this same
 * probe, which is why it is a Context seam rather than a bare function: tests
 * script the answers instead of racing real sockets.
 */

import { createServer } from 'node:net'

export type PortProbe = {
  /** True when nothing on the host holds this port. Never throws. */
  isFree(port: number): Promise<boolean>
}

/**
 * Binds 0.0.0.0 because that is where Docker publishes: a port that is free on
 * 127.0.0.1 but taken on another interface would still fail at `up`.
 */
export function createPortProbe(): PortProbe {
  return {
    isFree: (port) =>
      new Promise((resolve) => {
        const server = createServer()
        server.once('error', () => resolve(false))
        server.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
          server.close(() => resolve(true))
        })
      }),
  }
}
