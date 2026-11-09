import type { ColorAnalysis } from './types.js'
import { createColorPixels } from './utils.js'

/** 页面和 Worker 共用 PNG 编码，比较索引版与浏览器编码后的实际体积。 */
export async function encodeAnalysisPng(analysis: ColorAnalysis) {
  const { width, height } = analysis
  const { pixels } = createColorPixels(analysis)
  const image = new ImageData(new Uint8ClampedArray(pixels), width, height)
  let plainPngPromise: Promise<Blob>
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建简化图片画布')
    context.putImageData(image, 0, 0)
    plainPngPromise = new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error('生成简化图片失败')),
        'image/png'
      )
    })
  } else {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建简化图片画布')
    context.putImageData(image, 0, 0)
    plainPngPromise = canvas.convertToBlob({ type: 'image/png' })
  }
  const [plainPng, indexed] = await Promise.all([
    plainPngPromise,
    encodeIndexedPng(analysis).catch(() => null)
  ])
  return indexed && indexed.size < plainPng.size
    ? { png: indexed, plainPng, encoding: 'indexed' as const }
    : { png: plainPng, plainPng, encoding: 'rgba' as const }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function chunk(type: string, data: Uint8Array) {
  const bytes = new Uint8Array(data.length + 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i)
  bytes.set(data, 8)
  let crc = 0xffffffff
  for (let i = 4; i < bytes.length - 4; i++)
    crc = crcTable[(crc ^ bytes[i]!) & 255]! ^ (crc >>> 8)
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0)
  return bytes
}

/** 无损索引 PNG；RGBA 组合超过 256 种时交回浏览器编码。 */
export async function encodeIndexedPng(
  analysis: ColorAnalysis
): Promise<Blob | null> {
  if (typeof CompressionStream === 'undefined') return null
  const { width, height, palette, labels, alpha } = analysis
  const entries: number[][] = []
  const colors = new Map<number, number>()
  const indices = new Uint8Array(labels.length)
  for (let i = 0; i < labels.length; i++) {
    const opacity = alpha?.[i] ?? 255
    const rgb = palette[labels[i]!]!
    const r = opacity ? rgb[0] : 0
    const g = opacity ? rgb[1] : 0
    const b = opacity ? rgb[2] : 0
    const key = ((r << 24) | (g << 16) | (b << 8) | opacity) >>> 0
    let index = colors.get(key)
    if (index === undefined) {
      if (entries.length === 256) return null
      index = entries.length
      colors.set(key, index)
      entries.push([r, g, b, opacity])
    }
    indices[i] = index
  }
  const depth =
    entries.length <= 2
      ? 1
      : entries.length <= 4
        ? 2
        : entries.length <= 16
          ? 4
          : 8
  const stride = Math.ceil((width * depth) / 8)
  const rows = new Uint8Array(height * (stride + 1))
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(stride)
    for (let x = 0; x < width; x++) {
      const bit = x * depth
      row[bit >> 3] =
        row[bit >> 3]! | (indices[y * width + x]! << (8 - depth - (bit % 8)))
    }
    // 对打包后的字节选择 None/Sub/Up 过滤器，适应连续色块和横纵边界。
    let best = row
    let bestScore = Infinity
    let filter = 0
    for (let type = 0; type <= 2; type++) {
      const candidate = new Uint8Array(stride)
      let score = 0
      for (let x = 0; x < stride; x++) {
        const predictor =
          type === 1 ? (row[x - 1] ?? 0) : type === 2 ? previous[x]! : 0
        const value = (row[x]! - predictor) & 255
        candidate[x] = value
        score += Math.min(value, 256 - value)
      }
      if (score < bestScore) {
        bestScore = score
        best = candidate
        filter = type
      }
    }
    const offset = y * (stride + 1)
    rows[offset] = filter
    rows.set(best, offset + 1)
    previous = row
  }
  const compressed = new Uint8Array(
    await new Response(
      new Blob([rows]).stream().pipeThrough(new CompressionStream('deflate'))
    ).arrayBuffer()
  )
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = depth
  header[9] = 3
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('sRGB', new Uint8Array([0])),
    chunk(
      'PLTE',
      Uint8Array.from(entries.flatMap((color) => color.slice(0, 3)))
    )
  ]
  const lastTransparent = entries.findLastIndex((color) => color[3] !== 255)
  if (lastTransparent >= 0)
    parts.push(
      chunk(
        'tRNS',
        Uint8Array.from(
          entries.slice(0, lastTransparent + 1),
          (color) => color[3]!
        )
      )
    )
  parts.push(chunk('IDAT', compressed), chunk('IEND', new Uint8Array()))
  return new Blob(parts, { type: 'image/png' })
}
