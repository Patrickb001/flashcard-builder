/**
 * Sanitizing the design call's HTML, kept apart from the prompt text so that
 * importing a prompt string does not drag a DOM implementation along with it
 * — the Netlify function imports the prompts and never runs this code.
 *
 * linkedom rather than the browser's own DOMParser, deliberately: this runs
 * client-side today, but the suite that exercises it runs in Node, and
 * security-critical code that cannot be tested is worse than a dependency.
 */

import { parseHTML } from 'linkedom';
import { stripJsonFence } from './textUtils';

const REMOVABLE_SELECTOR =
  'script, iframe, object, embed, meta[http-equiv="refresh"], base, template';
const DANGEROUS_URI_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction']);
const DANGEROUS_URI_RE = /^(javascript|data):/i;
/** Every C0 control plus space (U+0000-U+0020) — what a browser's URL parser strips before resolving a scheme. */
const URI_SCHEME_NOISE_RE = /[\x00-\x20]/g;

/**
 * Defense-in-depth, not the primary control — the primary control is that
 * this HTML is only ever rendered through a sandboxed iframe with no
 * allow-scripts (InfographicView.tsx), which cannot execute any of this
 * regardless. Parses the reply into a real DOM (linkedom — a pure-JS
 * implementation, so this stays safe to import into the Netlify function's
 * server bundle) and removes dangerous nodes/attributes structurally,
 * rather than pattern-matching strings, which a malformed or unusually
 * nested tag can evade.
 *
 * Not guaranteed to return its input unchanged even when the input was
 * already clean — see this plan's Global Constraints note on why tests
 * against this function assert on content survival, not byte equality.
 * The doctype is checked and restored explicitly, because losing it would
 * drop the rendered iframe into quirks mode.
 */
export function sanitizeInfographicHtml(html: string): string {
  const { document } = parseHTML(html);

  document.querySelectorAll(REMOVABLE_SELECTOR).forEach((el) => el.remove());

  document.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const isEventHandler = name.startsWith('on');
      // Strip ASCII whitespace and C0 controls before testing the scheme,
      // mirroring what a browser's URL parser does: `java&#9;script:alert(1)`
      // parses to a tab inside the scheme, which a leading-anchored \s* never
      // sees, but which the browser removes before resolving the URL.
      const normalized = attr.value.replace(URI_SCHEME_NOISE_RE, '');
      const isDangerousUri = DANGEROUS_URI_ATTRS.has(name) && DANGEROUS_URI_RE.test(normalized);
      if (isEventHandler || isDangerousUri) el.removeAttribute(attr.name);
    }
  });

  const serialized = document.toString();
  return /^\s*<!doctype html/i.test(serialized) ? serialized : `<!DOCTYPE html>${serialized}`;
}

/**
 * Slices the model's reply down to just the HTML document, tolerating a
 * markdown fence and prose either side of it, then sanitizes it.
 *
 * Returns null when no document is found at all — a reply that is pure
 * prose (a refusal, an apology) has nothing to render.
 */
export function parseDesignResponse(text: string): string | null {
  const cleaned = stripJsonFence(text);
  const lower = cleaned.toLowerCase();
  const doctypeIndex = lower.indexOf('<!doctype html');
  const htmlTagIndex = lower.indexOf('<html');
  const start = doctypeIndex !== -1 ? doctypeIndex : htmlTagIndex;
  const end = lower.lastIndexOf('</html>');
  if (start === -1 || end === -1 || end <= start) return null;

  const sliced = cleaned.slice(start, end + '</html>'.length);
  return sanitizeInfographicHtml(sliced);
}
