import type { Color, Group } from './types.js'

const BIN_BITS = 5
const BIN_SHIFT = 8 - BIN_BITS
export const WHITE_BIN_KEY = 1 << (3 * BIN_BITS)
export const BIN_COUNT = WHITE_BIN_KEY + 1
export const EPS = 1e-9
// 预计算 8 位 sRGB 通道到线性 RGB 的转换表，避免逐像素重复执行幂运算。
const linear = Float32Array.from({ length: 256 }, (_, value) => {
  const channel = value / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
})
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export const asByte = (v: number) => Math.round(clamp(v, 0, 255))

export const binKey = (r: number, g: number, b: number) =>
  r === 255 && g === 255 && b === 255
    ? WHITE_BIN_KEY
    : (r >> BIN_SHIFT << (2 * BIN_BITS)) | (g >> BIN_SHIFT << BIN_BITS) | (b >> BIN_SHIFT)

export function toOklab(red: number, green: number, blue: number): Color {
  const r = linear[asByte(red)]!
  const g = linear[asByte(green)]!
  const b = linear[asByte(blue)]!
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

export function skinToneStrength(lab: Color): number {
  const chroma = Math.hypot(lab[1], lab[2])
  const hue = (Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360

  // 只看色相和色度，不看明度 L
  return clamp((chroma - 0.008) / 0.01, 0, 1)
    * clamp((0.14 - chroma) / 0.02, 0, 1)
    * clamp((hue - 5) / 10, 0, 1)
    * clamp((75 - hue) / 10, 0, 1)
}

export function colorVividness(lab: Color): number {
  const chroma = Math.hypot(lab[1], lab[2])
  const saturation = clamp((chroma - 0.022) / 0.115, 0, 1)
  // 明度接近纯白时，饱和度奖励自然趋弱；中深色仍可获得奖励。
  const lightnessGate = 1 - 0.28 * clamp((lab[0] - 0.85) / 0.15, 0, 1)
  return saturation ** 1.15 * lightnessGate
}

export function priorityScore(group: Group, vividness: number, hue: number, minArea: number): number {
  return Math.min(1, group.maxComponent / minArea)
    * (1 + group.area / 2400) ** -0.35 * vividness ** 1.8
    * (0.65 + 0.35 * hue)
    * Math.min(120, group.maxComponent) ** 0.35
    * (0.75 + Math.min(1.5, group.strongestEdge / Math.max(2, Math.sqrt(group.maxComponent))))
}

export const distance = (a: Color, b: Color) =>
  (a[0] - b[0]) ** 2 + 4 * (a[1] - b[1]) ** 2 + 4 * (a[2] - b[2]) ** 2

export function createPixelLabs(rgba: Uint8ClampedArray, size: number): Float32Array {
  const labs = new Float32Array(size * 3)
  for (let i = 0; i < size; i++) {
    const offset = i * 4
    if (!rgba[offset + 3]) continue
    const lab = toOklab(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!)
    const at = i * 3
    labs[at] = lab[0]
    labs[at + 1] = lab[1]
    labs[at + 2] = lab[2]
  }
  return labs
}

export function pixelDistance(labs: Float32Array, i: number, j: number): number {
  const a = i * 3
  const b = j * 3
  const dl = labs[a]! - labs[b]!
  const da = labs[a + 1]! - labs[b + 1]!
  const db = labs[a + 2]! - labs[b + 2]!
  return dl * dl + 4 * (da * da + db * db)
}
