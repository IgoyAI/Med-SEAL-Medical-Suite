import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CodeSnippet } from '@carbon/react';
import type { Components } from 'react-markdown';
import type { Source } from '../types';

interface Props {
  content: string;
  sources?: Source[];
}

const components: Components = {
  code({ className, children, ...props }) {
    const isInline = !className;
    const text = String(children).replace(/\n$/, '');

    if (isInline) {
      return <code className="md-inline-code" {...props}>{children}</code>;
    }

    return (
      <CodeSnippet type="multi" feedback="Copied!" wrapText>
        {text}
      </CodeSnippet>
    );
  },
  table({ children }) {
    return (
      <div className="md-table-wrap">
        <table className="md-table">{children}</table>
      </div>
    );
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="md-link">
        {children}
      </a>
    );
  },
};

// Replace [1], [2] etc. in rendered text nodes with clickable citation superscripts
function CitationText({ text, sources }: { text: string; sources?: Source[] }) {
  if (!sources || sources.length === 0) return <>{text}</>;

  const parts = text.split(/(\[\d{1,2}\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^\[(\d{1,2})\]$/);
        if (match) {
          const idx = parseInt(match[1]);
          const source = idx >= 1 && idx <= sources.length ? sources[idx - 1] : null;
          return (
            <sup
              key={i}
              className="citation-ref"
              title={source ? `${source.title || ''} — ${source.journal || ''}, ${source.year || ''}` : `Reference ${idx}`}
            >
              [{idx}]
            </sup>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export default function MarkdownRenderer({ content, sources }: Props) {
  // Build components with citation-aware text rendering
  const citationComponents: Components = {
    ...components,
    p({ children }) {
      // Process text children to add citation superscripts
      const processed = processChildren(children, sources);
      return <p>{processed}</p>;
    },
    li({ children }) {
      const processed = processChildren(children, sources);
      return <li>{processed}</li>;
    },
    strong({ children }) {
      const processed = processChildren(children, sources);
      return <strong>{processed}</strong>;
    },
    em({ children }) {
      const processed = processChildren(children, sources);
      return <em>{processed}</em>;
    },
  };

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={sources && sources.length > 0 ? citationComponents : components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function processChildren(children: React.ReactNode, sources?: Source[]): React.ReactNode {
  if (!sources || sources.length === 0) return children;
  if (!children) return children;

  if (typeof children === 'string') {
    if (/\[\d{1,2}\]/.test(children)) {
      return <CitationText text={children} sources={sources} />;
    }
    return children;
  }

  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === 'string' && /\[\d{1,2}\]/.test(child)) {
        return <CitationText key={i} text={child} sources={sources} />;
      }
      return child;
    });
  }

  return children;
}
