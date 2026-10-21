import type { ReactNode } from 'react';

interface HighlightedTextProps {
  text: string;
  query: string;
}

export function HighlightedText({ text, query }: HighlightedTextProps) {
  if (!query) return <>{text}</>;

  const needle = query.toLowerCase();
  const hay = text.toLowerCase();
  const nlen = query.length;
  const out: ReactNode[] = [];
  let i = 0;
  let segKey = 0;

  while (i < text.length) {
    const j = hay.indexOf(needle, i);
    if (j < 0) {
      out.push(text.slice(i));
      break;
    }
    if (j > i) out.push(text.slice(i, j));
    out.push(
      <mark
        key={segKey++}
        className="rounded-sm bg-primary/25 px-0.5 text-foreground dark:bg-primary/30"
      >
        {text.slice(j, j + nlen)}
      </mark>
    );
    i = j + nlen;
  }

  return <>{out}</>;
}
