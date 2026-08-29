import type { Block, TableBlock } from '../documentModel';
import { boldLead, isChrome, joinNodes, tag, textOf, tidyInline } from './domText';

/**
 * Lists and tables.
 *
 * Both are structure the page states outright, so there is no inference here -
 * only the care needed to keep a nested list from being read twice, and to tell
 * a layout table apart from one that carries data.
 */

/** Text of one list item, excluding any list nested inside it. */
export function ownText(li: Element): string {
  return tidyInline(
    joinNodes(Array.from(li.childNodes), (child) => tag(child) === 'ul' || tag(child) === 'ol')
  );
}

/**
 * Text of one list item, with a bolded lead-in restored as a term.
 *
 * Sites bold the term and leave the colon out of the markup, so
 * `<li><b>Iterable</b> the collection the loop goes through</li>` reads as one
 * run-on clause once the tags are gone. Putting the colon back is what lets the
 * card generator see a term and its definition instead of a sentence.
 */
export function itemText(li: Element): string {
  const lead = boldLead(li);
  if (lead && lead.rest.length >= 15 && lead.label.split(/\s+/).length <= 6) {
    const term = lead.label.replace(/[:\s]+$/, '');
    if (term) return `${term}: ${lead.rest}`;
  }
  return ownText(li);
}

/** Flattens a list, nested items included, the way the Markdown reader does. */
export function listItems(list: Element): string[] {
  const items: string[] = [];
  for (const li of Array.from(list.children)) {
    if (tag(li) !== 'li') continue;
    const own = itemText(li);
    if (own && !isChrome(own)) items.push(own);
    for (const nested of Array.from(li.children)) {
      if (tag(nested) === 'ul' || tag(nested) === 'ol') items.push(...listItems(nested));
    }
  }
  return items;
}

export function rowCells(row: Element): string[] {
  return Array.from(row.children)
    .filter((c) => tag(c) === 'td' || tag(c) === 'th')
    .map((c) => textOf(c));
}

export function parseTable(table: Element): Block[] {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length < 2) return [];

  const grid = rows.map(rowCells).filter((cells) => cells.length > 0);
  const [headers, ...body] = grid;

  if (!headers || headers.length < 2 || body.length === 0 || headers.some((h) => !h)) {
    // Not a usable header row — keep the text rather than dropping the table.
    return grid
      .map((cells) => cells.filter(Boolean).join(' — '))
      .filter((text) => !isChrome(text))
      .map((text) => ({ kind: 'paragraph', text }) as Block);
  }

  const width = headers.length;
  const normalized = body.map((cells) => {
    const padded = [...cells];
    while (padded.length < width) padded.push('');
    return padded.slice(0, width);
  });

  return [{ kind: 'table', headers, rows: normalized } as TableBlock];
}
