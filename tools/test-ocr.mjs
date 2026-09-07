import fs from 'node:fs';
import { parseOcrResponse } from '../src/lib/ocrPrompt.ts';

function readKeyFromEnvFile() {
  try {
    return fs.readFileSync('.env', 'utf8').match(/ANTHROPIC_API_KEY=(.+)/)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

const key = process.env.ANTHROPIC_API_KEY ?? readKeyFromEnvFile();

/**
 * A real, tiny JPEG (generated via headless Chromium, not hand-rolled),
 * base64-encoded. Standing in for a rendered page image in these tests —
 * real transcription quality is verified manually against
 * docs/pdf-test/EXAM 1 STUDY GUIDE.pdf, per the design spec's Verification
 * section. This is genuinely valid image bytes, which is what Part 2 and
 * Part 3 below actually need: proof the multimodal request round-trips.
 */
const TEST_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBAUEBAYFBQUGBgYHCQ4JCQgICRINDQoOFRIWFhUSFBQXGiEcFxgfGRQUHScdHyIjJSUlFhwpLCgkKyEkJST/2wBDAQYGBgkICREJCREkGBQYJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCT/wAARCAAgACADASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AAAAAAAAA/9k=';

/**
 * Exercises the OCR transcription pipeline (src/lib/ocrPrompt.ts,
 * src/lib/aiTransport.ts, src/lib/ocrGenerator.ts) at increasing depth:
 *
 *   node --experimental-strip-types --import ./tools/register.mjs \
 *     tools/test-ocr.mjs
 *
 * The later parts call the real model, cost real money, and only run when
 * ANTHROPIC_API_KEY is set (shell env or a .env file), same as every other
 * tools/test-*.mjs script.
 */

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`);
};

// ---------------------------------------------------------------------------
// Part 1 — parseOcrResponse: pure, no API key needed.
// ---------------------------------------------------------------------------

console.log('Part 1 — parseOcrResponse\n');

const pages = [
  { pageNum: 1, label: 'Page 1' },
  { pageNum: 2, label: 'Page 2' },
  { pageNum: 3, label: 'Page 3' }, // deliberately not mentioned in the response below
];

const responseText = JSON.stringify([
  {
    page: 'Page 1',
    title: 'Preload',
    blocks: [
      {
        type: 'paragraph',
        heading: null,
        text: 'Preload is the volume of blood filling the ventricle at the end of diastole.',
      },
      { type: 'list', heading: 'Key terms', items: ['End-diastolic volume', 'Frank-Starling mechanism'] },
    ],
  },
  { page: 'Page 2', title: null, blocks: [] },
  { page: 'Page 99', title: 'Unmatched', blocks: [{ type: 'paragraph', heading: null, text: 'Ignored.' }] },
]);

const parsed = parseOcrResponse(responseText, pages);

check('two real pages produced sections', parsed.length === 2, `got ${parsed.length}`);
check(
  'Page 1 carries its pageNum, a title heading, a paragraph, and a list',
  parsed[0]?.pageNum === 1 && parsed[0]?.blocks.length === 3,
  JSON.stringify(parsed[0])
);
check(
  'Page 2 (nothing legible) still produced a section, with just its title-less empty blocks',
  parsed[1]?.pageNum === 2 && parsed[1]?.blocks.length === 0,
  JSON.stringify(parsed[1])
);
check(
  'Page 3 (never in the response) and "Page 99" (not a real page) produced nothing',
  !parsed.some((s) => s.label === 'Page 3' || s.label === 'Unmatched'),
  parsed.map((s) => s.label).join(', ')
);

// ---------------------------------------------------------------------------
// Part 2 — transport smoke test: does a multimodal OCR request round-trip?
// ---------------------------------------------------------------------------

console.log('\nPart 2 — multimodal transport\n');

if (!key) {
  console.log('  Skipped — set ANTHROPIC_API_KEY to run it.');
} else {
  const { callModel } = await import('../src/lib/aiTransport.ts');
  const { text } = await callModel('ocr', [{ page: 'Page 1' }], { mode: 'byok', apiKey: key }, undefined, [
    TEST_JPEG_BASE64,
  ]);
  console.log(`  Reply: ${text.slice(0, 300)}`);
  check('transport: got a non-empty reply for a multimodal OCR request', text.trim().length > 0);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} CHECK(S) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
