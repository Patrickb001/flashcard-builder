import type { ReactNode } from 'react';

interface Props {
  /** The small caps line above the title, naming what the screen is for. */
  eyebrow: string;
  /** The screen's heading, usually the deck's name. */
  title: string;
  /** Anything sitting to the right of the title, such as the study tally. */
  children?: ReactNode;
}

/** The eyebrow-and-title masthead every deck screen opens with. */
export default function ScreenHeader({ eyebrow, title, children }: Props) {
  return (
    <div className="study-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {children}
    </div>
  );
}
