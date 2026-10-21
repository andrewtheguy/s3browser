import type { SVGProps } from 'react';
import { cn } from '@/lib/utils';

export type IconProps = SVGProps<SVGSVGElement>;

/**
 * Second tone of the duotone icons. Brand orange by default; set `--icon-accent`
 * on the icon or an ancestor (e.g. `[--icon-accent:currentColor]`) to change it.
 */
const ACCENT = 'var(--icon-accent, var(--color-primary))';
export const accentStroke = { stroke: ACCENT };
export const accentFill = { fill: ACCENT };

/** Translucent body fill shared by every icon. */
export const bodyFill = { fill: 'currentColor', fillOpacity: 0.16 };

/** 24px grid, 1.75 stroke, round joins: the frame for the app's own icons. */
export function IconBase({ className, children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn('h-5 w-5 shrink-0', className)}
      {...props}
    >
      {children}
    </svg>
  );
}
