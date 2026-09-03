import { textOf } from './domText';

/**
 * Pulling code out of a page.
 *
 * Harder than it sounds for two reasons. A snippet's language is written down
 * in any of half a dozen places, none of them required; and documentation sites
 * publish the same program several times over behind language tabs, which read
 * as several unrelated snippets unless the tab strip is recognised as one.
 */

/** Language names worth recording, as they appear in class names. */
const CODE_LANGUAGES = new Set([
  'bash', 'c', 'cpp', 'cs', 'csharp', 'css', 'dart', 'diff', 'go', 'graphql', 'html', 'java',
  'javascript', 'js', 'json', 'jsx', 'kotlin', 'markdown', 'md', 'php', 'python', 'py',
  'ruby', 'rust', 'scala', 'scss', 'sh', 'shell', 'sql', 'swift', 'ts', 'tsx',
  'typescript', 'xml', 'yaml', 'yml',
]);

/** Attributes a site may use to declare a snippet's language. */
const LANGUAGE_ATTRS = ['data-code-lang', 'data-language', 'data-lang'];

/** A language declared on one element, by attribute or by class name. */
function declaredLanguage(el: Element): string | undefined {
  for (const attr of LANGUAGE_ATTRS) {
    const value = el.getAttribute(attr);
    const named = value ? normalizeLanguage(value) : '';
    if (named && CODE_LANGUAGES.has(named)) return named;
  }
  for (const token of (el.getAttribute('class') ?? '').toLowerCase().split(/[\s-]+/)) {
    const named = normalizeLanguage(token);
    if (CODE_LANGUAGES.has(named)) return named;
  }
  return undefined;
}

/**
 * The language of a snippet, from whatever convention the site uses.
 *
 * Sites declare it in three different places — on the `<pre>` itself
 * (`class="language-js"`), on the `<code>` inside it, or on a wrapper around
 * it. GeeksforGeeks uses the third: neither the `<pre>` nor its highlight
 * `<div>` names a language, and the tab panel above them carries
 * `data-code-lang`. So the search runs downward and then a short way up.
 */
export function codeLanguage(pre: Element): string | undefined {
  const own = declaredLanguage(pre);
  if (own) return own;

  const code = pre.querySelector('code');
  if (code) {
    const inner = declaredLanguage(code);
    if (inner) return inner;
  }

  // Bounded, so a language class on some unrelated page wrapper is never read
  // as this snippet's language.
  let parent = pre.parentElement;
  for (let depth = 0; parent && depth < 3; depth++) {
    const above = declaredLanguage(parent);
    if (above) return above;
    parent = parent.parentElement;
  }
  return undefined;
}

/**
 * Text of a snippet, with its line breaks.
 *
 * Editors and highlighters render each line as its own element, and reading
 * `textContent` off the parent would run every line together into one
 * unreadable string. Leaf line elements are joined back with newlines.
 */
export function codeText(pre: Element): string {
  const lineNodes = Array.from(pre.querySelectorAll('div')).filter(
    (d) => d.querySelectorAll('div').length === 0
  );
  const raw =
    lineNodes.length > 1
      ? lineNodes.map((d) => d.textContent ?? '').join('\n')
      : (pre.textContent ?? '');
  return raw.replace(/\u00a0/g, ' ').replace(/[ \t]+$/gm, '').trim();
}

/** Spellings a site may use for a language that has a canonical name here. */
const LANGUAGE_ALIASES: Record<string, string> = {
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  js: 'javascript',
  py: 'python',
  python3: 'python',
  ts: 'typescript',
};

function normalizeLanguage(raw: string): string {
  const name = raw.trim().toLowerCase();
  return LANGUAGE_ALIASES[name] ?? name;
}

/** True when an element is a tab's label rather than one of its panels. */
function isTabLabel(el: Element): boolean {
  for (const selector of ['pre', 'img', 'table', 'ul', 'ol']) {
    if (el.querySelector(selector)) return false;
  }
  return textOf(el).length <= 40;
}

/**
 * The panels of a code tab strip, in the order the page lists them.
 *
 * Tutorial sites publish the same example several times over — C++, C, Java,
 * Python, C#, JavaScript — behind a row of tabs. A reader sees one of them; all
 * six sit in the markup, so a parser that simply walks the DOM emits six
 * snippets where the page shows one. That inflated the drafting payload
 * sixfold and produced six near-identical cards for a single idea.
 *
 * A strip is recognised structurally rather than by class name: every child is
 * either a panel declaring its own language or a short tab label. Demanding
 * that of *every* child is what stops an ordinary section wrapper that happens
 * to contain one snippet from being taken for a strip and having the rest of
 * its content skipped.
 */
export function languageTabPanels(el: Element): { language: string; pre: Element }[] | null {
  const children = Array.from(el.children);
  if (children.length === 0) return null;

  // Cheap test first. This runs on every wrapper the walk descends through, and
  // the full test searches each child's subtree for a <pre> — on a long page
  // that is a scan of the document per wrapper. A strip always declares a
  // language on one of its panels, so an element with none is not one.
  const declaresLanguage = children.some((child) =>
    LANGUAGE_ATTRS.some((attr) => child.getAttribute(attr))
  );
  if (!declaresLanguage) return null;

  const panels: { language: string; pre: Element }[] = [];
  for (const child of children) {
    const declared = LANGUAGE_ATTRS.map((attr) => child.getAttribute(attr)).find(Boolean);
    const pre = child.querySelector('pre');
    if (declared && pre) {
      panels.push({ language: normalizeLanguage(declared), pre });
      continue;
    }
    if (isTabLabel(child)) continue;
    return null;
  }

  if (panels.length === 0) return null;
  // One program shown several ways, or several different programs that happen
  // to sit side by side? Languages being distinct throughout is what tells the
  // two apart: a repeat means these panels are not alternates of each other.
  const languages = new Set(panels.map((p) => p.language));
  return languages.size === panels.length ? panels : null;
}
