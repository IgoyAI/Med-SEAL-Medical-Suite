import { useState } from 'react';
import { Button, Tag } from '@carbon/react';
import {
  Copy,
  Checkmark,
  Renew,
  ThumbsUp,
  ThumbsDown,
  Edit,
  ChevronDown,
  ChevronUp,
  UserAvatar,
  MachineLearningModel,
  Launch,
} from '@carbon/icons-react';
import MarkdownRenderer from './MarkdownRenderer';
import type { Message } from '../types';

interface Props {
  message: Message;
  isStreaming?: boolean;
  onRetry?: () => void;
  onEdit?: (newContent: string) => void;
}

export default function MessageBubble({ message, isStreaming, onRetry, onEdit }: Props) {
  const [showThinking, setShowThinking] = useState(false);
  const [showSources, setShowSources] = useState(true);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const isUser = message.role === 'user';
  const hasSources = message.sources && message.sources.length > 0;

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleEdit = () => {
    if (editing && editValue.trim() && editValue !== message.content && onEdit) {
      onEdit(editValue.trim());
      setEditing(false);
    } else {
      setEditing(!editing);
      setEditValue(message.content);
    }
  };

  return (
    <div className={`message-bubble ${isUser ? 'message-bubble--user' : 'message-bubble--assistant'}`}>
      <div className="message-bubble__avatar">
        {isUser ? <UserAvatar size={18} /> : <MachineLearningModel size={18} />}
      </div>

      <div className="message-bubble__body">
        <div className="message-bubble__header">
          <span className="message-bubble__role">{isUser ? 'You' : 'CDSS'}</span>
          {message.created_at && (
            <span className="message-bubble__time">
              {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>

        {message.thinking && (
          <div className="message-bubble__thinking">
            <button
              className="thinking-toggle"
              onClick={() => setShowThinking(!showThinking)}
            >
              {showThinking ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              <span>Reasoning</span>
            </button>
            {showThinking && (
              <div className="thinking-content">
                <MarkdownRenderer content={message.thinking} />
              </div>
            )}
          </div>
        )}

        <div className="message-bubble__content">
          {isUser ? (
            editing ? (
              <textarea
                className="message-bubble__edit-area"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEdit(); }
                  if (e.key === 'Escape') setEditing(false);
                }}
                autoFocus
              />
            ) : (
              <p>{message.content}</p>
            )
          ) : (
            <MarkdownRenderer
              content={message.content}
              sources={message.sources}
            />
          )}
        </div>

        {/* Inline source cards below message — OpenEvidence/Perplexity style */}
        {!isUser && hasSources && (
          <div className="message-sources">
            <button
              className="message-sources__toggle"
              onClick={() => setShowSources(!showSources)}
            >
              {showSources ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              <span>{message.sources!.length} References</span>
            </button>
            {showSources && (
              <div className="message-sources__list">
                {message.sources!.map((s, i) => {
                  const authors = Array.isArray(s.authors)
                    ? s.authors.slice(0, 3).join(', ')
                    : (s.authors || '');
                  const relevance = (s as any).relevance ?? (s as any).relevance_score;
                  return (
                    <div key={i} className="message-source-card">
                      <Tag size="sm" type="blue" className="message-source-card__num">{i + 1}</Tag>
                      <div className="message-source-card__body">
                        <div className="message-source-card__title-row">
                          <span className="message-source-card__title">{s.title || 'Untitled'}</span>
                        </div>
                        <div className="message-source-card__badges">
                          {(s as any).type && (
                            <Tag size="sm" type={
                              (s as any).type === 'guideline' ? 'green' :
                              (s as any).type === 'review' ? 'purple' : 'cool-gray'
                            }>
                              {(s as any).type === 'guideline' ? 'Guideline' :
                               (s as any).type === 'review' ? 'Review' : 'Research'}
                            </Tag>
                          )}
                          {s.source_label && (
                            <Tag size="sm" type="outline">{s.source_label}</Tag>
                          )}
                        </div>
                        <div className="message-source-card__meta">
                          {authors}
                          {s.journal && <em> &middot; {s.journal}</em>}
                          {s.year && <span> ({s.year})</span>}
                        </div>
                        {s.abstract && (
                          <div className="message-source-card__abstract">{s.abstract}</div>
                        )}
                      </div>
                      <div className="message-source-card__actions">
                        {relevance !== undefined && (
                          <span className="message-source-card__score">{Math.round(relevance * 100)}%</span>
                        )}
                        {s.doi && (
                          <a
                            href={`https://doi.org/${s.doi}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="message-source-card__link"
                            title="Open paper"
                          >
                            <Launch size={14} />
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {!isStreaming && (
          <div className="message-bubble__actions">
            {isUser && onEdit && (
              <Button kind="ghost" size="sm" renderIcon={Edit} iconDescription={editing ? 'Submit edit' : 'Edit message'} hasIconOnly onClick={handleEdit} />
            )}
            {!isUser && (
              <>
                <Button kind="ghost" size="sm" renderIcon={copied ? Checkmark : Copy} iconDescription={copied ? 'Copied' : 'Copy'} hasIconOnly onClick={handleCopy} className={copied ? 'action-btn--active' : ''} />
                <Button kind="ghost" size="sm" renderIcon={ThumbsUp} iconDescription="Good response" hasIconOnly onClick={() => setFeedback(feedback === 'up' ? null : 'up')} className={feedback === 'up' ? 'action-btn--active' : ''} />
                <Button kind="ghost" size="sm" renderIcon={ThumbsDown} iconDescription="Bad response" hasIconOnly onClick={() => setFeedback(feedback === 'down' ? null : 'down')} className={feedback === 'down' ? 'action-btn--active' : ''} />
                {onRetry && <Button kind="ghost" size="sm" renderIcon={Renew} iconDescription="Retry" hasIconOnly onClick={onRetry} />}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
