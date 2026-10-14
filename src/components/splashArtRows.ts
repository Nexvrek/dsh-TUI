import type { Brand } from '../branding.js'

/** 启动页立绘槽的占行：鲸鱼自然高度、portrait 的 minimal 等高盒、吉祥物的侧栏默认盒。 */
export const WHALE_ART_ROWS = 13
export const PORTRAIT_ART_ROWS = 11
export const MASCOT_ART_ROWS = 15

export type SplashArtForm = 'whale' | 'portrait' | 'mascot'
export interface SplashImageBox {
  readonly columns: number
  readonly rows: number
}

/** 与 LogoV2 的默认品牌及 mascot → portrait → whale 分支一致。 */
export function resolveSplashArtForm(input: {
  readonly brand: Brand | undefined
  readonly whaleGirl: boolean
  readonly mascotSkin: string | undefined
}): SplashArtForm {
  const brand = input.brand ?? 'deepseek'
  if (brand === 'deepseek' && (input.mascotSkin === 'deepy' || input.mascotSkin === 'whaleGirl')) return 'mascot'
  if (input.whaleGirl || brand !== 'deepseek') return 'portrait'
  return 'whale'
}

export function splashArtRows(form: SplashArtForm, imageBox?: SplashImageBox): number {
  if (form === 'whale') return WHALE_ART_ROWS
  if (form === 'portrait') return PORTRAIT_ART_ROWS
  return imageBox?.rows ?? MASCOT_ART_ROWS
}

/**
 * 启动页图片按原生画布占位：只缩小、不预留放大后用不上的空间。
 * 同一个稳定画布用于全部动画帧；不按 alpha 包围盒逐帧裁剪。
 */
export function fitSplashImageBox(
  source: { readonly width: number; readonly height: number },
  cell: { readonly width: number; readonly height: number },
  limit: SplashImageBox,
): SplashImageBox {
  const scale = Math.min(1, limit.columns * cell.width / source.width, limit.rows * cell.height / source.height)
  return {
    columns: Math.max(1, Math.min(limit.columns, Math.ceil(source.width * scale / cell.width))),
    rows: Math.max(1, Math.min(limit.rows, Math.ceil(source.height * scale / cell.height))),
  }
}
