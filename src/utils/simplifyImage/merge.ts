import { BIN_COUNT, EPS, WHITE_BIN_KEY, clamp, distance, toOklab } from './math.js'
import type { Bin, Color, Group } from './types.js'

function updateGroup(group: Group, bin: Bin) {
  group.area += bin.area
  group.weightedArea += bin.weightedArea
  group.redSum += bin.redSum
  group.greenSum += bin.greenSum
  group.blueSum += bin.blueSum
  group.xSum += bin.xSum
  group.ySum += bin.ySum
  group.rgb = [group.redSum / group.area, group.greenSum / group.area, group.blueSum / group.area]
  group.lab = toOklab(...group.rgb)
}

export function createGroups(bins: Bin[], mergeRange: number, spatialRadius = 0.15, spatialScale: [number, number] = [1, 1], lightnessWeight = 0.6): { groups: Group[], binGroups: Uint32Array } {
  // 将相近颜色 *先* 归并为色群；不依赖精确 RGB 的出现频率。
  // 按面积排序优先建立稳定的色群中心，合并后中心始终受限于当前平均色距。
  const groups: Group[] = []
  const origins: [number, number][] = []
  const centers: [number, number][] = []
  let whiteGroup = -1
  let maxKey = BIN_COUNT - 1
  for (const bin of bins) maxKey = Math.max(maxKey, bin.key)
  const binGroups = new Uint32Array(maxKey + 1)
  const threshold = (Math.max(0, mergeRange) / 100) ** 2
  const scoreLimit = Math.max(threshold, EPS)
  const radiusSquared = Math.max(0, spatialRadius) ** 2
  const lightnessReward = clamp(lightnessWeight, 0, 4)
  const lightnessScaleSquared = Math.max(0.02, Math.max(0, mergeRange) / 200) ** 2
  // 色群只按固定初始中心入索引，后续均值漂移无需移动索引。
  const cellSize = Math.max(spatialRadius, 1 / 64)
  const columns = radiusSquared > 0 ? Math.ceil(spatialScale[0] / cellSize) + 1 : 1
  const rows = radiusSquared > 0 ? Math.ceil(spatialScale[1] / cellSize) + 1 : 1
  const cells: number[][] = Array.from({ length: columns * rows }, () => [])
  const neighborhoods: number[][][] = cells.map((_, index) => {
    const buckets: number[][] = []
    const x = index % columns
    const y = Math.floor(index / columns)
    for (let yy = Math.max(0, y - 1); yy <= Math.min(rows - 1, y + 1); yy++) {
      for (let xx = Math.max(0, x - 1); xx <= Math.min(columns - 1, x + 1); xx++) {
        buckets.push(cells[yy * columns + xx]!)
      }
    }
    return buckets
  })
  bins.sort((a, b) => b.area - a.area || a.key - b.key)
  for (const bin of bins) {
    const pureWhite = (bin.colorKey ?? bin.key) === WHITE_BIN_KEY
    const x = bin.xSum / bin.area * spatialScale[0]
    const y = bin.ySum / bin.area * spatialScale[1]
    const cell = radiusSquared > 0 ? Math.floor(x / cellSize) + Math.floor(y / cellSize) * columns : 0
    let closest = -1
    let closestDistance = scoreLimit + EPS
    for (const bucket of neighborhoods[cell]!) for (const id of bucket) {
      const group = groups[id]!
      // 纯白单独成组，既不吸收其它颜色，也不并入其它色群。
      if (pureWhite || group.id === whiteGroup) continue
      let spatialDistance = 0
      if (radiusSquared > 0) {
        const origin = origins[group.id]!
        // 固定初始中心，避免连续吸收相邻桶后跨越整张图。
        if ((x - origin[0]) ** 2 + (y - origin[1]) ** 2 > radiusSquared) continue
        const center = centers[id]!
        spatialDistance = (x - center[0]) ** 2 + (y - center[1]) ** 2
        if (spatialDistance > radiusSquared) continue
      }
      const d = distance(bin.lab, group.lab)
      if (d > threshold) continue
      const baseCost = d + (radiusSquared > 0 ? scoreLimit * spatialDistance / radiusSquared : 0)
      if (baseCost > scoreLimit) continue
      const lightnessDifference = bin.lab[0] - group.lab[0]
      const lightnessSimilarity = 1 / (1 + lightnessDifference ** 2 / lightnessScaleSquared)
      const cost = baseCost / (1 + lightnessReward * lightnessSimilarity)
      if (cost <= scoreLimit && (cost < closestDistance || (cost === closestDistance && id < closest))) {
        closestDistance = cost
        closest = group.id
      }
    }
    if (closest < 0) {
      const rgb: Color = [bin.redSum / bin.area, bin.greenSum / bin.area, bin.blueSum / bin.area]
      closest = groups.length
      groups.push({
        id: closest,
        area: bin.area,
        weightedArea: bin.weightedArea,
        redSum: bin.redSum,
        greenSum: bin.greenSum,
        blueSum: bin.blueSum,
        xSum: bin.xSum,
        ySum: bin.ySum,
        rgb,
        lab: bin.lab,
        areaPowerSum: 0,
        maxComponent: 0,
        strongestEdge: 0,
        score: 0,
        accentScore: 0
      })
      origins.push([x, y])
      centers.push([x, y])
      cells[cell]!.push(closest)
      if (pureWhite) whiteGroup = closest
    } else {
      updateGroup(groups[closest]!, bin)
      const group = groups[closest]!
      const center = centers[closest]!
      center[0] = group.xSum / group.area * spatialScale[0]
      center[1] = group.ySum / group.area * spatialScale[1]
    }
    binGroups[bin.key] = closest
  }

  return { groups, binGroups }
}
