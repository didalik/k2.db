#!/usr/bin/env node

// db/public/requestor/run.js -- Dream Big's Requestor client. Designed to {{{1
// run in Termux on an Android device with no public IP of its own:
// generates an ephemeral SSH keypair, waits to be matched + granted access
// by an Agent over local/ws, then sets up `ssh -N -R` to expose a local
// service through the Agent -- the actual point of the whole project. Also
// starts a local HTTPS status server (server.js) for the same device's
// browser to watch: granted -> matched -> tunnel up.
//
// Lives in db/public (a submodule of the k2 monorepo) rather than the root
// repo's db/jobs/ -- along with everything else under this directory --
// specifically so that cloning *only* this submodule (`git clone` the k2.db
// repo alone, no k2 monorepo, no jf.public submodule) plus `npm i` here is
// enough for `make requestor` to work. ./lib/{job,sdk,types}.ts and
// ./lib/util.mjs are copies of jf/public/lib's (see their own header
// comments) kept in sync by hand, not a build step or a nested submodule.
//
// Env:
//   DB_WS_URL         -- optional, defaults to the qa deploy
//   DB_LOCAL_PORT     -- port of the local service to forward (default 8099)
//   DB_REMOTE_PORT    -- port to request on the Agent side (default = DB_LOCAL_PORT)
//   DB_STATUS_PORT    -- port for the browser-facing HTTPS status page (default 8443)
//   DB_REQUESTOR_NAME -- optional, defaults to 'termux'
//   DB_TM_ISSUER_PK   -- the Agent's Stellar public key (see tm.js). If unset,
//                        the TM trade is skipped entirely (dev/test only) --
//                        for real use this should always be set.
//
// The generated SSH public key rides in as the handshake JWT's `sub`
// (actor.app, in job.ts's terms) -- see db/jobs/agent/grant.sh's header
// comment for why: that field is opaque to local/ws and job.ts, never
// inspected, just signed and relayed.

import { spawn, spawnSync } from 'node:child_process' // {{{1
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { generate_keypair } from './lib/sdk.js'
import { job } from './lib/job.ts'
import { startStatusServer } from './server.js'
import { buyGrant } from './tm.js'

const status = { state: 'starting', log: [] } // {{{1
function record (icon, text) {
  status.log.push({ id: status.log.length, icon, text })
  console.log('[db-requestor]', text)
}
function setState (state, icon, text) {
  status.state = state
  record(icon, text)
}

function parseGrant (line) { // {{{1
  const out = {}
  for (const part of line.trim().split(/\s+/)) {
    const [k, v] = part.split('=')
    out[k] = v
  }
  const grant = { port: Number(out.port), externalIP: out.externalIP, user: out.user }
  console.log('parseGrant grant', grant, 'line', line)
  return grant;
}

async function main () { // {{{1
  const localPort = Number(process.env.DB_LOCAL_PORT ?? 8099) // {{{2
  const remotePort = Number(process.env.DB_REMOTE_PORT ?? localPort)
  const statusPort = Number(process.env.DB_STATUS_PORT ?? 8443)

  await startStatusServer(statusPort, () => status)
  console.log(`[db-requestor] status page on https://localhost:${statusPort}/`)

  // The thing being exposed through the Agent -- stands in for whatever
  // Termux is actually running; proves the tunnel really works end to end.
  const demoService = createServer((req, res) => {
    console.log(`[db-requestor] demoService hit: ${req.method} ${req.url} from ${req.socket.remoteAddress}`)
    res.end(`Dream Big Requestor demo service, reached via the Agent, at ${new Date().toISOString()}\n`)
  })
  await new Promise(resolve => demoService.listen(localPort, resolve))
  record('ℹ️', `Demo service listening on localhost:${localPort}`)

  const [sk, pk] = (await generate_keypair.call(globalThis.crypto.subtle)).split(' ')

  const keyDir = mkdtempSync(join(tmpdir(), 'db-req-'))
  const keyPath = join(keyDir, 'id_ed25519')
  const kg = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-q'])
  if (kg.status !== 0) throw new Error('ssh-keygen failed: ' + kg.stderr?.toString());
  const pubkey = readFileSync(keyPath + '.pub', 'utf8').trim()
  record('🔑', 'Generated an ephemeral SSH keypair for this session')

  const actor = { // {{{2
    app: pubkey,
    iss: { name: process.env.DB_REQUESTOR_NAME ?? 'termux', pk },
    sk,
    WebSocket,
    wsArgs: [process.env.DB_WS_URL ?? 'wss://qa.ws.kloudoftrust.org/db'],
  }

  if (process.env.DB_TM_ISSUER_PK) {
    await buyGrant(line => record('💰', line))
    setState('granted', '✅', 'TM grant confirmed')
  } else {
    setState('granted', '✅', 'TM grant: no gate configured, proceeding (dev/test only)')
  }

  const gen = job(actor, { aud: 'sshgrant', label: 'SSHGrant' }) // {{{2
  let step = await gen.next()
  while (!step.done) {
    const event = step.value
    if (event.type === 'open') {
      record('🔌', 'Connected, waiting to be matched with an Agent...')
    } else if (event.type === 'matched') {
      setState('matched', '🤝', 'Matched -- waiting for the SSH grant...')
    } else if (event.type === 'message') {
      const grant = parseGrant(event.payload.sub)
      if (grant.port == 22) {
        const tunnel = spawn('ssh', [
          '-N', '-R', `${remotePort}:localhost:${localPort}`,
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'UserKnownHostsFile=/dev/null',
          '-o', 'ExitOnForwardFailure=yes',
          '-i', keyPath,
          '-p', String(grant.port),
          `${grant.user}@${grant.externalIP}`,
        ], { stdio: 'inherit' })
        tunnel.on('exit', code => {
          if (status.state === 'tunnel') {
            setState('ended', code === 0 ? '👋' : '⚠️', `Tunnel ended (exit code ${code})`)
          }
        })
        setState('tunnel', '🚀',
          `Tunnel up via ${grant.user}@${grant.externalIP} -- forwarding Agent port ${remotePort} -> localhost:${localPort}`)
      }
    } else if (event.type === 'error') {
      record('⚠️', `job error: ${event.error}`)
    }
    step = await gen.next()
  }
  record('☑️', step.value.message)
}

main().catch(e => {
  status.state = 'error'
  record('❌', `FAILED: ${e}`)
  console.error('[db-requestor] FAILED', e)
})
