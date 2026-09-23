// db/public/requestor/lib/types.ts -- a copy of jf/public/lib/types.ts,
// kept here so db/public alone (cloned standalone, no other submodule) has
// everything `make requestor` needs. Keep in sync with the original by
// hand if that file's shapes change.
//
// Pattern borrowed from ../../../../Termux-Dev's src/core/types.ts: a
// discriminated-union event type per async-generator stream (there,
// LLMStreamChunk; here, JobEvent), kept in its own file alongside the plain
// interfaces the generator's signature needs. See job.ts for the generator
// itself and how it's modeled on Termux-Dev's src/providers/*.ts
// `async *chatStream` + src/core/loop.ts `async *run` pair.

export const State = { MATCH: 1, RELAY: 2 } as const // {{{1
export type State = typeof State[keyof typeof State]

export interface Issuer { // {{{1
  agent?: boolean
  name: string
  pk: string
  uuid?: string
}

export interface JwtPayload { // {{{1
  sub: string
  aud?: string
  iss?: Issuer | string
}

export interface VerifiedPayload extends JwtPayload { // {{{1
  iss: Issuer
}

export interface Attachment { // {{{1
  iss: Issuer
  sk: string
  state: State
  match?: VerifiedPayload
  /** The matched peer's CF-Connecting-IP, relayed by local/ws (Cloudflare-observed
   * on their WS upgrade, not self-reported) -- undefined for FSMs/versions of
   * local/ws that don't relay it. */
  connectingIp?: string
}

/** Minimal surface job() needs from a WebSocket, whether it's a browser
 * WebSocket (onmessage/onopen/...) or Node's "ws" package (on(type, fn)). {{{1 */
export interface WebSocketLike {
  readyState: number
  send (data: string): void
  close (): void
  onmessage?: ((event: { data: unknown }) => void) | null
  onopen?: ((event?: unknown) => void) | null
  onclose?: ((event?: unknown) => void) | null
  onerror?: ((event?: unknown) => void) | null
  on? (type: string, listener: (...args: any[]) => void): unknown
}

/** A Job Agent's or Job Requester's identity + transport. {{{1 */
export interface Actor {
  app: string
  iss: Issuer
  sk: string
  WebSocket: new (url: string | URL, protocols?: unknown) => WebSocketLike
  wsArgs: [string | URL, unknown?]
}

export interface ChildProcessLike { // {{{1
  stdin: { write (data: string): void; end (): void }
  stdout: { on (event: 'data', listener: (data: { toString (): string }) => void): void }
  stderr: { on (event: 'data', listener: (data: { toString (): string }) => void): void }
  on (event: 'error' | 'close', listener: (arg: any) => void): void
}

export type SpawnFn = ( // {{{1
  command: string, args: string[], options: { cwd: string; env?: Record<string, string | undefined> }
) => ChildProcessLike

/** Something job() can pull outbound (to-be-signed-and-sent) lines from, in
 * lieu of a spawned child process -- e.g. hx/public/tm.mjs's browser-side
 * Channel standing in for a real job's stdout. {{{1 */
export interface OutboxLike {
  receive (): Promise<string>
}

/** A Job Agent's willingness to run `aud` (agent mode, via `spawn`), or a Job
 * Requester's interest in it (via `outbox`, or neither if it only wants to
 * observe JobEvents). {{{1 */
export interface JobOffer {
  aud: string
  label?: string             // defaults to aud; used to build JobResult.message
  indataEOD?: boolean        // agent mode: keep stdin open for the 'context.job.stdin.end()' sentinel
  prefix?: (attachment: Attachment) => string    // agent mode only
  spawn?: SpawnFn             // agent mode: pipe the Relay phase through a child process
  outbox?: OutboxLike         // requester mode: pull outbound lines from here instead
  onEvent?: (event: JobEvent) => void            // observe events without driving the generator directly
}

/** Events job() yields as the WebSocket lifecycle progresses. {{{1 */
export type JobEvent =
  | { type: 'open' }
  | { type: 'matched'; payload: VerifiedPayload; connectingIp?: string }
  | { type: 'message'; payload: VerifiedPayload }  // requester mode: one per Relay-phase inbound message
  | { type: 'spawned' }
  | { type: 'output'; line: string }               // a signed line sent back over the WebSocket
  | { type: 'error'; error: unknown }

export interface JobResult { // {{{1
  message: string
}
