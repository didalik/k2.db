import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

test('pi5InferenceTool', async () => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      const { model, prompt, stream } = JSON.parse(body)
      assert.equal(stream, false)
      res.end(JSON.stringify({ response: `echo:${prompt}:${model}`, done: true }))
    })
  })
  await new Promise(r => server.listen(0, r))
  const port = server.address().port

  mock.module('../run.js', {
    namedExports: {
      requestAccess: async () => ({ endpoint: `http://localhost:${port}` }),
    },
  })

  const { pi5InferenceTool } = await import('./pi5-inference.mjs')

  // interface shape
  assert.equal(pi5InferenceTool.name, 'pi5_inference')
  assert.equal(pi5InferenceTool.definition.name, 'pi5_inference')
  assert.deepEqual(pi5InferenceTool.definition.parameters.required, ['prompt'])

  // validateArgs
  assert.throws(() => pi5InferenceTool.validateArgs({}), /prompt is required/)
  pi5InferenceTool.validateArgs({ prompt: 'hi' }) // should not throw

  // execute, default model
  const result = await pi5InferenceTool.execute({ prompt: 'hello' })
  assert.equal(result, 'echo:hello:llama3.2:1b')

  // execute, explicit model
  const result2 = await pi5InferenceTool.execute({ prompt: 'hi', model: 'qwen2.5:0.5b' })
  assert.equal(result2, 'echo:hi:qwen2.5:0.5b')

  server.close()
})
