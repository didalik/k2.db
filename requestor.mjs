// db/public/requestor.mjs -- the Requestor's status page, polling the local
// Node server (db/public/requestor/server.js) that serves this page in the
// first place. Not served through db/src/pages.js like the other db/public
// pages (there's no Cloudflare Worker in this path at all -- this runs
// entirely in Termux) -- reuses the same put/reset helper and styling for
// consistency, but requestor.html is a plain, self-contained static file
// rather than a -hbs.html template.

import { put, reset } from './lib/util.mjs'

reset({ content: document.getElementById('content1'), })

const seen = new Set()

async function poll () { // {{{1
  try {
    const res = await fetch('/status.json')
    const { state, log } = await res.json()
    for (const line of log) {
      if (seen.has(line.id)) continue;
      seen.add(line.id)
      put(`${line.icon} ${line.text}`)
    }
    document.title = `Dream Big -- ${state}`
  } catch (err) {
    // local server hiccup -- keep polling regardless
  }
  setTimeout(poll, 1000)
}

poll()
