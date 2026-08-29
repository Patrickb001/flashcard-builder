# Flashcard Forge

Turn a PDF, PowerPoint, or Markdown file into a deck of flashcards, entirely in your browser. No backend, no account, no API key. Decks are saved to IndexedDB.

## Quick start

```bash
npm install
npm run dev
```

Open the printed URL (usually `http://localhost:5173`).

## Drafting modes

Cards can be drafted three ways, chosen on the upload screen:

- **Rules only** (default) — pattern rules run locally. Instant, private, free, and no key. Strongest on slide decks and tables, where the structure carries the meaning.
- **AI drafting** — the structured blocks are sent to Claude through a server-side endpoint that holds the API key, so visitors need no key of their own. Much stronger on prose documents. Locally this endpoint is served by the Vite dev server; in production it is the Netlify function. Either way, put `ANTHROPIC_API_KEY=sk-ant-...` in a `.env` file (already gitignored) and run `npm run dev`.
- **AI with my own key** — the browser calls Anthropic directly with a key you paste. Useful when running locally with no backend. The key is stored in your browser only; anyone who can run scripts on the page could read it, so use a low spend limit and avoid shared machines.

AI drafting always sends the **typed blocks**, never raw page text. This matters: raw text from a multi-column page has already lost its column boundaries, and a model handed scrambled columns will fluently assert things the document never said. Layout analysis is a prerequisite for the model, not an alternative to it.

If a batch fails, those sections fall back to rule-based drafting, so a network problem degrades the deck instead of emptying it.

See [DEPLOYING.md](DEPLOYING.md) for GitHub and Netlify setup.

## How extraction works

The hard part of this app is not making flashcards — it is reading the document correctly in the first place.

A naive PDF reader groups text by its vertical position. On a two-column slide that is actively wrong: a label in the left column and an unrelated bullet in the right column often share the exact same baseline, so they get merged into one line. That produces cards that look fluent and state something the source never said.

The pipeline avoids this in four steps, all in `src/lib/layoutAnalysis.ts`:

1. **Line assembly.** Text fragments join into a line only when they share a baseline *and* are horizontally adjacent (gap under ~1.6× the font size). The adjacency test is what keeps columns apart. Fragments are consumed in the order the PDF emits them, which already follows the document's own reading order; re-sorting by position would destroy that.
2. **Word repair.** PDFs split words at hyphens and sometimes mid-word. Fragments are rejoined using the gap plus the characters at the boundary, so `self` + `-` + `esteem` becomes `self-esteem` while `Describe` + `Erikson's` keeps its space.
3. **Table detection.** Column anchors are found by looking for x positions that recur down the page. Rows are grouped by column occupancy with a wrap threshold derived from the font size — gap statistics alone fail on tables whose cells all fit on one line, because then every gap is identical. A region is only accepted as a table if it has 3+ columns, no bullet glyphs, a complete short header row, and ≥85% filled cells; otherwise it is treated as a multi-column panel layout.
4. **Block segmentation.** What remains becomes typed blocks — headings, lists, and paragraphs — with running headers and footers dropped by frequency.

`.pptx` files skip most of this. A `.pptx` is a zip of OOXML, and the structure is still intact: shapes carry positions, tables are real `<a:tbl>` elements, and bullet levels are explicit. Reading shape by shape means columns never interleave, so a native `.pptx` generally yields better cards than the same deck exported to PDF.

Markdown skips all of it. The structure is written down rather than inferred, so `src/lib/markdownParser.ts` maps headings, lists, pipe tables, fenced code and paragraphs straight onto blocks. It is hand-rolled — no CommonMark dependency ships to the browser — and reads block structure only: YAML front matter and HTML comments are dropped, and inline markup is stripped so a card front reads as prose rather than as `**source _text_**`.

Two decisions do most of the work on a large file:

- **Code is content.** In a technical document the snippet *is* the answer to "how do I do this?". Dropping fenced code left whole sections as a heading with nothing under it, and the drafter had nothing to work from.
- **Sections are size-bounded.** The file is split at its shallowest heading level, and any section still over ~1200 characters is split again one level down. This matters because the model returns roughly the same number of cards per section whether that section is three paragraphs or a whole chapter — so section size, not document size, is what sets the yield. An 11 KB reference document goes from 5 sections to 22.

## How cards are generated

`src/lib/flashcardGenerator.ts` walks the typed blocks, with a rule per block type:

- **Tables** produce one atomic card per populated cell, plus a reverse-lookup card per row. Wording comes from `src/lib/phrasing.ts`, which picks a template from the shape of the labels rather than appending "?" to parsed text — an age-indexed row becomes "At 2 mo, what are the motor milestones?", a dimension row becomes "In normal aging, what is expected for memory?", and an attribute column becomes "What are the adult implications of the Avoidant pattern?".
- **Headings followed by prose** become definition pairs.
- **Inline labels** (`Substance use vulnerability:`) become the card front, with the following text as the back.
- **Age chips** next to a heading become a separate range card.
- **Lists** become either individual cards, when the bullets are `Term: definition`, or one set card.

Prose documents (articles, handbook pages) have no tables to mine, so each section also gets a summary card: the sentence that best explains the section's own title becomes the answer to "What is <title>?".

Every card carries the section or slide title as its **topic**, shown as a chip on the card face. This is what keeps a card like "What is Mother's request?" interpretable when it came from the middle of a long case vignette.

Every candidate then passes `src/lib/cardValidation.ts`, which rejects truncated fronts, answers over 60 words, boilerplate (learning objectives, references, agenda), web chrome (nav links, "On this page", footer controls), discourse markers mistaken for terms ("For example:", "Note:", "Remember:"), imperative lead-ins ("Notice two things here:"), sentence fragments containing pronouns, numeric-only fronts, and duplicates.

Generation is rule-based, with no external AI call, so review the draft deck before saving — the review screen exists for exactly that.

## Inspecting the pipeline

These harnesses run the real parsers over a file from Node:

```bash
npx tsx tools/test-layout.mjs        # dump the block structure per page
npx tsx tools/test-layout.mjs 13     # just page 13
npx tsx tools/test-cards.mjs         # dump every generated card

# Markdown, with no extra install — Node runs the real .ts modules
node --experimental-strip-types --experimental-loader ./tools/ts-ext-hooks.mjs \
  tools/test-md.mjs notes.md
```

Edit the `path` constant at the top of the PDF harnesses to point at your own file. These are the fastest way to see why a particular slide produced the cards it did.

## Limitations

- Scanned/image-only PDFs have no text layer and cannot be read; there is no OCR step.
- Very tight kerning between two full words can occasionally drop the space between them.
- All data lives in your browser's IndexedDB. Clearing site data deletes your decks.

## Tech stack

React + TypeScript + Vite, `pdfjs-dist` for PDF text, `jszip` for `.pptx`, a hand-rolled reader for `.md`, `idb` for IndexedDB.

## Build for production

```bash
npm run build
npm run preview
```
