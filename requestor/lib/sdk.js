// db/public/requestor/lib/sdk.js -- a copy of jf/public/lib/sdk.js, kept
// here so db/public alone (cloned standalone, no other submodule) has
// everything `make requestor` needs. Keep in sync with the original by
// hand if that file's JWT/generate_keypair/verifyPayload logic changes.

const algorithm = { name: "Ed25519", } // {{{1
const base64ToUint8 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0))
const uint8ToBase64 = (arr) => Buffer.from(arr).toString('base64')
const b64_2s = b64 => base64ToUint8(b64).toString().split(',').reduce((s, c) => s + String.fromCodePoint(c), '')

class JWT { // {{{1
  constructor (sub) { // {{{2
    this.header = { alg: algorithm.name, typ: 'JWT' }
    this.payload = { sub }
  }

  setAudience (aud) { // {{{2
    this.payload.aud = aud
    return this;
  }

  setIssuer (iss, sk) { // {{{2
    this.sk = sk
    this.payload.iss = iss
    return this;
  }

  sign () { // {{{2
    let header64 = uint8ToBase64(JSON.stringify(this.header))
    let payload64 = uint8ToBase64(JSON.stringify(this.payload))

    return crypto.subtle.importKey(
      'jwk', JSON.parse(this.sk), algorithm.name, true, ['sign']
    ).then(sk => crypto.subtle.sign(
      algorithm.name, sk, new TextEncoder().encode(payload64))
    ).then(signature => Promise.resolve(
      `${header64}.${payload64}.${uint8ToBase64(new Uint8Array(signature))}`
    )).catch(e => console.error(e));
  }

  // }}}2
}

async function generate_keypair () { // {{{1
  const keypair = await this.generateKey(algorithm, true, ['sign', 'verify'])
  let pk = await this.exportKey('raw', keypair.publicKey)
  let sk = await this.exportKey('jwk', keypair.privateKey)
  pk = uint8ToBase64(new Uint8Array(pk))
  sk = JSON.stringify(sk)
  return Promise.resolve(`${sk} ${pk}`);
}

function verifyPayload (message) { // {{{1
  try {
    message = message.slice(1, -1)
    let [header64, payload64, sig64] = message.split('.')
    let payload = JSON.parse(b64_2s(payload64))
    //console.log('verifyPayload payload', payload)

    if (typeof payload.iss == 'string') {
      payload.iss = JSON.parse(payload.iss)
    }
    return crypto.subtle.importKey(
      'raw', base64ToUint8(payload.iss.pk).buffer, algorithm.name, true, ['verify']
    ).then(pk => crypto.subtle.verify(
      algorithm.name, pk, base64ToUint8(sig64), new TextEncoder().encode(payload64))
    ).then(verified => Promise.resolve(verified ? payload : null));
  } catch(err) {
    console.error(err)
  }
}

export { // {{{1
  JWT, b64_2s, generate_keypair, verifyPayload,
}
