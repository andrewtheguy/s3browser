import { IconBase, type IconProps, accentFill, accentStroke } from './IconBase';

/** The default AWS endpoint: a cloud holding a small bucket. */
export function CloudBucketIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M6.5 19a4.5 4.5 0 0 1-.6-8.96 6.5 6.5 0 0 1 12.4-1.44A5.25 5.25 0 0 1 17.5 19z"
        fill="currentColor"
        fillOpacity={0.12}
      />
      <path d="M9 12.6l.75 3.9q.12.6.72.6h3.06q.6 0 .72-.6l.75-3.9" strokeWidth={1.5} />
      <ellipse
        cx="12"
        cy="12.6"
        rx="3"
        ry="1"
        strokeWidth={1.5}
        {...accentStroke}
        {...accentFill}
        fillOpacity={0.3}
      />
    </IconBase>
  );
}
