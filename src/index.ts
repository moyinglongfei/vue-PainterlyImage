export {
  simplifyImage,
  analyzePixels,
  toRegionJSON,
  getLineProtectionMask,
  defaultAnalysisOptions
} from './utils/simplifyImage/index.js'
export { regionJSONToPixels } from './utils/simplifyImage/render.js'
export type {
  AnaOptions,
  Color,
  ColorAnalysis,
  ColorRegion,
  SimplifiedImageData,
  SimplifiedImageRegions,
  SimplifiedImageComparison
} from './utils/simplifyImage/index.js'
