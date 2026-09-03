import type { CardCode, CardImage } from '../../types';
import { Diagram, Snippet } from '../CardMedia';

/** The three things a card can carry besides its two lines of text. */
type Attachment = 'frontCode' | 'backCode' | 'image';

interface Props {
  /** The card or candidate whose attachments to show. */
  media: {
    frontCode?: CardCode;
    backCode?: CardCode;
    image?: CardImage;
  };
  /**
   * Offers a Remove button on each attachment, naming which one was removed.
   *
   * Omitted where attachments are shown but not editable — the deck manager
   * lists them read-only, because a snippet belongs to the source document and
   * there is nothing on that screen to write a replacement with.
   */
  onRemove?: (attachment: Attachment) => void;
}

/**
 * A card's snippets and diagram, tagged with which face each appears on.
 *
 * Shared by the review screen and the deck manager so a card looks the same
 * before and after it is saved — the two had grown separate copies of this
 * markup, which is exactly the kind of pair that drifts the first time only one
 * is edited.
 */
export default function CardAttachments({ media, onRemove }: Props) {
  if (!media.frontCode && !media.backCode && !media.image) return null;

  return (
    <div className="candidate-media">
      {media.frontCode && (
        <div className="candidate-attachment">
          <span className="attachment-tag">Shown with the question</span>
          <Snippet code={media.frontCode} />
          {onRemove && (
            <button className="ghost-btn small" onClick={() => onRemove('frontCode')}>
              Remove snippet
            </button>
          )}
        </div>
      )}
      {media.backCode && (
        <div className="candidate-attachment">
          <span className="attachment-tag">Shown with the answer</span>
          <Snippet code={media.backCode} />
          {onRemove && (
            <button className="ghost-btn small" onClick={() => onRemove('backCode')}>
              Remove snippet
            </button>
          )}
        </div>
      )}
      {media.image && (
        <div className="candidate-attachment">
          <span className="attachment-tag">Shown with the answer</span>
          <Diagram image={media.image} />
          {onRemove && (
            <button className="ghost-btn small" onClick={() => onRemove('image')}>
              Remove diagram
            </button>
          )}
        </div>
      )}
    </div>
  );
}
