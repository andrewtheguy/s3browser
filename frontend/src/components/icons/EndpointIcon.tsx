import { IconBase, type IconProps, accentFill, accentStroke, bodyFill } from './IconBase';

/** An S3-compatible endpoint: two storage units joined by an accent link. */
export function EndpointIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="3.5" width="13" height="7" rx="2" {...bodyFill} />
      <rect x="3" y="13.5" width="13" height="7" rx="2" {...bodyFill} />
      <path d="M10 7h3M10 17h3" strokeOpacity={0.6} />
      <circle cx="6.5" cy="7" r="0.6" fill="currentColor" />
      <circle cx="6.5" cy="17" r="0.6" fill="currentColor" />
      <path d="M16 7h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2" {...accentStroke} />
      <circle cx="20" cy="12" r="1.6" stroke="none" {...accentFill} />
    </IconBase>
  );
}
