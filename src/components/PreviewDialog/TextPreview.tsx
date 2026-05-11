import { useMemo } from 'react';
import { highlightCode } from '@/lib/highlight';

interface TextPreviewProps {
  content: string;
  language: string | undefined;
}

export function TextPreview({ content, language }: TextPreviewProps) {
  const highlighted = useMemo(() => {
    if (!language) return null;
    return highlightCode(content, language);
  }, [content, language]);

  const codeStyle = { overflow: 'visible', padding: 0, background: 'transparent' };

  return (
    <pre className="m-0 h-full overflow-auto bg-muted/30 p-4 font-mono text-sm leading-relaxed">
      {highlighted !== null ? (
        <code
          className={`hljs language-${language}`}
          style={codeStyle}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : (
        <code className="hljs" style={codeStyle}>{content}</code>
      )}
    </pre>
  );
}
