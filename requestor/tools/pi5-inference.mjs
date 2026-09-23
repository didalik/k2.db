// db/public/requestor/tools/pi5-inference.mjs -- a Tool (matching {{{1
// Termux-Dev's src/core/types.ts `Tool` shape: name/definition/
// validateArgs/execute, verified against that interface directly, not
// guessed) that lets an autonomous agent call a private LLM running on an
// Agent box it doesn't own -- a Raspberry Pi behind NAT, say -- paying a
// tiny Stellar micropayment per session instead of needing a VPN or OAuth
// grant. This is the actual point of Dream Big applied to something an
// agent would plausibly want, not just a synthetic demoService.
//
// Standalone/portable rather than importing Termux-Dev's own types.ts (this
// repo has no dependency on that one) -- copy this file into a Termux-Dev
// checkout's src/tools/, import { pi5InferenceTool } from './pi5-inference.mjs'
// in src/tools/index.ts, and add it to getTools()'s returned array the same
// way bash.ts etc. are, to make it available to Agent.run()'s tool-calling
// loop. Kept in sync by hand against the real interface, like ../lib/{job,
// sdk,types}.ts are kept in sync against jf/public/lib's.
//
// Wraps ../run.js's requestAccess(): the FIRST call pays the TM gate, waits
// to be matched, and brings the tunnel (plus its -L forward to the Agent's
// Ollama) up -- real, visible latency (a few seconds), not a flaw to hide;
// it's the actual "an agent is paying for access" moment happening on
// screen. Every call after that reuses the same already-open tunnel
// (requestAccess() is memoized), so only the first prompt in a session
// pays that cost.
//
// Env:
//   DB_FORWARD_REMOTE_PORT -- the Agent-side Ollama port to reach (default 11434)
//   DB_OLLAMA_MODEL         -- default model name (default 'llama3.2:1b')
//   ... plus everything run.js's requestAccess() itself reads (DB_TM_ISSUER_PK,
//   DB_WS_URL, etc.) -- see its own header comment.

import { requestAccess } from '../run.js'

const DEFAULT_MODEL = process.env.DB_OLLAMA_MODEL ?? 'llama3.2:1b'
const OLLAMA_PORT = Number(process.env.DB_FORWARD_REMOTE_PORT ?? 11434)

export const pi5InferenceTool = { // {{{1
  name: 'pi5_inference',
  definition: {
    name: 'pi5_inference',
    description:
      "Ask a private LLM running on a remote Raspberry Pi's own hardware " +
      '(not a cloud API) a question. Access is granted per-session via a ' +
      'small Stellar micropayment and a one-shot SSH tunnel -- the first ' +
      'call may take several seconds (the payment + tunnel setup); later ' +
      'calls in the same session reuse it and are fast.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send to the remote model.' },
        model: { type: 'string', description: `Ollama model name (default: ${DEFAULT_MODEL}).` },
      },
      required: ['prompt'],
    },
  },

  validateArgs (args) { // {{{1
    if (!args.prompt || typeof args.prompt !== 'string') throw new Error('prompt is required');
  },

  async execute (args) { // {{{1
    const { endpoint } = await requestAccess({ forwardRemotePort: OLLAMA_PORT })
    if (!endpoint) {
      throw new Error('pi5_inference: requestAccess() returned no endpoint -- DB_FORWARD_REMOTE_PORT unset?');
    }

    const res = await fetch(`${endpoint}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: args.model ?? DEFAULT_MODEL, prompt: args.prompt, stream: false }),
    })
    if (!res.ok) throw new Error(`pi5_inference: Ollama returned ${res.status}: ${await res.text()}`);
    const { response } = await res.json()
    return response;
  },
}
