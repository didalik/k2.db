// db/public/requestor/tm.js -- the Requester's half of Dream Big's TM gate {{{1
// (see db/jobs/agent/tm.js in the root k2 repo for the Agent's half and the
// full mechanism). Establishes trust to the Agent's issued asset and places
// a matching buy offer -- Stellar's DEX auto-matches standing orders
// whenever a compatible one appears, so this doesn't need to coordinate
// timing with the Agent at all: place the order and wait, even if the
// Agent's sell isn't live yet.
//
// Env:
//   DB_TM_ISSUER_PK    -- required: the Agent's own Stellar public key. This
//                        is published/known ahead of time, the same way any
//                        service's payment address would be -- it can't be
//                        discovered via the WS handshake, since the Agent
//                        doesn't even connect to local/ws until after its
//                        own gate opens.
//   DB_TM_ASSET_CODE   -- optional, defaults to 'DBGATE' -- must match the Agent's
//   DB_TM_PRICE        -- optional, defaults to '1' -- must match the Agent's
//   DB_TM_REQUESTOR_SK -- optional: reuse a specific Stellar identity instead
//                        of generating (and funding) a fresh one each run

import { Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { effectsCursorNow, ensureFunded, pollForTrade, server } from './stellar.mjs'

const BASE_FEE = '100000'

function assetCode () { return process.env.DB_TM_ASSET_CODE ?? 'DBGATE'; }
function price () { return process.env.DB_TM_PRICE ?? '1'; }

async function trust (kp, asset) { // {{{1
  const account = await server.loadAccount(kp.publicKey())
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60).build()
  tx.sign(kp)
  return server.submitTransaction(tx);
}

async function buy (kp, asset) { // {{{1
  const account = await server.loadAccount(kp.publicKey())
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.manageBuyOffer({
      selling: Asset.native(), buying: asset, buyAmount: '1', price: price(), offerId: '0',
    }))
    .setTimeout(60).build()
  tx.sign(kp)
  return server.submitTransaction(tx);
}

/** Places a standing buy offer for the Agent's gate asset and resolves once {{{1
 * it's filled. */
export async function buyGrant (onLog = () => {}) {
  const issuerPk = process.env.DB_TM_ISSUER_PK
  if (!issuerPk) throw new Error('DB_TM_ISSUER_PK must be set (the Agents own Stellar public key)');
  const kp = process.env.DB_TM_REQUESTOR_SK
    ? Keypair.fromSecret(process.env.DB_TM_REQUESTOR_SK) : Keypair.random()
  const asset = new Asset(assetCode(), issuerPk)

  await ensureFunded(kp)
  onLog(`trusting ${assetCode()}:${issuerPk}`)
  await trust(kp, asset)

  // Both the stream and the poll fallback below start from this same point
  // -- fetched once, before either subscribes, so neither has a gap the
  // other doesn't also cover.
  const since = await effectsCursorNow(kp.publicKey())

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true
      closeStream(); stopPoll();
      fn(arg);
    }

    // Subscribed *before* placing the buy -- if the Agent's sell is already
    // live, the trade can execute synchronously as part of the buy
    // submission itself. A stream started afterward (even with
    // cursor(since)) would then be subscribing to a point in time *after*
    // the trade already happened, and would miss it -- confirmed by
    // testing: the trade visibly executed (the Agent's own side detected
    // it), but this side's buyGrant() never resolved.
    const closeStream = server.effects().forAccount(kp.publicKey()).cursor(since).stream({
      onmessage: effect => {
        // This account only ever does this one trade -- any 'trade' effect
        // on it is unambiguously this offer filling, no amount check needed.
        if (effect.type !== 'trade') return;
        onLog('grant confirmed -- trade filled')
        finish(resolve);
      },
      onerror: err => finish(reject, err),
    })
    // Belt-and-braces fallback -- see pollForTrade's comment: the SSE stream
    // above has been observed, live, to silently stop delivering events
    // (the very bug the comment above was already written to guard against,
    // just via a different mechanism -- this covers it regardless of cause).
    const stopPoll = pollForTrade(kp.publicKey(), since, () => true, () => {
      onLog('grant confirmed -- trade filled [via poll fallback]')
      finish(resolve);
    })

    onLog(`buying 1 ${assetCode()} for ${price()} XLM (${kp.publicKey()})`)
    buy(kp, asset).catch(err => finish(reject, err))
  });
}
