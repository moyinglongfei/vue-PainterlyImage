export type Color = [number, number, number]

export interface ColorAnalysis {
  width: number
  height: number
  palette: Color[]
  labels: Uint8Array
  /** 平滑后提取的最终区域；完全透明像素不包含在内。 */
  regions: ColorRegion[]
  /** 逐像素透明度；省略时全部不透明。 */
  alpha?: Uint8Array
}

export interface ColorRegion {
  /** 调色板索引。 */
  label: number
  /** [x, y, width, height]，坐标基于分析后的图像。 */
  bounds: [x: number, y: number, width: number, height: number]
  /** 实际像素数量，不按透明度加权。 */
  area: number
  /** 省略时为 255；同一区域内的透明度一致。 */
  alpha?: number
  /** [起始位置, 长度]；位置基于包围盒内的行优先索引，可跨行。省略表示完整矩形。 */
  runs?: [start: number, length: number][]
}

export interface AnaOptions {
  colors?: number | 'auto'
  centerWeight?: number
  specialWeight?: number
  anchorMinPercent?: number
  mergeRange?: number
  mergeSpatialRadius?: number
  mergeLightnessWeight?: number
  mappingPositionWeight?: number
  mappingSpecialWeight?: number
  mappingNeutralPenalty?: number
  contourSteps?: number
  connectedPower?: number
  scatteredFloor?: number
  areaPower?: number
  accentSlots?: number
  accentMinArea?: number
  skinSlots?: number
  skinMinArea?: number
  edgeWeight?: number
  lineProtection?: number
  lineWindow?: number
  lineContrast?: number
  lineMaxDensity?: number
  edgeSigma?: number
}

export interface Bin {
  key: number
  /** 局部分桶时保留原始 RGB 桶编号，key 则为连续的局部桶编号。 */
  colorKey?: number
  area: number
  weightedArea: number
  redSum: number
  greenSum: number
  blueSum: number
  /** 归一化位置的透明度加权总和，除以 area 得到重心。 */
  xSum: number
  ySum: number
  lab: Color
}
export interface Group {
  id: number
  area: number
  weightedArea: number
  redSum: number
  greenSum: number
  blueSum: number
  xSum: number
  ySum: number
  lab: Color
  rgb: Color
  /** 各连通块面积的 p 次幂之和。 */
  areaPowerSum: number
  maxComponent: number
  /** 具备连续面积的醒目色局部边界对比奖励。 */
  strongestEdge: number
  score: number
  accentScore: number
}
