import Fs from 'fs'
import { prepareImage } from './image.js'
import { log } from './utils.js'
import { DEFAULT_CHUNK, DEFAULT_CHUNK_DELAY, DEFAULT_DENSITY } from './options.js'

// ---------------------------------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------------------------------

// See note in docs for printers other than Phomemo M02
export const BYTES_PER_LINE = 70
export const IMAGE_WIDTH = BYTES_PER_LINE * 8

/**
 * Default lines per raster block: the whole image in one block (GS v 0 takes up to 65535 lines; upstream used
 * 256). The M02 Pro pauses between blocks while the next one streams in and feeds blank paper meanwhile, which
 * shows as a white band at every boundary, so one block it is. The cost is a cancel: the printer has to finish
 * the block it is in, so a cancelled print feeds the rest of the note blank. --block-lines overrides it
 * (e.g. 256) if a cheap cancel matters more than the bands.
 */
export const LINES_PER_BLOCK = 65535

// ---------------------------------------------------------------------------------------------------------------------
// main functions
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Main print function
 *
 * @param   {object}    characteristic
 * @param   {string}    file
 * @param   {Options}   options
 * @returns {Promise<sharp.Metadata & {cancelled?: boolean}>}
 */
export async function print (characteristic, file, options) {
  // check file exists
  if (!file) {
    throw new Error('Missing file path')
  }
  if (!Fs.existsSync(file)) {
    throw new Error(`File "${file}" not found`)
  }

  // options
  const { scale, dither, debug, chunk, chunkDelay, density, blockLines } = options

  // process image
  const image = await prepareImage(file, IMAGE_WIDTH, scale, dither, debug)

  // prepare data
  const { parts, metadata } = await prepareData(image, density, blockLines)

  // print: one job at a time, so two requests can't interleave their bytes on the characteristic
  let cancelled = false
  if (characteristic) {
    const bytes = parts.header.length + parts.blocks.reduce((n, b) => n + b.length, 0) + parts.footer.length
    log(`Printing image "${file}" (${metadata.width}×${metadata.height}, ${Math.round(bytes / 1024)} KB, darkness ${clampDensity(density)}, ${parts.blocks.length} block${parts.blocks.length === 1 ? '' : 's'}) ...`)
    const result = await enqueue(token => sendToPrinter(characteristic, parts, { chunk, chunkDelay, debug, token }))
    cancelled = result.cancelled
    log(cancelled ? 'Cancelled' : 'Sent')
  }

  return { ...metadata, cancelled }
}

/** Darkness byte for the header: 1-15, default DEFAULT_DENSITY. */
export function clampDensity (density) {
  const n = Math.round(Number(density))
  if (!Number.isFinite(n)) return DEFAULT_DENSITY
  return Math.min(15, Math.max(1, n))
}

// ---------------------------------------------------------------------------------------------------------------------
// queue + cancel
// ---------------------------------------------------------------------------------------------------------------------

let queue = Promise.resolve()
/** The job being streamed right now, if any: { cancelled } */
let current = null
const waiting = new Set()

function enqueue (job) {
  const token = { cancelled: false }
  waiting.add(token)
  const run = async () => {
    waiting.delete(token)
    if (token.cancelled) throw new Error('Cancelled')
    current = token
    try {
      return await job(token)
    }
    finally {
      current = null
    }
  }
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}

/**
 * Stop the print that is streaming now (it ends its current block cleanly and feeds) and drop queued ones.
 *
 * @returns {boolean}   whether anything was running
 */
export function cancelCurrent () {
  for (const token of waiting) {
    token.cancelled = true
  }
  if (!current) {
    return false
  }
  current.cancelled = true
  return true
}

// ---------------------------------------------------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Stream printer data to the Bluetooth characteristic in small chunks.
 *
 * One big write (what this used to do) overflows the printer's buffer on long images: the printer prints
 * what it received and stops half way. Each chunk is written as a write *request* where the characteristic
 * supports it, so the printer acknowledges it before the next one goes out; otherwise as a write command
 * with a short pause between chunks.
 *
 * A cancel (token.cancelled) is checked between chunks. The printer is then still waiting for the rest of
 * the raster block it is in, and would read anything else as pixels, so that block is padded with blank
 * lines before the normal footer goes out.
 *
 * @param   {object}    characteristic    noble characteristic (write / writeWithoutResponse)
 * @param   {object}    parts             { header, blocks, footer } Buffers from prepareData
 * @param   {object}    [options]
 * @param   {number}    [options.chunk]        Bytes per write (default 128)
 * @param   {number}    [options.chunkDelay]   Pause between unacknowledged writes, in ms (default 10)
 * @param   {object}    [options.token]        { cancelled } flag checked between chunks
 * @param   {boolean}   [options.debug]
 * @returns {Promise<{chunks: number, withResponse: boolean, cancelled: boolean}>}
 */
