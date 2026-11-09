/** 色块分析：分桶、分类、显著色增强、调色板选择与标签映射。 */
import { BIN_COUNT, EPS, WHITE_BIN_KEY, asByte, binKey, clamp, colorVividness, distance, priorityScore, skinToneStrength, toOklab } from './math.js'
import { createGroups } from './merge.js'
import { extractRegions, measureComponents } from './regions.js'
import { createLineProtectionMask, smoothColorRegions } from './smooth.js'
import type { AnaOptions, Bin, Color, ColorAnalysis, Group } from './types.js'

export type { AnaOptions, Color, ColorAnalysis } from './types.js'

/** 分析参数默认值；调用时省略或显式传入 undefined 的选项均使用此配置。 */
export const defaultAnalysisOptions: Required<AnaOptions> = {
  // 'auto' 按色差自动选色；数字表示调色板颜色数量上限。
  colors: 'auto',
  // 画面中心的面积加权强度，0 关闭中心奖励。
  centerWeight: 4,
  // 鲜艳度和特殊色相的选色奖励强度，0 关闭。
  specialWeight: 4,
  // 黑白锚点候选所需的最小有效面积百分比，至少要求 2 个加权像素。
  anchorMinPercent: 2,
  // 近色归并范围，除以 100 后作为色距阈值；也影响选色时的近色过滤。
  mergeRange: 8,
  // 局部归并的重心距离上限，占最长边的比例；0 关闭局部分桶与空间限制。
  mergeSpatialRadius: 0.15,
  // 归并时明度相似奖励强度，范围 0~4，0 关闭。
  mergeLightnessWeight: 3,
  // 映射到调色板时的空间邻近奖励强度，范围 0~4，0 关闭。
  mappingPositionWeight: 3,
  // 映射时同类肤色或显著色的匹配奖励强度，范围 0~4，0 关闭。
  mappingSpecialWeight: 0.5,
  // 映射到纯黑、纯白时的代价增幅，范围 0~4，0 关闭。
  mappingNeutralPenalty: 0.45,
  // 边界平滑迭代次数，0 关闭平滑。
  contourSteps: 1,
  // 连通面积评分指数，范围 1~3；越大越偏向连续大色块，1 不额外奖励。
  connectedPower: 2,
  // 连通性评分的保底系数，范围 0~1，避免零散颜色被完全排除。
  scatteredFloor: 0.5,
  // 选色面积指数，范围 0.3~1；越小越给小面积颜色机会。
  areaPower: 0.72,
  // 非肤色显著色的优先名额上限，仍受总色数限制；0 关闭优先选入。
  accentSlots: 5,
  // 显著色候选所需的最小连通块透明度加权面积。
  accentMinArea: 3,
  // 肤色的独立优先名额上限，仍受总色数限制；0 关闭优先选入。
  skinSlots: 2,
  // 肤色候选所需的最小连通块透明度加权面积。
  skinMinArea: 9,
  // 边界对比的选色奖励强度，越大越偏向局部对比强烈的颜色。
  edgeWeight: 4,
  // 细线保护强度，范围 0~1；0 关闭，1 锁定检测到的细线。
  lineProtection: 1,
  // 细线局部密度检测窗口宽度，使用时归一化为 3~15 内的奇数。
  lineWindow: 7,
  // 细线相对周围像素的最小 OKLab 感知色差（非平方）。
  lineContrast: 0.075,
  // 细线颜色在局部窗口内的最大面积比例，范围 0~1。
  lineMaxDensity: 0.38,
  // 平滑时的原图色彩引导尺度，越小越不易跨越颜色边界。
  edgeSigma: 2
}
export const ANALYSIS_MAX_SIZE = 1024
const AUTO_MAX_COLORS = 30
const AUTO_COLOR_ERROR = 0.1
const AUTO_SKIN_COLOR_ERROR = 0.03
const AUTO_SKIN_LIGHTNESS_ERROR = 0.09

// 判断颜色是否接近传入的lab色(对一些特殊的颜色给予奖励)
function hueStrength(lab: Color): number {
  const angle = ((Math.atan2(lab[2], lab[1]) * 180 / Math.PI) + 360) % 360
  // OKLCh hue：红≈25，黄≈100，蓝≈260，紫≈310。
  const huePeak = (target: number, spread: number): number => {
    const delta = Math.abs(angle - target)
    const degrees = Math.min(delta, 360 - delta)
    return Math.exp(-0.5 * (degrees / spread) ** 2)
  }
  return Math.max(
    huePeak(25, 28),
    huePeak(100, 25),
    huePeak(260, 35),
    huePeak(315, 27)
  )
}

