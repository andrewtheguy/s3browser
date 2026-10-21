import { IconBase, type IconProps, accentStroke, bodyFill } from './IconBase';

/** A prefix ("folder") with an accent pocket line. */
export function FolderIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path
        d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        {...bodyFill}
      />
      <path d="M3 10.5h18" {...accentStroke} />
    </IconBase>
  );
}