export async function sendToPrinter (characteristic, parts, { chunk, chunkDelay, debug, token } = {}) {
  const size = Math.max(1, Math.floor(chunk ?? DEFAULT_CHUNK))
  const pause = Math.max(0, chunkDelay ?? DEFAULT_CHUNK_DELAY)
  const properties = characteristic.properties ?? []
  const withResponse = properties.includes('write') || !properties.includes('writeWithoutResponse')
  const total = parts.header.length + parts.blocks.reduce((n, b) => n + b.length, 0) + parts.footer.length
  let chunks = 0
  let sent = 0

  // streams one buffer; returns the offset it stopped at (data.length unless cancelled)
  const stream = async (data) => {
    for (let offset = 0; offset < data.length; offset += size) {
      if (token?.cancelled) return offset
      await write(characteristic, data.subarray(offset, offset + size), !withResponse)
      chunks++
      sent += Math.min(size, data.length - offset)
      if (!withResponse && pause) {
        await delay(pause)
      }
      if (debug && chunks % 200 === 0) {
        log(`  ${Math.round(sent / total * 100)}%`)
      }
    }
    return data.length
  }

  let cancelled = false
  await stream(parts.header)
  for (const block of parts.blocks) {
    const stopped = await stream(block)
    if (stopped < block.length) {
      cancelled = true
      // finish the block the printer is waiting for, with blank lines (the marker is BLOCK_MARKER bytes)
      const padding = Buffer.alloc(Math.max(0, block.length - Math.max(stopped, BLOCK_MARKER)), 0)
      if (stopped < BLOCK_MARKER) {
        // the marker itself was cut: send the rest of it, then the blank lines
        await streamAll(block.subarray(stopped, BLOCK_MARKER))
      }
      await streamAll(padding)
      break
    }
  }
  await streamAll(parts.footer)
  return { chunks, withResponse, cancelled }

  async function streamAll (data) {
    for (let offset = 0; offset < data.length; offset += size) {
      await write(characteristic, data.subarray(offset, offset + size), !withResponse)
      chunks++
      if (!withResponse && pause) await delay(pause)
    }
  }
}

function write (characteristic, chunk, withoutResponse) {
  return new Promise((resolve, reject) => {
    characteristic.write(chunk, withoutResponse, err => err ? reject(err) : resolve())
  })
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------------------------------------------------

/** Bytes of the "print raster bit image" marker that opens each block. */
export const BLOCK_MARKER = 8

/**
 * Convert Sharp image to printer data
 *
 * @param   {sharp.Sharp}   image       The sharp image
 * @param   {number}        [density]   Print darkness 1-15 (how hot the head runs), see clampDensity
 * @param   {number}        [blockLines] Lines per raster block (default LINES_PER_BLOCK)
 * @returns {Promise<{parts: {header: Buffer, blocks: Buffer[], footer: Buffer}, metadata: sharp.Metadata}>}
 */
export async function prepareData (image, density, blockLines) {
  const perBlock = Math.min(65535, Math.max(1, Math.floor(Number(blockLines)) || LINES_PER_BLOCK))
  // helper function to get pixel RGBA values at specific coordinates
  function getPixelAt (x, y) {
    const pos = (y * width + x) * 4 // 4 channels (RGBA)
    return {
      r: raw[pos],
      g: raw[pos + 1],
      b: raw[pos + 2],
      a: raw[pos + 3],
    }
  }

  // image data
  const metadata = await image.metadata()
  const { width, height } = metadata
  const raw = await image
    .ensureAlpha()
    .raw()
    .toBuffer()

  // ********
  // FROM https://github.com/vivier/phomemo-tools/tree/master#31-header
  // PRINTING HEADER
  const header = Buffer.from([
    // Initialize printer
    27, 64,
    // Select justification (0=left, 1=center, 2=right)
    27, 97, 0,
    // Print density: 1F 11 02 NN. NN is how hot the head runs (the Phomemo app's darkness setting);
    // upstream always sent 4.
    31, 17, 2, clampDensity(density),
  ])

  // ********
  // FROM https://github.com/vivier/phomemo-tools/tree/master#32-block-marker
  // one raster block per LINES_PER_BLOCK lines
  const blocks = []
  let line = 0
  let remaining = height
  while (remaining > 0) {
    const lines = Math.min(remaining, perBlock)
    const block = Buffer.alloc(BLOCK_MARKER + lines * BYTES_PER_LINE, 0)
    let index = 0
    // Print raster bit image
    block[index++] = 29
    block[index++] = 118
    block[index++] = 48
    // Mode: 0=normal, 1=double width, 2=double height, 3=quadruple
    block[index++] = 0
    // Bytes per line
    block[index++] = BYTES_PER_LINE
    block[index++] = 0
    // Number of lines to print in this block.
    block[index++] = (lines - 1) & 0xff
    block[index++] = (lines - 1) >> 8

    for (let l = 0; l < lines; l++, line++) {
      for (let x = 0; x < BYTES_PER_LINE; x++) {
        let byte = 0
        for (let bit = 0; bit < 8; bit++) {
          const rgba = getPixelAt(x * 8 + bit, line)
          if (rgba.r === 0 && rgba.a !== 0) {
            byte |= 1 << (7 - bit)
          }
        }
        if (byte === 0x0a) {
          byte = 0x14
        }
        block[index++] = byte
      }
    }
    blocks.push(block)
    remaining -= lines
  }

  // ******
  // FROM: https://github.com/vivier/phomemo-tools/tree/master#33-footer
  const footer = Buffer.from([
    // command ESC d : print and feed n lines (twice)
    27, 100, 2,
    27, 100, 2,
    // just footer codes now
    31, 17, 8,
    31, 17, 14,
    31, 17, 7,
    31, 17, 9,
  ])

  return { parts: { header, blocks, footer }, metadata }
}
