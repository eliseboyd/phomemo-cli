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

// ---------------------------------------------------------------------------------------------------------------------
// main functions
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Main print function
 *
 * @param   {object}    characteristic
 * @param   {string}    file
 * @param   {Options}   options
 * @returns {Promise<sharp.Metadata>}
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
  const { scale, dither, debug, chunk, chunkDelay, density } = options

  // process image
  const image = await prepareImage(file, IMAGE_WIDTH, scale, dither, debug)

  // prepare data
  const { data, metadata } = await prepareData(image, density)

  // print: one job at a time, so two requests can't interleave their bytes on the characteristic
  if (characteristic) {
    log(`Printing image "${file}" (${metadata.width}×${metadata.height}, ${Math.round(data.length / 1024)} KB) ...`)
    await enqueue(() => sendToPrinter(characteristic, data, { chunk, chunkDelay, debug }))
    log('Sent')
  }

  return metadata
}

/** Darkness byte for the header: 1-15, default DEFAULT_DENSITY. */
export function clampDensity (density) {
  const n = Math.round(Number(density))
  if (!Number.isFinite(n)) return DEFAULT_DENSITY
  return Math.min(15, Math.max(1, n))
}

// ---------------------------------------------------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------------------------------------------------

let queue = Promise.resolve()

function enqueue (job) {
  const next = queue.then(job, job)
  queue = next.catch(() => {})
  return next
}

/**
 * Stream printer data to the Bluetooth characteristic in small chunks.
 *
 * One big write (what this used to do) overflows the printer's buffer on long images: the printer prints
 * what it received and stops half way. Each chunk is written as a write *request* where the characteristic
 * supports it, so the printer acknowledges it before the next one goes out; otherwise as a write command
 * with a short pause between chunks.
 *
 * @param   {object}    characteristic    noble characteristic (write / writeWithoutResponse)
 * @param   {Buffer}    data              The printer bytes
 * @param   {object}    [options]
 * @param   {number}    [options.chunk]        Bytes per write (default 128)
 * @param   {number}    [options.chunkDelay]   Pause between unacknowledged writes, in ms (default 10)
 * @param   {boolean}   [options.debug]
 * @returns {Promise<{chunks: number, withResponse: boolean}>}
 */
export async function sendToPrinter (characteristic, data, { chunk, chunkDelay, debug } = {}) {
  const size = Math.max(1, Math.floor(chunk ?? DEFAULT_CHUNK))
  const pause = Math.max(0, chunkDelay ?? DEFAULT_CHUNK_DELAY)
  const properties = characteristic.properties ?? []
  const withResponse = properties.includes('write') || !properties.includes('writeWithoutResponse')
  let chunks = 0
  for (let offset = 0; offset < data.length; offset += size) {
    await write(characteristic, data.subarray(offset, offset + size), !withResponse)
    chunks++
    if (!withResponse && pause) {
      await delay(pause)
    }
    if (debug && chunks % 200 === 0) {
      log(`  ${Math.round((offset + size) / data.length * 100)}%`)
    }
  }
  return { chunks, withResponse }
}

function write (characteristic, chunk, withoutResponse) {
  return new Promise((resolve, reject) => {
    characteristic.write(chunk, withoutResponse, err => err ? reject(err) : resolve())
  })
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Convert Sharp image to printer data
 *
 * @param   {sharp.Sharp}   image       The sharp image
 * @param   {number}        [density]   Print darkness 1-15 (how hot the head runs), see clampDensity
 * @returns {Promise<{data:Buffer<ArrayBuffer>, metadata: sharp.Metadata}>}
 */
export async function prepareData (image, density) {
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

  // variables
  let remaining = height
  let data = []
  let index = 0

  // ********
  // FROM https://github.com/vivier/phomemo-tools/tree/master#31-header
  // PRINTING HEADER

  // Initialize printer
  data[index++] = 27
  data[index++] = 64

  // Select justification
  data[index++] = 27
  data[index++] = 97

  // Justify (0=left, 1=center, 2=right)
  data[index++] = 0

  // Print density: 1F 11 02 NN. NN is how hot the head runs (the Phomemo app's darkness setting);
  // upstream always sent 4.
  data[index++] = 31
  data[index++] = 17
  data[index++] = 2
  data[index++] = clampDensity(density)
  // ********

  let line = 0

  while (remaining > 0) {
    let lines = remaining
    if (lines > 256) {
      lines = 256
    }

    // ********
    // FROM https://github.com/vivier/phomemo-tools/tree/master#32-block-marker
    // PRINTING MARKER

    // Print raster bit image
    data[index++] = 29
    data[index++] = 118
    data[index++] = 48

    // Mode: 0=normal, 1=double width, 2=double height, 3=quadruple
    data[index++] = 0

    // Bytes per line
    data[index++] = BYTES_PER_LINE
    data[index++] = 0

    // Number of lines to print in this block.
    data[index++] = lines - 1
    data[index++] = 0
    // ********

    remaining -= lines

    while (lines > 0) {
      // PRINT LINE
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

        data[index++] = byte
      }

      lines--
      line++
    }
  }

  // ******
  // FROM: https://github.com/vivier/phomemo-tools/tree/master#33-footer
  // PRINT FOOTER

  // command ESC d : print and feed n lines (twice)
  data[index++] = 27
  data[index++] = 100
  data[index++] = 2

  data[index++] = 27
  data[index++] = 100
  data[index++] = 2

  // just footer codes now

  // b'\x1f\x11\x08'
  data[index++] = 31
  data[index++] = 17
  data[index++] = 8
  // \x1f\x11\x0e
  data[index++] = 31
  data[index++] = 17
  data[index++] = 14

  // x1f\x11\x07
  data[index++] = 31
  data[index++] = 17
  data[index++] = 7

  // b'\x1f\x11\x09'
  data[index++] = 31
  data[index++] = 17
  data[index++] = 9

  // return
  return {
    data: Buffer.from(data),
    metadata,
  }
}
