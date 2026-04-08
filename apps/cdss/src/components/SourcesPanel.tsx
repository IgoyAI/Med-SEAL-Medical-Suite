import { Tag, Button } from '@carbon/react';
import { Close, DocumentBlank, Launch } from '@carbon/icons-react';
import type { Source } from '../types';

interface Props {
  sources: Source[];
  highlightIndex?: number;
  onClose: () => void;
}

export default function SourcesPanel({ sources, highlightIndex, onClose }: Props) {
  if (sources.length === 0) return null;

  return (
    <div className="sources-panel">
      <div className="sources-panel__header">
        <h3>
          <DocumentBlank size={16} /> References ({sources.length})
        </h3>
        <Button
          kind="ghost"
          size="sm"
          renderIcon={Close}
          iconDescription="Close"
          hasIconOnly
          onClick={onClose}
        />
      </div>

      <div className="sources-panel__list">
        {sources.map((source, i) => (
          <div
            key={i}
            className={`source-card ${highlightIndex === i ? 'source-card--highlight' : ''}`}
            id={`source-${i}`}
          >
            <div className="source-card__number">
              <Tag size="sm" type="blue">{i + 1}</Tag>
            </div>
            <div className="source-card__body">
              <div className="source-card__title">{source.title || 'Untitled'}</div>
              <div className="source-card__authors">
                {Array.isArray(source.authors) ? source.authors.join(', ') : source.authors}
              </div>
              <div className="source-card__journal">
                <em>{source.journal}</em>
                {source.year && <span> ({source.year})</span>}
              </div>
              {source.abstract && (
                <div className="source-card__abstract">{source.abstract}</div>
              )}
              <div className="source-card__footer">
                {source.doi && (
                  <a
                    href={`https://doi.org/${source.doi}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="source-card__doi"
                  >
                    <Launch size={12} /> DOI: {source.doi}
                  </a>
                )}
                {(source.relevance !== undefined || (source as any).relevance_score !== undefined) && (
                  <div className="source-card__relevance">
                    <div className="relevance-bar">
                      <div
                        className="relevance-bar__fill"
                        style={{ width: `${Math.round((source.relevance ?? (source as any).relevance_score ?? 0) * 100)}%` }}
                      />
                    </div>
                    <span>{Math.round((source.relevance ?? (source as any).relevance_score ?? 0) * 100)}% relevant</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
