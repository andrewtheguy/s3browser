import { IconBase, type IconProps, accentStroke, bodyFill } from './IconBase';

/** An open folder with nothing in it, for empty listings. */
export function EmptyFolderIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 17.5v-11a2 2 0 0 1 2-2h4.2l2 2H17a2 2 0 0 1 2 2v1.5" />
      <path
        d="M3 17.5l2.4-6.2a1.5 1.5 0 0 1 1.4-1h13.6a1 1 0 0 1 .95 1.3l-2 6.6a1.7 1.7 0 0 1-1.6 1.3H5a2 2 0 0 1-2-2z"
        {...bodyFill}
      />
      <path d="M9 15h7" strokeDasharray="1.5 2.5" {...accentStroke} />
    </IconBase>
  );
}
