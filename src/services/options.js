/**
 * @typedef Options
 *
 * @property  {number}    [scale]     The scale factor
 * @property  {boolean}   [dither]    Whether to dither the image
 * @property  {boolean}   [cache]     Whether to maintain an image cache
 * @property  {boolean}   [debug]     Whether to dump debug messages
 * @property  {number}    [chunk]       Bytes per Bluetooth write (see print.js)
 * @property  {number}    [chunkDelay]  Pause between unacknowledged writes, ms
 * @property  {number}    [density]     Print darkness 1-15
 * @property  {number}    [blockLines]  Lines per raster block
 */

export const DEFAULT_CHUNK = 128
export const DEFAULT_CHUNK_DELAY = 10
export const DEFAULT_DENSITY = 4

/**
 * Helper function to Parse CLI options or HttpRequest query
 *
 * @param     {object}    options
 * @returns   {Options}
 */
export function parseOptions ({ scale, dither, cache, debug, chunk, chunkDelay, density, blockLines } = {}) {
  return {
    scale: num(scale),
    dither: bool(dither),
    cache: bool(cache),
    debug: bool(debug),
    chunk: num(chunk),
    chunkDelay: num(chunkDelay),
    density: num(density),
    blockLines: num(blockLines),
  }
}

/**
 * Merge CLI and Request query
 *
 * @param   {Options}  options    CLI options
 * @param   {object}    query     Request query
 * @returns {Options}
 */
export function mergeOptions (options = {}, query = {}) {
  query = parseOptions(query)
  return {
    scale: query.scale ?? options.scale,
    dither: query.dither ?? options.dither,
    cache: options.cache,
    debug: options.debug,
    chunk: query.chunk ?? options.chunk,
    chunkDelay: query.chunkDelay ?? options.chunkDelay,
    density: query.density ?? options.density,
    blockLines: query.blockLines ?? options.blockLines,
  }
}

function bool (value) {
   return value === '1' || value === 'true' || value === true
}

function num (value) {
  const result = Number(value)
  return !isNaN(result)
    ? result
    : undefined
}
