import { ANALYSIS_MAX_SIZE, analyzePixels } from './ana.js'
import type { AnaOptions, ColorAnalysis } from './types.js'

export function createColorPixels(analysis: ColorAnalysis) {
  const { palette, labels, alpha } = analysis
  const pixels = new Uint8ClampedArray(labels.length * 4)
  for (let i = 0; i < labels.length; i++) {
    const opacity = alpha?.[i] ?? 255
    if (!opacity) continue
    pixels.set(palette[labels[i]!]!, i * 4)
    pixels[i * 4 + 3] = opacity
  }
  return { pixels, labels }
}

export async function analyzeImage(image: HTMLImageElement, options: AnaOptions = {}): Promise<ColorAnalysis> {
  const scale = Math.min(1, ANALYSIS_MAX_SIZE / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })
  if (!context) throw new Error('无法创建背景分析画布')
  context.drawImage(image, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height).data
  canvas.width = canvas.height = 0
  return analyzePixels(pixels, width, height, options)
}
