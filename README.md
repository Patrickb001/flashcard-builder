# Flashcard Forge

Turn a PDF, PowerPoint, Markdown file, or web page into a deck of flashcards, in your browser. No backend, no account, no API key. Decks are saved to IndexedDB.

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

A web page needs a different kind of work: the structure is there, but so is everything else. `src/lib/htmlParser.ts` is mostly subtractive — strip scripts, navigation, banners and complementary landmarks; pick the element that holds the article (`article`, then `main`, then the usual CMS containers) rather than the largest one, since `main` normally contains the article *and* the page's furniture; then map the surviving elements onto the same blocks. Along the way it drops link-only rows (pagers, breadcrumbs), demotes callout headings like "Note" and "Pitfall" so they cannot name a section, and cuts appendices — "References", "External links", "See also" — which otherwise become sections asking what citation 47 was.

Tutorial sites need four more things on top of that, and a deck built from one is poor without them:

- **A snippet has to stay a snippet.** `<code>` is an inline tag, but a `<code>` wrapping a `<pre>` is how several sites mark up a code panel. Read as prose, a program loses its line breaks and gains a space at every highlight span — `System. out. print`. Only the whole subtree tells the two apart.
- **A language tab strip is one snippet, not six.** Sites publish the same example in C++, C, Java, Python, C# and JavaScript behind a row of tabs. All six sit in the markup, so a plain DOM walk emits six snippets where the page shows one — sixfold payload, six near-identical cards. A strip is recognised structurally (every child is a panel declaring its language, or a short tab label), the page's own first tab is kept, and the rest are recorded by name.
- **A bold line is a heading.** Pages written in a visual editor carry two or three real headings and mark every other subtopic as a bolded line. Left as paragraphs they leave the whole article as one undivided section: the six kinds of `for` loop went from one section to six once those lines were promoted.
- **"Output" belongs to the program above it.** A tutorial publishes the program, the word "Output", and what it prints as three separate blocks. Folded back together they are one good card; apart, they are three poor ones.

Diagrams are kept too — a flowchart is often the clearest answer a page has. An image survives only if it looks like content rather than furniture (name, alt text and declared size all get a say), and its address is made absolute against the page it came from, because a card outlives the page and a relative path would resolve against this app later and load nothing.

Pages are fetched by the app's own server, because a browser is not allowed to read another site's HTML. That endpoint is the one piece of this app with a security story worth reading: see `src/lib/fetchPage.ts` and the deployment notes.

Several addresses can go in at once — one per line — and become a single deck. They are read one at a time, a page that fails is reported rather than sinking the batch, and each card's source label names the page it came from. Ten pages is the maximum for one deck.

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

## Testing a deck

A saved deck can be studied or **tested**. A test is multiple choice, graded on the
spot with no model call — which is the whole reason the questions are written once and
kept rather than drafted each time. Once a deck has its questions, testing works
offline and costs nothing.

Two question styles, chosen on the setup screen and stored side by side, so a deck can
have both:

- **Recall** — one fact per question, four options. The stem rewords the card's front
  and the answer is its back.
