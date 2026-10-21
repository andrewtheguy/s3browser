import { IconBase, type IconProps, accentFill, accentStroke, bodyFill } from './IconBase';

/** Tapered bucket with an accent rim, matching the logo silhouette. */
export function BucketIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7l2.2 11.6Q6.45 20 7.85 20h8.3q1.4 0 1.65-1.4L20 7" {...bodyFill} />
      <path d="M5.4 13h13.2" strokeOpacity={0.5} />
      <ellipse cx="12" cy="7" rx="8" ry="2.5" {...accentStroke} {...accentFill} fillOpacity={0.3} />
    </IconBase>
  );
}
