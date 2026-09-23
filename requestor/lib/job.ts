// db/public/requestor/lib/job.ts -- a copy of jf/public/lib/job.ts, kept
// here so db/public alone (cloned standalone, no other submodule) has
// everything `make requestor` needs. Keep in sync with the original by
// hand if that file's protocol logic changes.
//
// Cloudflare Job Fair client SDK: matches a Job Agent/Requester to a peer over
// a hibernating WebSocket DO (local/ws), then relays the "Relay" phase --
// either through a spawned child process (agent mode) or an
// application-supplied outbox (requester mode) -- as an AsyncGenerator of
// JobEvents.
//
// Base pattern: Termux-Dev's src/providers/*.ts `async *chatStream` (wraps a
// callback/event API in an async generator yielding a typed union, with a
// final return value) and src/core/loop.ts's `async *run` (consumes that
// generator with `for await`, re-yielding its own higher-level events). Here
// the "chunks" are WebSocket/child-process occurrences instead of LLM stream
// deltas, bridged onto one queue via lib/util.mjs's Channel.

import { Channel } from './util.mjs' // {{{1
import { JWT, verifyPayload } from './sdk.js'
import { State } from './types.ts'
import type {
  Actor, Attachment, ChildProcessLike, JobEvent, JobOffer, JobResult,
  VerifiedPayload, WebSocketLike,
} from './types.ts'

type Internal = // {{{1
  | { kind: 'ws-open' }
  | { kind: 'ws-message'; data: string }
  | { kind: 'ws-close'; data?: unknown }
  | { kind: 'ws-error'; error: unknown }
  | { kind: 'outbound'; line: string }
  | { kind: 'child-stdout'; data: string }
  | { kind: 'child-stderr'; data: string }
  | { kind: 'child-close'; code: number | null }
  | { kind: 'child-error'; error: unknown }

interface InternalChannel { // {{{1
  send (item: Internal): Promise<unknown>
  receive (): Promise<Internal>
}

const isBrowser = () => typeof (globalThis as any).global === 'undefined' // {{{1

function bridgeWs ( // {{{1
  ws: WebSocketLike, browser: boolean, channel: InternalChannel, onOpen: () => void
) {
  const open = () => { onOpen(); channel.send({ kind: 'ws-open' }) }
  const onmessage = (arg: any) => channel.send({
    kind: 'ws-message', data: browser ? arg.data : arg.toString(),
  })
  const onclose = (data: unknown) => channel.send({ kind: 'ws-close', data })
  const onerror = (error: unknown) => channel.send({ kind: 'ws-error', error })
  if (browser) {
    ws.onopen = open; ws.onmessage = onmessage; ws.onclose = onclose; ws.onerror = onerror
  } else { // Node "ws" package
    ws.on!('open', open); ws.on!('message', onmessage); ws.on!('close', onclose); ws.on!('error', onerror)
  }
  if (ws.readyState === 1) open() // already open (e.g. a test/mock WebSocket)
}

function bridgeChild (child: ChildProcessLike, channel: InternalChannel) { // {{{1
  child.on('error', error => channel.send({ kind: 'child-error', error }))
  child.on('close', code => channel.send({ kind: 'child-close', code }))
  child.stdout.on('data', data => channel.send({ kind: 'child-stdout', data: data.toString() }))
  child.stderr.on('data', data => channel.send({ kind: 'child-stderr', data: data.toString() }))
}

async function pumpOutbox ( // fire-and-forget: feeds 'outbound' until the ws closes {{{1
  outbox: { receive (): Promise<string> }, channel: InternalChannel
) {
  while (true) {
    channel.send({ kind: 'outbound', line: await outbox.receive() })
  }
}

/** Runs one job: signs a handshake JWT, opens the WebSocket, waits to be {{{1
 * matched, then relays the Relay phase until the peer closes. Yields
 * JobEvents as they occur; returns the final JobResult on close. */
