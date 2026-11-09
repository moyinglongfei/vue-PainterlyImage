import { analyzeImage } from './utils.js'
import type { AnaOptions, Color, ColorAnalysis, ColorRegion } from './types.js'
import { encodeAnalysisPng } from './png.js'

export { analyzePixels, defaultAnalysisOptions, getLineProtectionMask } from './ana.js'
export type { AnaOptions, Color, ColorAnalysis, ColorRegion } from './types.js'

export interface SimplifiedImageData {
  width: number
  height: number
  palette: [number, number, number][]
  labels: number[]
  /** 逐像素透明度，0~255；省略时全部不透明。 */
  alpha?: number[]
}

export interface SimplifiedImageRegions {
  version: 1
  width: number
  height: number
  colors: {
    color: Color
    regions: Omit<ColorRegion, 'label' | 'area'>[]
  }[]
}

/** 按颜色分组导出区域；省略逐像素标签和仅用于分析的面积。 */
export function toRegionJSON(analysis: ColorAnalysis): SimplifiedImageRegions {
  const colors: SimplifiedImageRegions['colors'] = analysis.palette.map(color => ({ color: [...color], regions: [] }))
  for (const region of analysis.regions) {
    colors[region.label]!.regions.push({
      bounds: [...region.bounds],
      ...(region.alpha !== undefined ? { alpha: region.alpha } : {}),
      ...(region.runs ? { runs: region.runs.map(([start, length]) => [start, length]) } : {})
    })
  }
  return {
    version: 1,
    width: analysis.width,
    height: analysis.height,
    colors: colors.filter(group => group.regions.length > 0)
  }
}

export interface SimplifiedImageComparison {
  png: Blob
  plainPng: Blob
  colorCount: number
  width: number
  height: number
}

export function simplifyImage(blob: Blob, format: 'comparison', options?: AnaOptions): Promise<SimplifiedImageComparison>
export function simplifyImage(blob: Blob, format: 'regions', options?: AnaOptions): Promise<SimplifiedImageRegions>
export function simplifyImage(blob: Blob, format: 'json', options?: AnaOptions): Promise<SimplifiedImageData>
export function simplifyImage(blob: Blob, format?: 'png', options?: AnaOptions): Promise<Blob>
export async function simplifyImage(blob: Blob, format: 'json' | 'png' | 'comparison' | 'regions' = 'png', options?: AnaOptions): Promise<SimplifiedImageData | SimplifiedImageComparison | SimplifiedImageRegions | Blob> {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()

    const analysis = await analyzeImage(image, options)
    const { width, height, palette, labels, alpha } = analysis

    if (format === 'regions') return toRegionJSON(analysis)

    if (format === 'json') {
      return { width, height, palette, labels: Array.from(labels), ...(alpha ? { alpha: Array.from(alpha) } : {}) }
    }

    const { png, plainPng } = await encodeAnalysisPng(analysis)
    if (format === 'comparison') return { png, plainPng, colorCount: palette.length, width, height }
    return png
  } finally {
    URL.revokeObjectURL(url)
  }
}
