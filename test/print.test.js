import { test } from 'node:test'
import assert from 'node:assert/strict'
import Sharp from 'sharp'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { BLOCK_MARKER, BYTES_PER_LINE, LINES_PER_BLOCK, cancelCurrent, clampDensity, prepareData, print, sendToPrinter } from '../src/services/print.js'
import { mergeOptions, parseOptions } from '../src/services/options.js'

function fakeCharacteristic (properties, onWrite) {
  const writes = []
  return {
    properties,
    writes,
    get bytes () { return Buffer.concat(writes.map(w => w.data)) },
    write (data, withoutResponse, cb) {
      writes.push({ data: Buffer.from(data), withoutResponse })
      onWrite?.(writes.length)
      setImmediate(cb)
    },
  }
}

const parts = (header, blocks, footer) => ({ header, blocks, footer })
const numbered = n => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = i & 0xff; return b }

test('streams every byte in order, in chunks no bigger than --chunk, acknowledged when the printer supports it', async () => {
  const p = parts(numbered(9), [numbered(500), numbered(400)], numbered(15))
  const c = fakeCharacteristic(['write', 'writeWithoutResponse'])
  const result = await sendToPrinter(c, p, { chunk: 128 })
  assert.equal(result.cancelled, false)
  assert.equal(result.withResponse, true)
  assert.ok(c.writes.every(w => w.data.length <= 128 && w.withoutResponse === false))
  assert.deepEqual(c.bytes, Buffer.concat([p.header, ...p.blocks, p.footer]))
})

test('falls back to write commands when the characteristic cannot acknowledge', async () => {
  const c = fakeCharacteristic(['writeWithoutResponse'])
  const result = await sendToPrinter(c, parts(Buffer.alloc(9, 1), [Buffer.alloc(300, 1)], Buffer.alloc(15, 1)), { chunk: 100, chunkDelay: 0 })
  assert.equal(result.cancelled, false)
  assert.equal(result.withResponse, false)
  assert.ok(c.writes.every(w => w.withoutResponse === true))
})

test('a cancel stops after the current chunk, pads the block with blank lines and still sends the footer', async () => {
  const token = { cancelled: false }
  const header = Buffer.alloc(9, 0xaa)
  const block = Buffer.alloc(BLOCK_MARKER + 10 * BYTES_PER_LINE, 0xff)
  const footer = Buffer.alloc(15, 0xbb)
  const c = fakeCharacteristic(['write'], n => { if (n === 3) token.cancelled = true }) // after header + 2 block chunks
  const result = await sendToPrinter(c, parts(header, [block, block], footer), { chunk: 100, token })
  assert.equal(result.cancelled, true)
  const bytes = c.bytes
  // header, 200 bytes of the first block, zeros for the rest of it, footer; the second block never goes out
  assert.equal(bytes.length, header.length + block.length + footer.length)
  assert.deepEqual(bytes.subarray(0, 9), header)
  assert.ok(bytes.subarray(9, 209).every(b => b === 0xff))
  assert.ok(bytes.subarray(209, 9 + block.length).every(b => b === 0))
  assert.deepEqual(bytes.subarray(9 + block.length), footer)
})

test('cancelCurrent reports whether a print was running', () => {
  assert.equal(cancelCurrent(), false)
})

test('chunk and density options come from the CLI or the query string', () => {
  const cli = parseOptions({ chunk: '128', chunkDelay: '10', density: '7' })
  assert.deepEqual([cli.chunk, cli.chunkDelay, cli.density], [128, 10, 7])
  const merged = mergeOptions(cli, { chunk: '64' })
  assert.deepEqual([merged.chunk, merged.chunkDelay, merged.density], [64, 10, 7])
})

test('density goes into the header as 1F 11 02 NN, default 4, clamped to 1-15; blocks hold LINES_PER_BLOCK lines', async () => {
  const image = Sharp({ create: { width: 560, height: LINES_PER_BLOCK + 2, channels: 4, background: '#fff' } }).png()
  const { parts: p } = await prepareData(image, 9)
  assert.deepEqual([...p.header].slice(5), [0x1f, 0x11, 0x02, 9])
  assert.deepEqual([...(await prepareData(image, undefined)).parts.header].slice(5), [0x1f, 0x11, 0x02, 4])
  assert.equal(p.blocks.length, 2)
  assert.equal(p.blocks[0].length, BLOCK_MARKER + LINES_PER_BLOCK * BYTES_PER_LINE)
  assert.equal(p.blocks[0][6], LINES_PER_BLOCK - 1)
  assert.equal(p.blocks[1][6], 1)
  assert.equal(clampDensity(99), 15)
  assert.equal(clampDensity(0), 1)
  assert.equal(clampDensity('abc'), 4)
})

test('print() resolves with cancelled: true when cancelled through cancelCurrent', async () => {
  const file = join(tmpdir(), `phomemo-cli-test-${process.pid}.png`)
  await Sharp({ create: { width: 560, height: 400, channels: 4, background: '#000' } }).png().toFile(file)
  const c = fakeCharacteristic(['write'], n => { if (n === 5) assert.equal(cancelCurrent(), true) })
  const result = await print(c, file, { chunk: 128, density: 4 })
  assert.equal(result.cancelled, true)
  assert.equal(result.height, 400)
  assert.ok(c.writes.length < 400 * 70 / 128)
  unlinkSync(file)
})