export async function* job (
  actor: Actor, offer: JobOffer
): AsyncGenerator<JobEvent, JobResult, void> {
  const browser = isBrowser()
  const label = offer.label ?? offer.aud
  const channel = new Channel() as unknown as InternalChannel

  const wsURL = new URL(actor.wsArgs[0] as string)
  const params = new URLSearchParams(`iss=${encodeURIComponent(JSON.stringify(actor.iss))}`)
  params.append('aud', encodeURIComponent(offer.aud))
  wsURL.search = params.toString()

  const attachment: Attachment = { iss: actor.iss, sk: actor.sk, state: State.MATCH }
  const sign = (jwt: JWT): Promise<string> => jwt.sign() as unknown as Promise<string>
  const relay = (sub: string): Promise<string> =>
    sign(new JWT(sub).setIssuer(attachment.iss, attachment.sk))

  const handshake: string = await sign(
    new JWT(actor.app).setIssuer(actor.iss, actor.sk).setAudience(offer.aud)
  )
  const ws: WebSocketLike = new actor.WebSocket(wsURL, actor.wsArgs[1])
  bridgeWs(ws, browser, channel, () => ws.send(JSON.stringify(handshake)))

  let child: ChildProcessLike | undefined

  while (true) {
    const event = await channel.receive()
    switch (event.kind) {
      case 'ws-open': // {{{2
        yield { type: 'open' }
        break;

      case 'ws-error': // {{{2
        yield { type: 'error', error: event.error }
        break;

      case 'ws-close': // {{{2
        child?.stdin.end()
        return { message: `- ${actor.iss.name}: ${label} DONE` };

      case 'child-error': // {{{2
        console.error(`${offer.aud}  pipe2child  E R R O R  ${event.error}`)
        break;

      case 'child-stderr': // {{{2
        console.log(`${offer.aud} stderr`, event.data)
        break;

      case 'child-stdout': // {{{2
        channel.send({ kind: 'outbound', line: event.data })
        break;

      case 'child-close': // {{{2
        channel.send({ kind: 'outbound', line: `${offer.aud} EXIT CODE ${event.code}` })
        ws.close()
        break;

      case 'outbound': // {{{2
        ws.send(JSON.stringify(await relay(event.line)))
        yield { type: 'output', line: event.line }
        break;

      case 'ws-message': { // {{{2
        // The DO relays { message, connectingIp } as JSON text (mirrors the old
        // connection() wrapper's JSON.stringify(send)/JSON.parse(receive) pair).
        // connectingIp is Cloudflare-observed on the peer's own WS upgrade, not
        // self-reported -- see local/ws/src/wsfsm.ts's Behavior.Match.handle.
        const parsed = JSON.parse(event.data)
        const payload = await verifyPayload(parsed.message) as VerifiedPayload | null
        if (!payload) { console.error('Payload NOT VERIFIED'); break; }

        if (attachment.state === State.MATCH) {
          attachment.state = State.RELAY
          attachment.match = payload
          attachment.connectingIp = parsed.connectingIp
          yield { type: 'matched', payload, connectingIp: parsed.connectingIp }

          if (offer.spawn) {
            // Strip MAKELEVEL/MAKEFLAGS: when this agent process was itself
            // launched via `make` (the norm -- see CLAUDE.md's `make jobs`/
            // `make agent`), GNU Make exports both into every child's env,
            // so this spawned `make` sees itself as a sub-make and prints
            // "Entering/Leaving directory" noise on stdout -- which
            // bridgeChild below relays as if it were real job output,
            // corrupting the first message the Requester/peer receives.
            let env: Record<string, string | undefined> | undefined
            if (!browser) {
              env = { ...(globalThis as any).process.env }
              delete env.MAKELEVEL
              delete env.MAKEFLAGS
            }
            child = offer.spawn('make', [], { cwd: `./${offer.aud}`, env })
            bridgeChild(child, channel)
            yield { type: 'spawned' }
            if (offer.prefix) {
              child.stdin.write(offer.prefix(attachment))
              if (!offer.indataEOD) child.stdin.end()
            }
          } else if (offer.outbox) {
            pumpOutbox(offer.outbox, channel)
          }
          break;
        }

        // State.RELAY
        if (offer.spawn) {
          //console.log('ws-message offer', offer, 'payload.sub', payload.sub)

          child?.stdin.write(payload.sub)
          if (offer.indataEOD && payload.sub === 'context.job.stdin.end()') child?.stdin.end()
        } else {
          yield { type: 'message', payload }
        }
        break;
      } // }}}2
    }
  }
}

/** One AsyncGenerator per offer, running concurrently. {{{1 */
export function jobs (
  actor: Actor, offers: JobOffer[]
): AsyncGenerator<JobEvent, JobResult, void>[] {
  return offers.map(offer => job(actor, offer));
}

/** Drains one job(), forwarding each JobEvent to offer.onEvent as it occurs.
 * A drop-in replacement for the old Job()'s Promise<JobResult.message>. {{{1 */
export async function runJob (actor: Actor, offer: JobOffer): Promise<string> {
  const gen = job(actor, offer)
  let step = await gen.next()
  while (!step.done) {
    offer.onEvent?.(step.value as JobEvent)
    step = await gen.next()
  }
  return step.value.message;
}

/** A drop-in replacement for the old Jobs(): one Promise<string> per offer. {{{1 */
export function runJobs (actor: Actor, offers: JobOffer[]): Promise<string>[] {
  return offers.map(offer => runJob(actor, offer));
}
