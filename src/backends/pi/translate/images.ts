/**
 * pi image content (`{type: 'image', data: <base64>, mimeType}`) as lazy
 * transcript facades, and composer images as pi image content. pi resizes
 * images to the model's limits itself and turns an image the model cannot
 * take into a text note, so the limits here only keep a message sane.
 */
import type { ImageLimitsView } from '../../../agent/capabilities.js'
import type { ImageRef } from '../../../agent/events.js'
import { probeImageSize } from '../../shared/image-size.js'
import { piText } from '../text.js'
import { arr, rec, str } from '../narrow.js'

export const PI_IMAGE_LIMITS: ImageLimitsView = Object.freeze({
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 50 * 1024 * 1024,
  maxImageDimension: 2048,
  maxImagePixels: 2048 * 2048,
})

const PROBE_CHARS = 87_384

/** pi's image content block. */
export interface PiImageContent {
  readonly type: 'image'
  readonly data: string
  readonly mimeType: string
}

/** A base64 image as a lazy facade (measured on first use). */
export function base64ImageFacade(id: string, mediaType: string, data: string): ImageRef {
  let size: { readonly width: number; readonly height: number } | null | undefined
  const measure = () => {
    if (size === undefined) size = probeImageSize(Buffer.from(data.slice(0, PROBE_CHARS), 'base64')) ?? (data.length > PROBE_CHARS ? probeImageSize(Buffer.from(data, 'base64')) : null)
    return size
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return {
    id, mediaType, bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding),
    get width() { return measure()?.width ?? 1 },
    get height() { return measure()?.height ?? 1 },
    async read(signal) { signal?.throwIfAborted(); return new Uint8Array(Buffer.from(data, 'base64')) },
  }
}

/** The image blocks of a pi content array, as facades in content order. */
export function contentImages(content: unknown, idPrefix: string): ImageRef[] {
  const images: ImageRef[] = []
  arr(content).forEach((raw, index) => {
    const block = rec(raw)
    const data = str(block?.data)
    const mimeType = str(block?.mimeType)
    if (block?.type !== 'image' || data === undefined || data === '' || mimeType === undefined) return
    images.push(base64ImageFacade(`${idPrefix}#${index}`, mimeType.toLowerCase(), data))
  })
  return images
}

/** Read and check composer images before a prompt is sent. */
export async function piImageContent(images: readonly ImageRef[], limits: ImageLimitsView = PI_IMAGE_LIMITS): Promise<PiImageContent[]> {
  if (images.length > limits.maxImagesPerMessage) throw new Error(piText('pi-images-too-many', { n: limits.maxImagesPerMessage }))
  const out: PiImageContent[] = []
  let total = 0
  for (const image of images) {
    const name = image.name ?? image.id
    const type = image.mediaType
    if (type === undefined || !limits.mediaTypes.includes(type)) throw new Error(piText('pi-image-type-refused', { name, type: type ?? '?' }))
    let data: Uint8Array
    try { data = await image.read() } catch { throw new Error(piText('pi-image-unreadable', { name })) }
    if (data.byteLength > limits.maxImageBytes) throw new Error(piText('pi-image-too-large', { name, mb: Math.round(limits.maxImageBytes / (1024 * 1024)) }))
    total += data.byteLength
    if (total > limits.maxMessageImageBytes) throw new Error(piText('pi-images-too-large', { mb: Math.round(limits.maxMessageImageBytes / (1024 * 1024)) }))
    out.push({ type: 'image', data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'), mimeType: type })
  }
  return out
}
