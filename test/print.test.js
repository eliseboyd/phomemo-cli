import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendToPrinter } from '../src/services/print.js'
import { mergeOptions, parseOptions } from '../src/services/options.js'

function fakeCharacteristic (properties) {
  const writes = []
  return {
    properties,
    writes,
    write (data, withoutResponse, cb) {
      writes.push({ data: Buffer.from(data), withoutResponse })
      setImmediate(cb)
    },
  }
}

test('streams every byte in order, in chunks no bigger than --chunk, acknowledged when the printer supports it', async () => {
  const data = Buffer.alloc(1000, 0)
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff
  const c = fakeCharacteristic(['write', 'writeWithoutResponse'])
  const result = await sendToPrinter(c, data, { chunk: 128 })
  assert.equal(result.chunks, 8)
  assert.equal(result.withResponse, true)
  assert.ok(c.writes.every(w => w.data.length <= 128 && w.withoutResponse === false))
  assert.deepEqual(Buffer.concat(c.writes.map(w => w.data)), data)
})

test('falls back to write commands when the characteristic cannot acknowledge', async () => {
  const c = fakeCharacteristic(['writeWithoutResponse'])
  const result = await sendToPrinter(c, Buffer.alloc(300, 1), { chunk: 100, chunkDelay: 0 })
  assert.equal(result.chunks, 3)
  assert.equal(result.withResponse, false)
  assert.ok(c.writes.every(w => w.withoutResponse === true))
})

test('chunk options come from the CLI or the query string', () => {
  const cli = parseOptions({ chunk: '128', chunkDelay: '10' })
  assert.deepEqual([cli.chunk, cli.chunkDelay], [128, 10])
  const merged = mergeOptions(cli, { chunk: '64' })
  assert.deepEqual([merged.chunk, merged.chunkDelay], [64, 10])
})
