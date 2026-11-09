import { clamp, createPixelLabs, pixelDistance } from './math.js'
import type { AnaOptions, ColorAnalysis } from './types.js'

function normalizedLineWindow(value: number): number {
  const v = Math.max(3, Math.min(15, Math.round(value)))
  return v % 2 === 0 ? v + (v < 15 ? 1 : -1) : v
}

/**
 * 判断细线而不是孤立噪点：
 *  1. 当前标签在 7×7 附近较少见；
 *  2. 3×3 中存在同色连续像素，但不能是大块内部；
 *  3. 原图像素与身边其它标签的原图像素确实存在颜色反差。
 *  4. 单端点只能在连接到已确认细线时获得保护。
 * 掩码是以「平滑前的标签」为基础的，避免多轮平滑产生反馈偏差。
 */
function detectLineMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  labels: Uint8Array,
  labs: Float32Array,
  options: Pick<Required<AnaOptions>, 'lineWindow' | 'lineContrast' | 'lineMaxDensity'>
): Uint8Array {
  const mask = new Uint8Array(width * height)
  if (width < 3 || height < 3) return mask
  const radius = (normalizedLineWindow(options.lineWindow) - 1) >> 1
  const contrastSquared = Math.max(0, options.lineContrast) ** 2
  const densityLimit = clamp(options.lineMaxDensity, 0, 1)
  const alpha = (index: number): boolean => rgba[index * 4 + 3]! >= 128

  // 内层以 3×3 判断线的宽度和局部颜色反差。
  // 7×7 仅对稀疏的候选像素执行，避免对每个像素都重复扫描 49 次。
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const pos = y * width + x
      if (!alpha(pos)) continue
      const label = labels[pos]!
      let same = 0
      let different = 0
      let neighborDifference = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const other = pos + dy * width + dx
          if (!alpha(other)) continue
          if (labels[other] === label) {
            same++
          } else {
            different++
            neighborDifference += pixelDistance(labs, pos, other)
          }
        }
      }
      if (same === 0 || same > 5 || different < 2) continue
      // 使用原图像素对邻域其它颜色的均方根色距，不依赖量化后调色板。
      if (neighborDifference / different < contrastSquared) continue

      let own = 0
      let visible = 0
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          const other = yy * width + xx
          if (!alpha(other)) continue
          visible++
          if (labels[other] === label) own++
        }
      }
      if (visible < 8 || own / visible > densityLimit) continue
      // 相反方向的同色邻居表示穿过当前位置的线；仅对通过筛选的候选检查。
      const pairOpposite = (alpha(pos - 1) && alpha(pos + 1) && labels[pos - 1] === label && labels[pos + 1] === label)
        || (alpha(pos - width) && alpha(pos + width) && labels[pos - width] === label && labels[pos + width] === label)
        || (alpha(pos - width - 1) && alpha(pos + width + 1) && labels[pos - width - 1] === label && labels[pos + width + 1] === label)
        || (alpha(pos - width + 1) && alpha(pos + width - 1) && labels[pos - width + 1] === label && labels[pos + width - 1] === label)
      // 2 = 强线条，1 = 候选端点；后者需要连接到一个强线条才会保留。
      mask[pos] = pairOpposite || same >= 2 ? 2 : 1
    }
  }

  // 允许细线的末端/弯折，仅保护有足够邻近证据的像素，避免保住孤立杂点。
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const pos = y * width + x
      if (mask[pos] !== 1) continue
      let linked = false
      for (let dy = -1; dy <= 1 && !linked; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          if (mask[pos + dy * width + dx] === 2) {
            linked = true
            break
          }
        }
      }
      mask[pos] = linked ? 2 : 0
    }
  }
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 2) mask[i] = 1
  }
  return mask
}

/** 可选调试用：返回 0/1 掩码，1 表示平滑前被判为需要保护的细线。 */
export function createLineProtectionMask(
  rgba: Uint8ClampedArray,
  analysis: ColorAnalysis,
  options: Pick<Required<AnaOptions>, 'lineWindow' | 'lineContrast' | 'lineMaxDensity'>
): Uint8Array {
  const { width, height, labels } = analysis
  if (rgba.length < width * height * 4 || labels.length !== width * height) {
    throw new Error('getLineProtectionMask: image dimensions do not match')
  }
  const pixelLabs = createPixelLabs(rgba, width * height)
  return detectLineMask(rgba, width, height, labels, pixelLabs, {
    lineWindow: options.lineWindow,
    lineContrast: options.lineContrast,
    lineMaxDensity: options.lineMaxDensity
  })
}

