import { clamp, distance, skinToneStrength } from './math.js'
import type { ColorAnalysis, ColorRegion, Group } from './types.js'

/** 统计每个色群由哪些连续区域构成，计算局部边缘对比。 */
export function measureComponents(
  groups: Group[], labels: Int32Array, rgba: Uint8ClampedArray,
  width: number, height: number, exponent: number, minArea: number, skinMinArea = minArea
) {
  const size = width * height
  const visited = new Uint8Array(size)
  const queue = new Int32Array(size)
  const minimumAreas = groups.map(group => skinToneStrength(group.lab) >= 0.5 ? skinMinArea : minArea)
  for (let start = 0; start < size; start++) {
    if (visited[start] || labels[start]! < 0) continue
    const gid = labels[start]!
    const group = groups[gid]!
    let front = 0
    let back = 1
    let area = 0
    let edgeSum = 0
    let edgeCount = 0
    queue[0] = start
    visited[start] = 1
    while (front < back) {
      const pos = queue[front++]!
      const x = pos % width
      const y = (pos / width) | 0
      area += rgba[pos * 4 + 3]! / 255
      // 手动四邻接以避免为每个像素构造临时数组。
      const inspect = (next: number) => {
        const neighborGroup = labels[next]!
        if (neighborGroup < 0) return
        if (neighborGroup === gid) {
          if (!visited[next]) {
            visited[next] = 1
            queue[back++] = next
          }
        } else {
          edgeSum += Math.sqrt(distance(group.lab, groups[neighborGroup]!.lab))
          edgeCount++
        }
      }
      if (x > 0) inspect(pos - 1)
      if (x + 1 < width) inspect(pos + 1)
      if (y > 0) inspect(pos - width)
      if (y + 1 < height) inspect(pos + width)
    }
    group.areaPowerSum += area ** exponent
    group.maxComponent = Math.max(group.maxComponent, area)
    if (area >= minimumAreas[gid]! && edgeCount > 0) {
      const contrast = clamp(edgeSum / edgeCount / 0.16, 0, 1.5)
      // 小连通块也能有较高边界奖励，但孤立噪点不参加。
      const localScore = Math.sqrt(area) * contrast
      group.strongestEdge = Math.max(group.strongestEdge, localScore)
    }
  }
}

/** 提取最终标签图的四邻接区域；同一标签、同一透明度才连通。 */
export function extractRegions(
  analysis: Pick<ColorAnalysis, 'width' | 'height' | 'labels' | 'alpha'>
): ColorRegion[] {
  const { width, height, labels, alpha } = analysis
  const size = width * height
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || labels.length !== size || (alpha && alpha.length !== size)) {
    throw new Error('extractRegions: image dimensions do not match')
  }
  const ids = new Int32Array(size).fill(-1)
  const queue = new Uint32Array(size)
  const regions: ColorRegion[] = []

  for (let start = 0; start < size; start++) {
    const opacity = alpha?.[start] ?? 255
    if (ids[start]! >= 0 || opacity === 0) continue
    const label = labels[start]!
    const id = regions.length
    let front = 0
    let back = 1
    let minX = start % width
    let maxX = minX
    let minY = Math.floor(start / width)
    let maxY = minY
    queue[0] = start
    ids[start] = id

    const inspect = (next: number) => {
      if (ids[next]! >= 0 || labels[next] !== label || (alpha?.[next] ?? 255) !== opacity) return
      ids[next] = id
      queue[back++] = next
    }
    while (front < back) {
      const pos = queue[front++]!
      const x = pos % width
      const y = Math.floor(pos / width)
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      if (x > 0) inspect(pos - 1)
      if (x + 1 < width) inspect(pos + 1)
      if (y > 0) inspect(pos - width)
      if (y + 1 < height) inspect(pos + width)
    }

    const region: ColorRegion = {
      label,
      bounds: [minX, minY, maxX - minX + 1, maxY - minY + 1],
      area: back,
      ...(opacity === 255 ? {} : { alpha: opacity })
    }
    // 面积填满包围盒时就是完整矩形，无需逐行记录。
    if (region.area !== region.bounds[2] * region.bounds[3]) region.runs = []
    regions.push(region)
  }

  // 扫描区域编号生成有序游程，不保存成员像素列表，也不逐区域排序。
  for (let y = 0; y < height; y++) {
    let x = 0
    while (x < width) {
      const id = ids[y * width + x]!
      if (id < 0) {
        x++
        continue
      }
      const startX = x
      while (x < width && ids[y * width + x] === id) x++
      const region = regions[id]!
      if (!region.runs) continue
      const [left, top, regionWidth] = region.bounds
      const start = (y - top) * regionWidth + startX - left
      const length = x - startX
      const previous = region.runs[region.runs.length - 1]
      if (previous && previous[0] + previous[1] === start) previous[1] += length
      else region.runs.push([start, length])
    }
  }
  return regions
}
