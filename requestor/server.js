// db/public/requestor/server.js -- the local HTTPS status server run.js {{{1
// starts for the Android browser to watch (same device). No public CA can
// issue a browser-trusted certificate for "localhost"/a loopback address at
// all -- that's a hard CA/Browser Forum rule, not a Cloudflare-specific
// limit, and Cloudflare's own Origin CA certs are documented as trusted
// only between Cloudflare's edge and an origin, never by a browser
// connecting directly. So this runs its own tiny local CA instead (the
// same approach mkcert uses): a self-signed root, generated once and kept,
// signs this server's actual (leaf) certificate. Chrome still won't trust
// the root on its own -- see db/README.md for the one-time "install this CA
// on the phone" step -- but once it's installed, every cert this CA signs
// (this one, and any future regenerated leaf) is trusted with no further
// per-cert action.
//
// Serves the requestor.html one directory up (this submodule's own
// db/public/requestor.html) + the assets it needs, bundling requestor.mjs
// with esbuild's JS API on the fly (no separate build step needed on the
// Termux device -- just the esbuild dependency already in node_modules).

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url)) // {{{1
const publicDir = join(__dirname, '..')
const certDir = join(__dirname, '.certs')
const caKeyECDSAp256Path = join(certDir, 'ca.key')
const caCertECDSAp256Path = join(certDir, 'ca.crt')
const caSerialPath = join(certDir, 'ca-cert.srl')
const keyPath = join(certDir, 'key.pem')
const certPath = join(certDir, 'cert.pem')

function ensureCertECDSA () { // {{{1
  mkdirSync(certDir, { recursive: true })

  if (!existsSync(caKeyECDSAp256Path) || !existsSync(caCertECDSAp256Path)) { // {{{2

    // 1. Generate the ECDSA Private Key {{{3
    execFileSync('openssl', [
      'ecparam', '-name', 'secp256r1', '-genkey', '-noout', '-out', caKeyECDSAp256Path
    ], { stdio: 'pipe' })

    // 2. Generate the Self-Signed CA Certificate {{{3
    execFileSync('openssl', [
      'req', '-x509', '-new', '-sha256', '-nodes', '-key', caKeyECDSAp256Path,
      '-days', '3650', '-out', caCertECDSAp256Path,
      '-subj', '/CN=Dream Big Local CA',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ], { stdio: 'pipe' })

    // 3. Verify Your New CA Certificate {{{3
    execFileSync('openssl', [
      'x509', '-in', caCertECDSAp256Path, '-text', '-noout'
    ], { stdio: 'pipe' })
    console.log(`[db-requestor] generated a local CA at ${caCertECDSAp256Path} -- install`)
    console.log('[db-requestor] this on the phone once (see db/README.md) so Chrome')
    console.log('[db-requestor] trusts this status page.') // }}}3
  }

  if (!existsSync(keyPath) || !existsSync(certPath)) { // {{{2
    const csrPath = join(certDir, 'server.csr')
    const extPath = join(certDir, 'server.ext')

    // 1. Create a SAN Extension Config File {{{3
    const secf = `
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
`
    writeFileSync(extPath, secf)

    // 2. Generate the Server Key {{{3
    execFileSync('openssl', [
      'ecparam', '-name', 'secp256r1', '-genkey', '-noout', '-out', keyPath
    ], { stdio: 'pipe' })

    // 3. Generate the CSR from the Key {{{3
    execFileSync('openssl', [
      'req', '-new', '-key', keyPath, '-out', csrPath,
      '-subj', '/C=US/ST=Florida/O=KloudOfTrust/CN=localhost'
    ], { stdio: 'pipe' })

    // 4. Sign the CSR with Your CA {{{3
    execFileSync('openssl', [
      'x509', '-req', '-in', csrPath,
      '-CA', caCertECDSAp256Path, '-CAkey', caKeyECDSAp256Path,
      '-CAcreateserial', '-CAserial', caSerialPath,
      '-out', certPath, '-days', '3650', '-sha256', '-extfile', extPath
    ], { stdio: 'pipe' })

    // 5. Verify the Issued Certificate {{{3
    execFileSync('openssl', [
      'x509', '-in', certPath, '-text', '-noout'
    ], { stdio: 'pipe' }) // }}}3
  } // }}}2
}

let bundledJs // {{{1
async function getBundledJs () {
  bundledJs ??= (await esbuild.build({
    entryPoints: [join(publicDir, 'requestor.mjs')],
    bundle: true, minify: true, format: 'esm', write: false,
  })).outputFiles[0].contents
  return bundledJs;
}

const MIME = { // {{{1
  '/': 'text/html',
  '/style.css': 'text/css',
  '/favicon.ico': 'image/x-icon',
  '/requestor.mjs': 'text/javascript',
}

/** Starts the status server. getStatus() is called fresh on every
 * /status.json request -- run.js owns the actual state. {{{1 */
export async function startStatusServer (port, getStatus) {
  ensureCertECDSA()
  const html = readFileSync(join(publicDir, 'requestor.html'))
  const style = readFileSync(join(publicDir, 'style.css'))
  const favicon = readFileSync(join(publicDir, 'favicon.ico'))

  const server = createServer({
    key: readFileSync(keyPath), cert: readFileSync(certPath),
  }, async (req, res) => {
    const url = req.url === '/' ? '/' : req.url
    if (url === '/status.json') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(getStatus()))
      return;
    }
    if (!(url in MIME)) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', MIME[url])
    res.end(
      url === '/' ? html :
      url === '/style.css' ? style :
      url === '/favicon.ico' ? favicon :
      await getBundledJs()
    )
  })
  await new Promise(resolve => server.listen(port, resolve))
  return server;
}