- **PANCE style** — a short clinical vignette, a board-style lead-in ("Which of the
  following is the most likely diagnosis?"), and five options. Written for PA students
  revising for the boards.

The vignette style is deliberately constrained: every clinical fact must come from the
deck's own cards, and the model may invent only the patient wrapper — an age, a sex,
and a presentation the cards themselves describe. Never a vital sign, a lab value or a
finding the lecture did not teach. A card that cannot carry a scenario without
inventing one — a definition, a drug interaction list, a therapeutic range — gets a
direct board-style question and no patient instead. Studying a fabricated finding as
though it were examinable is worse than having one fewer question, so the prompt is
written to leave the gap rather than fill it.

The questions themselves need the AI helper, so "Test this deck" opens a setup screen
that carries the drafting-mode panel inline when AI is off; there is no need to go
back to the upload screen to switch it on. The first launch writes one question per
card and stores them — eight cards to a request for recall questions, four for the
costlier vignettes — saving each batch as it lands so an
interrupted run keeps everything it earned. Cards added later — or edited, which is
noticed by a content hash rather than a save timestamp, since the deck manager writes
a card on every blur — are offered on the next launch as "some questions are missing".
Writing them is a button, never automatic: no test should wait on an API call because
somebody fixed a typo.

There is deliberately **no rule-based fallback**. Rules can pull a question and an
answer out of a document, but nothing offline can invent three plausible-but-wrong
answers, so a card that fails simply has no question and the screen says so.

Two details do the work in `src/lib/quizPrompt.ts`. Wrong answers are drawn first
from other answers in the same deck — the adjacent stage of a sequence, the next row
of the same table — because a near miss tests whether you can tell two real things
apart, while an unrelated fact is a giveaway. And every wrong answer must be
*unambiguously* wrong: a distractor that is arguably also correct marks a student
down for knowing the material, so a question the model cannot do this for is dropped
rather than shipped. `parseQuizResponse` enforces what it can — three distinct
options, none restating the answer — and recovers the intact questions from a reply
that was cut off mid-array.

Which questions a test asks is `src/lib/quizSelection.ts`. Questions are tiered by
how often they have been asked and a tier is emptied before the next is touched, so
nothing repeats until everything has been asked once, with the order random inside
each tier. Option order is shuffled at presentation rather than stored, so a model
that likes to list the answer first cannot put it in slot A for every sitting. The
counter moves as each answer is committed, not at the end, so quitting a test part
way still counts what you did and leaves the rest untouched.

## Inspecting the pipeline

These harnesses run the real parsers over a file from Node:

```bash
npx tsx tools/test-layout.mjs        # dump the block structure per page
npx tsx tools/test-layout.mjs 13     # just page 13
npx tsx tools/test-cards.mjs         # dump every generated card

# Markdown and HTML, with no extra install — Node runs the real .ts modules
node --experimental-strip-types --import ./tools/register.mjs \
  tools/test-md.mjs notes.md
node --experimental-strip-types --import ./tools/register.mjs \
  tools/test-html.mjs saved-page.html
URL=https://18.react.dev/learn/state-a-components-memory node \
  --experimental-strip-types --import ./tools/register.mjs \
  tools/test-html.mjs

# Test questions: parser and selection checks always run; add a key to also
# generate real questions and read the wrong answers for yourself.
node --experimental-strip-types --import ./tools/register.mjs \
  tools/test-quiz.mjs
```

`tools/test-quiz.mjs` is the one to run after touching question generation. It
asserts what can be asserted — that a truncated reply still yields its complete
questions, that a distractor never restates the answer, that three tests of ten over
a pool of thirty cover it exactly once before anything repeats, that the correct
answer moves between option slots — and then prints the generated questions, because
whether a wrong answer is *actually wrong* is the one thing no assertion can decide.

Edit the `path` constant at the top of the PDF harnesses to point at your own file. These are the fastest way to see why a particular slide produced the cards it did.

## Limitations

- Scanned/image-only PDFs have no text layer and cannot be read; there is no OCR step.
- A page that builds itself in the browser (an app shell with no server-rendered text) comes back empty; the reader fetches HTML, it does not run JavaScript.
- Pages behind a login or a bot check cannot be read.
- Very tight kerning between two full words can occasionally drop the space between them.
- Diagrams on cards are stored by address, not copied into the deck. If the source site stops serving the file, the card falls back to the image's alt text.
- All data lives in your browser's IndexedDB. Clearing site data deletes your decks.
- Writing a deck's test questions needs the AI helper. Taking a test afterwards does not.
- A test question is written once. If one comes out ambiguous there is no way to
  regenerate just that question yet — deleting its card and adding it back is the
  workaround.
- If the app is open in two tabs when a new version upgrades the database, the upgrade
  waits for the older tab to close. That is logged to the console; close the other
  tabs and reload.

## Tech stack

React + TypeScript + Vite, `pdfjs-dist` for PDF text, `jszip` for `.pptx`, hand-rolled readers for `.md` and HTML (the browser's own `DOMParser` does the tokenizing), `idb` for IndexedDB. `linkedom` is a devDependency only: it stands in for the DOM so the test harnesses can run the real parsers under Node.

## Build for production

```bash
npm run build
npm run preview
```
