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

import Sharp from 'sharp'
import { clampDensity, prepareData } from '../src/services/print.js'

test('density goes into the header as 1F 11 02 NN, default 4, clamped to 1-15', async () => {
  const image = Sharp({ create: { width: 560, height: 2, channels: 4, background: '#fff' } }).png()
  const header = async density => Buffer.from((await prepareData(image, density)).data.subarray(0, 9))
  assert.deepEqual([...(await header(9))].slice(5), [0x1f, 0x11, 0x02, 9])
  assert.deepEqual([...(await header(undefined))].slice(5), [0x1f, 0x11, 0x02, 4])
  assert.equal(clampDensity(99), 15)
  assert.equal(clampDensity(0), 1)
  assert.equal(clampDensity('abc'), 4)
})
