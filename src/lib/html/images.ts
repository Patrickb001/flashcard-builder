import type { Block, ImageBlock } from '../documentModel';

/**
 * Diagrams worth keeping.
 *
 * Most images on a documentation page are furniture: icons, avatars, spacers,
 * tracking pixels. The filters here are about size and naming, because a
 * diagram that answers a question and an icon that decorates a heading are
 * indistinguishable by markup alone.
 */

/**
 * File names that mark an image as furniture.
 *
 * Tested against the file name rather than the whole address, because a CDN
 * path routinely contains a word like "banner" in a directory that has nothing
 * to do with the picture itself.
 */
export const ICON_NAMES =
  /(^|[/_.-])(logos?|icons?|sprite|avatar|profile|badge|spinner|loader|pixel|beacon|tracking|ads?|advert|banner|thumb|placeholder|emoji|flag|arrow|chevron|caret|star|share|bullet|divider|separator)([/_.-]|$)/i;

/** Alt text that describes a control rather than a picture. */
export const ICON_ALT =
  /^(logo|icon|search( icon)?|menu|close|arrow|location|share|image|picture|photo|banner|ad|advertisement|avatar|profile|user|star|rating|thumbnail|placeholder|loading)$/i;

/** Below this an image is a spacer or a bullet, not a diagram. */
export const MIN_IMAGE_PX = 100;

/** An inline data URI larger than this is not worth carrying on every card. */
export const MAX_DATA_URI_CHARS = 200_000;

/** A dimension attribute, when it is a plain number rather than "inherit" or "100%". */
export function pixelAttr(img: Element, name: string): number | null {
  const m = (img.getAttribute(name) ?? '').trim().match(/^(\d+)(px)?$/i);
  return m ? Number(m[1]) : null;
}

/** The address an image loads from, lazy-loading attributes included. */
export function imageSource(img: Element): string | null {
  for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
    const value = (img.getAttribute(attr) ?? '').trim();
    if (value) return value;
  }
  // A srcset-only image: its first candidate is enough to identify it.
  const first = (img.getAttribute('srcset') ?? '').trim().split(',')[0]?.trim().split(/\s+/)[0];
  return first || null;
}

/**
 * An image block, or null when the image is furniture.
 *
 * The address is made absolute here. A card outlives the page it was drafted
 * from and is stored on its own, so a relative path would later resolve against
 * the app's own origin and load nothing — which is why an image with no usable
 * base is dropped rather than kept and left broken.
 */
export function imageBlock(img: Element, baseUrl?: string): ImageBlock | null {
  const raw = imageSource(img);
  if (!raw) return null;

  const alt = (img.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim();
  if (ICON_ALT.test(alt)) return null;

  // Only a declared size counts. "inherit" and "100%" say nothing about how big
  // the picture actually is, and pixelAttr reports those as unknown.
  const width = pixelAttr(img, 'width');
  const height = pixelAttr(img, 'height');
  if ((width !== null && width < MIN_IMAGE_PX) || (height !== null && height < MIN_IMAGE_PX)) {
    return null;
  }

  let src: string;
  if (/^data:/i.test(raw)) {
    if (!/^data:image\//i.test(raw) || raw.length > MAX_DATA_URI_CHARS) return null;
    src = raw;
  } else {
    let resolved: URL;
    try {
      resolved = new URL(raw, baseUrl);
    } catch {
      return null;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    if (ICON_NAMES.test(resolved.pathname)) return null;
    src = resolved.toString();
  }

  return { kind: 'image', src, alt: alt || undefined };
}

/** Pushes every content image inside an inline container, in document order. */
export function pushImages(el: Element, blocks: Block[], baseUrl?: string): void {
  for (const img of Array.from(el.querySelectorAll('img'))) {
    const block = imageBlock(img, baseUrl);
    if (block) blocks.push(block);
  }
}
