import { useEffect, useRef } from 'react';
import { ClickableTile, SkeletonText, InlineLoading } from '@carbon/react';
import {
  Stethoscope,
  Medication,
  Report,
  ChartLineData,
  MachineLearningModel,
} from '@carbon/icons-react';
import MessageBubble from './MessageBubble';
import MarkdownRenderer from './MarkdownRenderer';
import ChatInput from './ChatInput';
import type { Message, PatientContext } from '../types';

interface Props {
  messages: Message[];
  isStreaming: boolean;
  streamingContent: string;
  streamingStep: string;
  patient: PatientContext | null;
  onSend: (message: string) => void;
  onStop: () => void;
  onRetry: () => void;
}

const SUGGESTED_PROMPTS = [
  { icon: Stethoscope, text: 'Summarize this patient\'s clinical history', desc: 'Get a concise overview of conditions, medications, and recent encounters' },
  { icon: Medication, text: 'Check for drug interactions', desc: 'Analyze current medications for potential interactions or contraindications' },
  { icon: Report, text: 'Generate a differential diagnosis', desc: 'Suggest possible diagnoses based on active conditions and symptoms' },
  { icon: ChartLineData, text: 'Analyze lab trends', desc: 'Review recent lab results and flag abnormal values or concerning trends' },
];

export default function ChatArea({
  messages,
  isStreaming,
  streamingContent,
  streamingStep,
  patient,
  onSend,
  onStop,
  onRetry,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const isEmpty = messages.length === 0 && !isStreaming;

  return (
    <div className="chat-area">
      <div className="chat-area__messages">
        {isEmpty ? (
          <div className="chat-area__empty">
            <div className="empty-state">
              <div className="empty-state__logo">
                <MachineLearningModel size={40} />
              </div>
              <h2>
                {patient
                  ? `Clinical Decision Support`
                  : 'Med-SEAL CDSS'}
              </h2>
              <p>
                {patient
                  ? `Ask anything about ${patient.firstName} ${patient.lastName}`
                  : 'Select a patient or ask a general clinical question'}
              </p>
              <div className="suggested-prompts">
                {SUGGESTED_PROMPTS.map((prompt, i) => (
                  <ClickableTile
                    key={i}
                    onClick={() => onSend(prompt.text)}
                    disabled={!patient}
                    className="suggested-prompt-tile"
                  >
                    <div className="suggested-prompt-tile__icon">
                      <prompt.icon size={20} />
                    </div>
                    <div className="suggested-prompt-tile__text">
                      <strong>{prompt.text}</strong>
                      <span>{prompt.desc}</span>
                    </div>
                  </ClickableTile>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <MessageBubble
                key={msg.id || i}
                message={msg}
                onRetry={
                  i === messages.length - 1 && msg.role === 'assistant' ? onRetry : undefined
                }
                onEdit={msg.role === 'user' ? (newContent: string) => onSend(newContent) : undefined}
              />
            ))}
            {isStreaming && (
              <div className="message-bubble message-bubble--assistant">
                <div className="message-bubble__avatar">
                  <MachineLearningModel size={18} />
                </div>
                <div className="message-bubble__body">
                  {streamingStep && !streamingContent && (
                    <div className="message-bubble__step">
                      <InlineLoading description={streamingStep} />
                    </div>
                  )}
                  {streamingContent ? (
                    <div className="message-bubble__content">
                      <MarkdownRenderer content={streamingContent} />
                      <span className="streaming-cursor" />
                    </div>
                  ) : !streamingStep ? (
                    <div className="message-bubble__loading">
                      <SkeletonText paragraph lineCount={3} width="90%" />
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      <ChatInput
        onSend={onSend}
        onStop={onStop}
        isStreaming={isStreaming}
      />
    </div>
  );
}
