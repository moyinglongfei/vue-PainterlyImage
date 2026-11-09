import type { SimplifiedImageRegions } from './index.js'

/** 只读取区域 JSON 还原像素，游程可能跨越包围盒内的多行。 */
export function regionJSONToPixels(
  data: SimplifiedImageRegions
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(data.width * data.height * 4)
  for (const group of data.colors) {
    for (const region of group.regions) {
      const [left, top, width, height] = region.bounds
      const rgba = [...group.color, region.alpha ?? 255]
      for (const [start, length] of region.runs ?? [[0, width * height]]) {
        let position = start
        const end = start + length
        while (position < end) {
          const x = position % width
          const y = Math.floor(position / width)
          const count = Math.min(width - x, end - position)
          let offset = ((top + y) * data.width + left + x) * 4
          for (let i = 0; i < count; i++, offset += 4) pixels.set(rgba, offset)
          position += count
        }
      }
    }
  }
  return pixels
}
