/**
 * Small stroke icons for buttons, drawn inline so they take the button's text
 * colour in both themes. Decorative: every button that shows one also carries
 * its label, as text or as an aria-label, so each icon is hidden from screen
 * readers.
 */

import type { ReactNode } from "react";

interface Props {
  size?: number;
}

function Svg({ size = 15, children, fill = false }: Props & { children: ReactNode; fill?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function PlayIcon({ size = 13 }: Props) {
  return (
    <Svg size={size} fill>
      <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" />
    </Svg>
  );
}

export function LayersIcon({ size }: Props) {
  return (
    <Svg size={size}>
      <path d="m12 3 9 4.5-9 4.5-9-4.5z" />
      <path d="m3 12 9 4.5 9-4.5" />
      <path d="m3 16.5 9 4.5 9-4.5" />
    </Svg>
  );
}

export function ClipboardCheckIcon({ size }: Props) {
  return (
    <Svg size={size}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="m9 14 2 2 4-4" />
    </Svg>
  );
}

export function ChartIcon({ size }: Props) {
  return (
    <Svg size={size}>
      <path d="M3 3v18h18" />
      <path d="M8 17v-6" />
      <path d="M13 17V7" />
      <path d="M18 17v-9" />
    </Svg>
  );
}

export function PlusIcon({ size = 14 }: Props) {
  return (
    <Svg size={size}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function DownloadIcon({ size = 14 }: Props) {
  return (
    <Svg size={size}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </Svg>
  );
}

export function CopyIcon({ size = 14 }: Props) {
  return (
    <Svg size={size}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Svg>
  );
}

export function CheckIcon({ size = 14 }: Props) {
  return (
    <Svg size={size}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}
