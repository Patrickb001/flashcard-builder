/** Splits a count into groups of five, the way tally marks are gated. */
function tallyGroups(count: number): number[] {
  const groups: number[] = [];
  let remaining = count;
  while (remaining > 0) {
    groups.push(Math.min(5, remaining));
    remaining -= 5;
  }
  return groups;
}

interface Props {
  /** How many marks to draw. Zero renders a dash rather than nothing. */
  count: number;
}

/**
 * A running count drawn as chalk tally marks, five to a gate.
 *
 * Knows nothing about decks or cards — it counts. The fifth stroke of each
 * group is drawn diagonally by CSS, keyed off its index.
 */
export default function Tally({ count }: Props) {
  if (count === 0) return <span className="tally-zero">—</span>;

  return (
    <span className="tally">
      {tallyGroups(count).map((groupSize, groupIndex) => (
        <span className="tally-group" key={groupIndex}>
          {Array.from({ length: groupSize }).map((_, i) => (
            <i key={i} className={`tally-stroke stroke-${i}`} />
          ))}
        </span>
      ))}
    </span>
  );
}
