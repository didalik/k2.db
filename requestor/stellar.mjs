// db/public/requestor/stellar.mjs -- shared Stellar testnet plumbing for
// Dream Big's TM gate: db/jobs/agent/tm.js (the seller/gatekeeper, reaching
// in from the root k2 repo -- the Agent isn't meant to be independently
// cloneable, so this lives here once rather than as a second copy) and
// db/public/requestor/tm.js (the buyer, alongside it).

import { Horizon } from '@stellar/stellar-sdk'

export const server = new Horizon.Server('https://horizon-testnet.stellar.org')

export async function ensureFunded (kp) { // {{{1
  try {
    await server.loadAccount(kp.publicKey())
  } catch (err) {
    if (err?.response?.status !== 404) throw err;
    const res = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`)
    if (!res.ok) throw new Error('friendbot funding failed: ' + await res.text());
  }
}

/** The paging_token of the most recent existing effect on `pk`, or '0' if
 * there are none yet -- the REST equivalent of a stream's cursor('now'):
 * pollForTrade only ever looks at effects strictly after this point. {{{1 */
export async function effectsCursorNow (pk) {
  const { records } = await server.effects().forAccount(pk).order('desc').limit(1).call()
  return records[0]?.paging_token ?? '0';
}

/** Fallback for grant()/buyGrant(): Horizon's effects SSE stream has been
 * observed, live, to silently stop delivering events -- a real trade
 * executed and was visible via Horizon's own REST API, but neither the SDK's
 * .stream() nor even a raw `curl -N` SSE subscription to the same endpoint
 * ever received it. Polls the same account's effects over plain REST as a
 * belt-and-braces fallback, so a dead/stalled stream can't hang a grant
 * forever. Call stop() once whichever side (this or the stream) wins to
 * cancel the other. {{{1 */
export function pollForTrade (pk, since, matches, onFound, intervalMs = 5000) {
  let stopped = false
  let cursor = since
  ;(async () => {
    while (!stopped) {
      await new Promise(resolve => setTimeout(resolve, intervalMs))
      if (stopped) return;
      let records
      try {
        ;({ records } = await server.effects().forAccount(pk).cursor(cursor).order('asc').limit(50).call())
      } catch {
        continue; // transient REST hiccup -- just retry next tick
      }
      for (const effect of records) {
        cursor = effect.paging_token
        if (effect.type === 'trade' && matches(effect)) {
          if (!stopped) onFound(effect);
          return;
        }
      }
    }
  })()
  return () => { stopped = true; };
}
