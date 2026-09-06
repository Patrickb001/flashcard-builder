interface Props {
  /** How far along, 0 to 1. Values outside that range are clamped. */
  fraction: number;
}

/**
 * The thin progress rail used by study, testing and generation.
 *
 * Takes a fraction rather than a percentage so the arithmetic lives in one
 * place: each of the three callers previously rounded its own, and a run of
 * zero items divided by zero in two of them.
 */
export default function ProgressBar({ fraction }: Props) {
  const safe = Number.isFinite(fraction) ? Math.min(Math.max(fraction, 0), 1) : 0;

  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: `${Math.round(safe * 100)}%` }} />
    </div>
  );
}
