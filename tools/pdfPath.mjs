import fs from 'node:fs';

/**
 * The PDF a harness script should read, from the PDF environment variable.
 *
 * These scripts run against whatever document you are debugging rather than a
 * checked-in fixture, because the layout bugs they exist to find only show up in
 * real course material — which is far too large, and usually too copyrighted, to
 * commit. There is deliberately no default: an absent one is a clear error here
 * rather than a confusing stack trace inside pdf.js.
 */
export function requirePdfPath() {
  const path = process.env.PDF;

  if (!path) {
    console.error('Set PDF to the document to read, e.g.\n');
    console.error('  PDF=./lecture.pdf node --experimental-strip-types \\');
    console.error('    --import ./tools/register.mjs tools/test-layout.mjs\n');
    process.exit(1);
  }

  if (!fs.existsSync(path)) {
    console.error(`No such file: ${path}`);
    process.exit(1);
  }

  return path;
}
