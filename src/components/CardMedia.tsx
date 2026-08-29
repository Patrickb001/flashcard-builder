import { useState } from 'react';
import type { CardCode, CardImage } from '../types';
import { languageName } from '../lib/phrasing';

/**
 * The parts of a card that are not text.
 *
 * Shared between the review screen and study mode so a card looks the same in
 * both. A snippet that reads correctly while you are checking the draft and
 * then reflows into one line while you are studying is worse than no snippet.
 */

/** A snippet on a card face, with its indentation and line breaks intact. */
export function Snippet({ code }: { code: CardCode }) {
  const name = languageName(code.language);
  return (
    <div className="card-code">
      {name && <span className="card-code-lang">{name}</span>}
      <pre>
        <code>{code.text}</code>
      </pre>
    </div>
  );
}

/**
 * A diagram on a card face.
 *
 * The picture is stored by address, not copied into the deck, so it can fail to
 * load long after the card was made — the site may be down, or may have stopped
 * serving the file to other pages. The alt text is what the card falls back to,
 * because a card that silently shows nothing where its answer should be is
 * worse than one that says the picture is missing.
 */
export function Diagram({ image }: { image: CardImage }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <p className="card-image-missing">
        The diagram for this card could not be loaded{image.alt ? ` (${image.alt})` : ''}.
      </p>
    );
  }

  return (
    <img
      className="card-image"
      src={image.src}
      alt={image.alt ?? ''}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