export function getLineProtectionMask(
  rgba: Uint8ClampedArray,
  analysis: ColorAnalysis,
  options: AnaOptions = {}
): Uint8Array {
  return createLineProtectionMask(rgba, analysis, {
    lineWindow: options.lineWindow ?? defaultAnalysisOptions.lineWindow,
    lineContrast: options.lineContrast ?? defaultAnalysisOptions.lineContrast,
    lineMaxDensity: options.lineMaxDensity ?? defaultAnalysisOptions.lineMaxDensity
  })
}

export function analyzePixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options: AnaOptions = {}
): ColorAnalysis {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.length < width * height * 4) {
    throw new Error('analyzePixels: invalid RGBA input dimensions')
  }
  // 显式传入 undefined 时也使用默认值
  const opt = { ...defaultAnalysisOptions }
  for (const key of Object.keys(options) as (keyof AnaOptions)[]) {
    const value = options[key]
    if (value !== undefined) Object.assign(opt, { [key]: value })
  }
  const automatic = opt.colors === 'auto'
  const colors = opt.colors === 'auto' ? AUTO_MAX_COLORS : clamp(Math.round(opt.colors), 1, 256)
  const connectedPower = clamp(opt.connectedPower, 1, 3)
  const scatteredFloor = clamp(opt.scatteredFloor, 0, 1)
  const areaPower = clamp(opt.areaPower, 0.3, 1)
  const accentMinArea = Math.max(1, Math.round(opt.accentMinArea))
  const skinMinArea = Math.max(1, Math.round(opt.skinMinArea))
  const size = width * height
  const spatialRadius = clamp(opt.mergeSpatialRadius, 0, 1)
  const maxSide = Math.max(width, height)
  const tileSize = spatialRadius > 0 ? Math.max(1, maxSide * spatialRadius / Math.SQRT2) : maxSide
  const tileColumns = Math.ceil(width / tileSize)
  const localBins = new Map<number, Omit<Bin, 'lab'>>()
  const pixelBins = new Uint32Array(size)
  let visible = 0 // 图片有效面积
  let alpha: Uint8Array | undefined

  // 1. 按 RGB 与局部网格收集色桶，纯白仍使用独立专用桶。
  for (let i = 0; i < size; i++) {
    const off = i * 4
    const opacity = rgba[off + 3]!
    if (opacity !== 255) {
      alpha ??= new Uint8Array(size).fill(255)
      alpha[i] = opacity
    }
    const a = opacity / 255
    if (a === 0) continue
    const r = rgba[off]!, g = rgba[off + 1]!, b = rgba[off + 2]!
    const colorKey = binKey(r, g, b)
    const tile = Math.floor((i % width) / tileSize) + Math.floor(((i / width) | 0) / tileSize) * tileColumns
    const localKey = colorKey === WHITE_BIN_KEY ? WHITE_BIN_KEY : colorKey + tile * BIN_COUNT
    let bin = localBins.get(localKey)
    if (!bin) {
      bin = { key: spatialRadius > 0 ? localBins.size : colorKey, colorKey, area: 0, weightedArea: 0, redSum: 0, greenSum: 0, blueSum: 0, xSum: 0, ySum: 0 }
      localBins.set(localKey, bin)
    }
    pixelBins[i] = bin.key
    const positionX = (i % width + 0.5) / width
    const positionY = (((i / width) | 0) + 0.5) / height
    const x = positionX * 2 - 1
    const y = positionY * 2 - 1
    const center = Math.max(0, 1 - (x * x + y * y) / 2) ** 2
    bin.area += a
    bin.weightedArea += a * (1 + Math.max(0, opt.centerWeight) * center)
    bin.redSum += a * r
    bin.greenSum += a * g
    bin.blueSum += a * b
    bin.xSum += a * positionX
    bin.ySum += a * positionY
    visible += a
  }
  if (visible === 0) return { width, height, palette: [[0, 0, 0]], labels: new Uint8Array(size), regions: [], alpha }

  // groups: 色群列表，binGroups: 每个桶对应的色群索引
  const bins: Bin[] = Array.from(localBins.values(), bin => ({
    ...bin, lab: toOklab(bin.redSum / bin.area, bin.greenSum / bin.area, bin.blueSum / bin.area)
  }))
  localBins.clear()
  const { groups, binGroups } = createGroups(bins, opt.mergeRange, spatialRadius, [width / maxSide, height / maxSide], opt.mergeLightnessWeight)
  // 2. 从全图映射到色群，再计算每个群体在空间上的连通程度。
  const pixelGroups = new Int32Array(size).fill(-1)
  for (let i = 0; i < size; i++) {
    const off = i * 4
    if (rgba[off + 3] === 0) continue
    pixelGroups[i] = binGroups[pixelBins[i]!]!
  }
  measureComponents(groups, pixelGroups, rgba, width, height, connectedPower, accentMinArea, skinMinArea)

  // 3. 评分(连续面积 + 饱和度 + 特色色相 + 边界对比/红黄蓝紫特殊色)
  for (const group of groups) {
    const cohesion = group.areaPowerSum / Math.max(EPS, group.area ** connectedPower)
    const continuity = scatteredFloor + (1 - scatteredFloor) * clamp(cohesion, 0, 1)
    const vivid = colorVividness(group.lab)
    const standout = vivid * (0.6 + 1.2 * hueStrength(group.lab))
    const edge = group.strongestEdge / Math.max(1, Math.sqrt(group.area))
    group.score = (group.weightedArea * continuity) ** areaPower
      * (1 + Math.max(0, opt.specialWeight) * standout)
      * (1 + Math.max(0, opt.edgeWeight) * clamp(edge, 0, 1))
    group.accentScore = priorityScore(group, vivid, hueStrength(group.lab), accentMinArea)
  }

  // 4. 保留原版的极亮、极暗锚点(取出最接近黑白两色且面积足够的颜色，不再参与后续竞争)
  const reserved: Group[] = []
  const minimumArea = Math.max(2, visible * Math.max(0, opt.anchorMinPercent) / 100)
  const eligible = groups.filter(g => g.area >= minimumArea)
  if (colors >= 2 && eligible.length) {
    const white: Color = [1, 0, 0]
    const black: Color = [0, 0, 0]
    const light = eligible.reduce((best, group) => distance(group.lab, white) < distance(best.lab, white) ? group : best)
    const dark = eligible.reduce((best, group) => distance(group.lab, black) < distance(best.lab, black) ? group : best)
    reserved.push(light)
    if (dark !== light) reserved.push(dark)
  }
  // 5. 按分数挑选调色板颜色，保证显著色、锚点和不同色相家族的竞争。
  const paletteKey = (group: Group) => (asByte(group.rgb[0]) << 16) | (asByte(group.rgb[1]) << 8) | asByte(group.rgb[2])
  const pickedColors = new Set<number>()
  const picked: Group[] = reserved.filter(group => {
    const key = paletteKey(group)
    if (pickedColors.has(key)) return false
    pickedColors.add(key)
    return true
  })
  const minDifferent = (Math.max(0, opt.mergeRange) / 100) ** 2 * 0.36
  const tryPick = (candidate: Group, allowClose = false): boolean => {
    if (picked.length >= colors) return false
    if (pickedColors.has(paletteKey(candidate))) return false
    if (!allowClose && picked.some(other => other.id === candidate.id || distance(other.lab, candidate.lab) <= minDifferent)) return false
    picked.push(candidate)
    pickedColors.add(paletteKey(candidate))
    return true
  }
  // 肤色优先竞争独立名额，不占用 accentSlots，仍受连通面积与近色过滤限制。
  const skinCandidates = groups
    .filter(g => g.maxComponent >= skinMinArea && skinToneStrength(g.lab) >= 0.5)
    .map(group => {
      const skin = skinToneStrength(group.lab)
      return { group, score: priorityScore(group, Math.max(colorVividness(group.lab), 0.75 * skin), Math.max(hueStrength(group.lab), skin), skinMinArea) }
    })
    .sort((a, b) => b.score - a.score || b.group.score - a.group.score || a.group.id - b.group.id)
  const targetSkins = clamp(Math.floor(opt.skinSlots), 0, colors - picked.length)
  let skinned = 0
  for (const { group } of skinCandidates) {
    if (skinned >= targetSkins) break
    if (tryPick(group)) skinned++
  }
  // 显著色按色相家族竞争，每个家族优先得到一个候选位。
  // 否则蓝色面积过大，同一个蓝色家族可能吃掉全部 accentSlots。
  const accentCandidates = groups
    .filter(g => g.maxComponent >= accentMinArea
      && colorVividness(g.lab) >= 0.25 && skinToneStrength(g.lab) < 0.5)
    .sort((a, b) => b.accentScore - a.accentScore || b.score - a.score)
  const family = (lab: Color): string => {
    const hue = (Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360
    if (hue < 35 || hue >= 345) return 'red'
    if (hue < 125) return 'yellow'
    if (hue < 205) return 'green'
    if (hue < 285) return 'blue'
    return 'purple'
  }
  const families = ['yellow', 'red', 'purple', 'blue', 'green'] as const
  let accented = 0
  const targetAccents = clamp(Math.floor(opt.accentSlots), 0, colors - picked.length)
  for (const name of families) {
    if (accented >= targetAccents) break
    const candidate = accentCandidates.find(g => family(g.lab) === name
      && !pickedColors.has(paletteKey(g))
      && !picked.some(p => p.id === g.id || distance(p.lab, g.lab) <= minDifferent))
    if (candidate && tryPick(candidate)) accented++
  }
  const rankedGroups = groups.slice().sort((a, b) => b.score - a.score || a.id - b.id)
  if (!automatic) {
    for (const group of rankedGroups) {
      if (picked.length >= colors) break
      tryPick(group)
    }
    // 如果距离阈值太大，允许补足手动指定的颜色位。
    if (picked.length < colors) {
      for (const group of rankedGroups) {
        if (picked.length >= colors) break
        if (!pickedColors.has(paletteKey(group))) {
          picked.push(group)
          pickedColors.add(paletteKey(group))
        }
      }
    }
  } else if (!picked.length) {
    tryPick(rankedGroups[0]!)
  }
  const palette: Color[] = picked.map(g => g.rgb.map(asByte) as Color)
  if (!palette.length) palette.push([0, 0, 0])

  // 6. 色距结合位置、同类特殊色奖励和纯黑白惩罚，仍按桶生成映射表。
  const positionWeight = clamp(opt.mappingPositionWeight, 0, 4)
  const specialWeight = clamp(opt.mappingSpecialWeight, 0, 4)
  const neutralPenalty = clamp(opt.mappingNeutralPenalty, 0, 4)
  const createCandidate = (rgb: Color, group: Group | undefined) => {
    const lab = toOklab(...rgb)
    return {
      lab,
      x: group ? group.xSum / group.area : 0.5,
      y: group ? group.ySum / group.area : 0.5,
      chroma: Math.hypot(lab[1], lab[2]),
      skin: skinToneStrength(lab),
      vivid: colorVividness(lab),
      hue: hueStrength(lab),
      neutral: rgb.every(channel => channel === 255) || rgb.every(channel => channel === 0)
    }
  }
  const candidates = palette.map((rgb, index) => createCandidate(rgb, picked[index]))
  const mappedBins = new Uint8Array(binGroups.length)
  const sources = bins.map(bin => ({
    bin,
    group: binGroups[bin.key]!,
    x: bin.xSum / bin.area,
    y: bin.ySum / bin.area,
    chroma: Math.hypot(bin.lab[1], bin.lab[2]),
    skin: skinToneStrength(bin.lab),
    vivid: colorVividness(bin.lab)
  }))
  const minCosts = new Float64Array(bins.length).fill(Infinity)
  const colorErrors = new Float64Array(automatic ? bins.length : 0)
  const lightnessErrors = new Float64Array(automatic ? bins.length : 0)
  const mapCandidate = (index: number) => {
    const candidate = candidates[index]!
    for (let i = 0; i < sources.length; i++) {
      const { bin, x, y, chroma, skin, vivid } = sources[i]!
      const colorDistance = distance(bin.lab, candidate.lab)
      const spatialDistance = (x - candidate.x) ** 2 + (y - candidate.y) ** 2
      const proximity = Math.exp(-8 * spatialDistance)
      const hueAffinity = clamp((bin.lab[1] * candidate.lab[1] + bin.lab[2] * candidate.lab[2])
        / Math.max(EPS, chroma * candidate.chroma), 0, 1) ** 2
      const specialMatch = Math.max(skin * candidate.skin,
         0.4 * hueAffinity * Math.min(vivid, candidate.vivid) * (0.65 + 0.35 * candidate.hue))
      const cost = colorDistance * (1 + (candidate.neutral ? neutralPenalty : 0))
        / (1 + positionWeight * proximity + specialWeight * specialMatch)
      if (cost < minCosts[i]!) {
        mappedBins[bin.key] = index
        minCosts[i] = cost
        if (automatic) {
          colorErrors[i] = colorDistance
          lightnessErrors[i] = (bin.lab[0] - candidate.lab[0]) ** 2
        }
      }
    }
  }
  for (let index = 0; index < candidates.length; index++) mapCandidate(index)

  if (automatic) {
    const skinSources = sources.map(source => source.skin >= 0.5 && groups[source.group]!.maxComponent >= skinMinArea)
    const skinArea = sources.reduce((sum, source, i) => sum + (skinSources[i] ? source.bin.area : 0), 0)
    const groupSkinAreas = new Float64Array(groups.length)
    for (let i = 0; i < sources.length; i++) {
      if (skinSources[i]) groupSkinAreas[sources[i]!.group]! += sources[i]!.bin.area
    }
    const groupLosses = new Float64Array(groups.length)
    const groupLightnessErrors = new Float64Array(groups.length)
    const measureError = () => {
      let colorError = 0, skinError = 0
      groupLosses.fill(0)
      groupLightnessErrors.fill(0)
      for (let i = 0; i < sources.length; i++) {
        const { bin, group } = sources[i]!
        const error = bin.area * colorErrors[i]!
        colorError += error
        groupLosses[group]! += error / (visible * AUTO_COLOR_ERROR ** 2)
        if (skinSources[i]) {
          const lightness = bin.area * lightnessErrors[i]!
          skinError += error
          groupLightnessErrors[group]! += lightness
          groupLosses[group]! += error / (skinArea * AUTO_SKIN_COLOR_ERROR ** 2)
            + lightness / (groupSkinAreas[group]! * AUTO_SKIN_LIGHTNESS_ERROR ** 2)
        }
      }
      const color = colorError / (visible * AUTO_COLOR_ERROR ** 2)
      const skin = skinArea > 0 ? skinError / (skinArea * AUTO_SKIN_COLOR_ERROR ** 2) : 0
      let lightness = 0
      for (let group = 0; group < groups.length; group++) {
        if (groupSkinAreas[group]! >= skinMinArea) {
          lightness = Math.max(lightness, groupLightnessErrors[group]! / (groupSkinAreas[group]! * AUTO_SKIN_LIGHTNESS_ERROR ** 2))
        }
      }
      return { satisfied: Math.max(color, skin, lightness) <= 1, score: color + skin + lightness }
    }
    let bestError = measureError()
    let bestCount = palette.length
    const bestMapping = mappedBins.slice()
    while (!bestError.satisfied && picked.length < colors) {
      let next: Group | undefined
      let largestLoss = EPS
      for (const group of rankedGroups) {
        if (!pickedColors.has(paletteKey(group)) && groupLosses[group.id]! > largestLoss) {
          next = group
          largestLoss = groupLosses[group.id]!
        }
      }
      if (!next) break
      // 质量未达标时允许补充近色，精确相同的输出 RGB 仍只占一个名额。
      tryPick(next, true)
      const rgb = next.rgb.map(asByte) as Color
      palette.push(rgb)
      candidates.push(createCandidate(rgb, next))
      mapCandidate(palette.length - 1)
      const error = measureError()
      if (error.satisfied || error.score < bestError.score - EPS) {
        bestError = error
        bestCount = palette.length
        bestMapping.set(mappedBins)
      }
    }
    // 映射奖励可能让真实色差反弹，保留评估过的最佳调色板前缀。
    palette.length = bestCount
    mappedBins.set(bestMapping)
  }
  const labels = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    const off = i * 4
    if (rgba[off + 3] === 0) continue
    labels[i] = mappedBins[pixelBins[i]!]!
  }
  const result: ColorAnalysis = { width, height, palette, labels, regions: [], ...(alpha ? { alpha } : {}) }
  // 7. 平滑边界
  result.labels = smoothColorRegions(result, rgba, opt.contourSteps, opt)
  // 8. 保存最终区域，避免复用选色前已经过时的连通关系。
  result.regions = extractRegions(result)
  return result
}