/**
 * 有原图色彩引导的轮廓平滑：
 *  - 空间高斯投票保留旧版厚涂感；
 *  - 邻居与中心原图色距过大时降低投票权重，避免跨越真实边界；
 *  - 检测到的细切割线可以直接锁定、或在弱保护模式下获得额外票数；
 *  - 完全透明的像素不参与投票。
 */
export function smoothColorRegions(
  analysis: ColorAnalysis,
  rgba: Uint8ClampedArray,
  iterations: number,
  options: Required<AnaOptions>
): Uint8Array {
  const limit = Math.max(0, Math.min(16, Math.floor(iterations)))
  if (!limit || analysis.palette.length < 2) return analysis.labels
  const { width, height } = analysis
  const size = width * height
  const radius = 3
  const kernel = Float32Array.from(
    { length: radius * 2 + 1 },
    (_, i) => Math.exp(-((i - radius) ** 2) / (2 * 1.4 ** 2))
  )
  const sum = kernel.reduce((a, b) => a + b, 0)
  for (let i = 0; i < kernel.length; i++) kernel[i] = kernel[i]! / sum

  const labs = createPixelLabs(rgba, size)
  const protection = clamp(options.lineProtection, 0, 1)
  const protectedMask = protection > 0
    ? detectLineMask(rgba, width, height, analysis.labels, labs, options)
    : new Uint8Array(size)
  const sigma = Math.max(0.005, options.edgeSigma)
  const invColorVariance = 1 / (2 * sigma * sigma)
  let current = analysis.labels.slice()
  let next = new Uint8Array(size)
  const scores = new Float32Array(analysis.palette.length)
  const touched = new Uint8Array(kernel.length ** 2)

  for (let iteration = 0; iteration < limit; iteration++) {
    next.set(current)
    let changes = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pos = y * width + x
        if (!rgba[pos * 4 + 3]) continue
        const label = current[pos]!
        if (protectedMask[pos] && protection >= 0.999) continue
        if ((x === 0 || current[pos - 1] === label)
          && (x + 1 === width || current[pos + 1] === label)
          && (y === 0 || current[pos - width] === label)
          && (y + 1 === height || current[pos + width] === label)) continue

        let count = 0
        let totalWeight = 0
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = clamp(y + dy, 0, height - 1)
          const vertical = kernel[dy + radius]!
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = clamp(x + dx, 0, width - 1)
            const other = yy * width + xx
            const alpha = rgba[other * 4 + 3]! / 255
            if (alpha === 0) continue
            const neighborLabel = current[other]!
            const contrast = pixelDistance(labs, pos, other)
            const weight = vertical * kernel[dx + radius]! * Math.exp(-contrast * invColorVariance) * alpha
            if (weight < 1e-8) continue
            if (scores[neighborLabel] === 0) touched[count++] = neighborLabel
            scores[neighborLabel] = scores[neighborLabel]! + weight
            totalWeight += weight
          }
        }
        // 介于 0~1 时不硬锁，给细线额外的投票优势。
        if (protectedMask[pos] && protection > 0) scores[label] = scores[label]! + totalWeight * protection * 0.75
        let winner = label
        let maximum = scores[label]!
        for (let n = 0; n < count; n++) {
          const candidate = touched[n]!
          if (scores[candidate]! > maximum + totalWeight * 0.015) {
            winner = candidate
            maximum = scores[candidate]!
          }
        }
        for (let n = 0; n < count; n++) scores[touched[n]!] = 0
        // 上面的保护偏置可能为一个不在 touched 中的标签增加分数，单独复位。
        scores[label] = 0
        next[pos] = winner
        if (winner !== label) changes++
      }
    }
    const previous = current
    current = next
    next = previous
    if (changes === 0) break
  }
  return current
}
