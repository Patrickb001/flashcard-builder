import { danglingReference, flagDanglingReference } from '../src/lib/cardValidation.ts';

/**
 * The check for card fronts that point at something the student cannot see.
 *
 *   node --experimental-strip-types --import ./tools/register.mjs tools/test-card-references.mjs
 *
 * Pure; no key. The false-positive cases matter as much as the hits: a flag
 * that is usually wrong teaches people to ignore it.
 */

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`
  );
}

const front = (text, extra = {}) => ({ front: text, ...extra });
const code = { text: 'print(1)', language: 'python' };

console.log('FLAGGED');
check(
  'the card that prompted this',
  danglingReference(front('In this example, which functions does React call while rendering the Gallery component?')),
  'this example'
);
check('a diagram is never on the front', danglingReference(front('What does this diagram show?')), 'this diagram');
check('even when the card has an image', danglingReference(front('What does this diagram show?', { image: 'i1' })), 'this diagram');
check('"the following" before a noun', danglingReference(front('What does the following code print?')), 'the following code');
check('a bare "the above" at the end', danglingReference(front('Which of these is described by the above?')), 'the above');
check('"shown below"', danglingReference(front('What does the table shown below list?')), 'shown below');
check('plural nouns', danglingReference(front('What do these examples have in common?')), 'these examples');
check('capitalised', danglingReference(front('This program prints what?')), 'This program');
check(
  'code words are flagged when no snippet is attached',
  danglingReference(front('What does this program print?')),
  'this program'
);

console.log('\nNOT FLAGGED');
check('an attached snippet makes "this program" fine', danglingReference(front('What does this program print?', { frontCode: code })), null);
check('... and "the following code"', danglingReference(front('What does the following code output?', { frontCode: code })), null);
check('but a snippet does not excuse a diagram', danglingReference(front('What does this diagram show?', { frontCode: code })), 'this diagram');
check('an ordinary question', danglingReference(front('What are the three steps of a React render?')), null);
check('"this" before an ordinary noun', danglingReference(front('Why does this pattern avoid a race condition?')), null);
check('"example" used as a verb-free noun without a demonstrative', danglingReference(front('What is an example of a pure function?')), null);
check('"following" as an ordinary word', danglingReference(front('What happens following a state update?')), null);
check('"the following day"', danglingReference(front('What changes the following day?')), null);
check('"that" is deliberately not caught', danglingReference(front('What does a component that mutates props break?')), null);
check('words that merely contain a noun', danglingReference(front('Which textbook introduced this programmer to recursion?')), null);

console.log('\nFLAGGING A CANDIDATE');
const candidate = { front: 'In this example, which hook runs first?', back: 'useState.', sourceLabel: 'Page 1', include: true };
check('a dangling card is unticked', flagDanglingReference(candidate).include, false);
check('... and otherwise unchanged', { ...flagDanglingReference(candidate), include: true }, candidate);
const clean = { ...candidate, front: 'Which hook runs first when a component mounts?' };
check('a clean card is returned untouched', flagDanglingReference(clean) === clean, true);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
