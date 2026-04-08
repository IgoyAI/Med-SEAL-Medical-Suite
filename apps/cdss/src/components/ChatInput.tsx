import { useState, useRef, useEffect } from 'react';
import { ArrowUp, StopFilled, Add } from '@carbon/icons-react';

interface Props {
  onSend: (message: string) => void;
  onStop?: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export default function ChatInput({ onSend, onStop, isStreaming, disabled }: Props) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
    }
  }, [value]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || isStreaming || disabled) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const hasContent = value.trim().length > 0;

  return (
    <div className="chat-input">
      <div className="chat-input__container">
        <div className="chat-input__field">
          {/* Attach button — left side like ChatGPT */}
          <button
            className="chat-input__attach"
            onClick={() => fileRef.current?.click()}
            title="Attach file"
            disabled={isStreaming}
          >
            <Add size={20} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.csv,.txt"
            className="chat-input__file-hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                // For now just insert filename — full upload can be added later
                setValue((prev) => prev + `[Attached: ${file.name}] `);
              }
              e.target.value = '';
            }}
          />

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a clinical question..."
            rows={1}
            disabled={disabled}
            className="chat-input__textarea"
          />

          <div className="chat-input__btn-wrap">
            {isStreaming ? (
              <button
                className="chat-input__send chat-input__send--stop"
                onClick={onStop}
                title="Stop generating"
              >
                <StopFilled size={16} />
              </button>
            ) : (
              <button
                className={`chat-input__send ${hasContent ? 'chat-input__send--active' : ''}`}
                onClick={handleSubmit}
                disabled={!hasContent || disabled}
                title="Send message"
              >
                <ArrowUp size={18} />
              </button>
            )}
          </div>
        </div>
        <div className="chat-input__hint">
          Med-SEAL CDSS can make mistakes. Always verify clinical recommendations.
        </div>
      </div>
    </div>
  );
}
