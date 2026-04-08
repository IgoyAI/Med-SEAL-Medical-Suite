import { useState, useCallback, useRef } from 'react';
import type { Thread, Message, PatientContext, Source } from '../types';
import * as chatApi from '../services/chat';

export function useChat(username: string) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingStep, setStreamingStep] = useState('');
  const [currentSources, setCurrentSources] = useState<Source[]>([]);
  const [currentThinking, setCurrentThinking] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const sourcesRef = useRef<Source[]>([]);
  const thinkingRef = useRef('');
  const fullContentRef = useRef('');

  const loadThreads = useCallback(async () => {
    const list = await chatApi.listThreads(username);
    setThreads(list);
  }, [username]);

  const selectThread = useCallback(async (threadId: number) => {
    setActiveThreadId(threadId);
    setMessages([]);
    setStreamingContent('');
    setStreamingStep('');
    setCurrentSources([]);
    try {
      const msgs = await chatApi.getMessages(threadId);
      setMessages(msgs);
    } catch (err) {
      console.error('Failed to load messages:', err);
    }
  }, []);

  const createThread = useCallback(async (patientId?: string, patientName?: string) => {
    try {
      const thread = await chatApi.createThread(username, patientId, patientName);
      setThreads((prev) => [thread, ...prev]);
      setActiveThreadId(thread.id);
      setMessages([]);
      setStreamingContent('');
      setStreamingStep('');
      setCurrentSources([]);
      return thread;
    } catch (err) {
      console.error('Failed to create thread:', err);
      return null;
    }
  }, [username]);

  const renameThread = useCallback(async (threadId: number, title: string) => {
    try {
      await chatApi.renameThread(threadId, title);
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, title } : t)));
    } catch (err) {
      console.error('Failed to rename thread:', err);
    }
  }, []);

  const deleteThread = useCallback(async (threadId: number) => {
    try {
      await chatApi.deleteThread(threadId);
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      if (activeThreadId === threadId) {
        setActiveThreadId(null);
        setMessages([]);
      }
    } catch (err) {
      console.error('Failed to delete thread:', err);
    }
  }, [activeThreadId]);

  const sendMessage = useCallback(async (content: string, patient: PatientContext | null) => {
    if (!activeThreadId || isStreaming) return;

    const userMsg: Message = { role: 'user', content, created_at: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);
    setStreamingContent('');
    setStreamingStep('');
    setCurrentSources([]);
    setCurrentThinking('');
    sourcesRef.current = [];
    thinkingRef.current = '';
    fullContentRef.current = '';

    abortRef.current = await chatApi.streamChat(
      activeThreadId,
      content,
      patient,
      messages,
      (chunk) => {
        fullContentRef.current += chunk;
        setStreamingContent((prev) => prev + chunk);
        setStreamingStep('');
      },
      (sources) => {
        sourcesRef.current = sources;
        setCurrentSources(sources);
      },
      (step) => {
        setStreamingStep(step);
      },
      (thinking) => {
        thinkingRef.current = thinking;
        setCurrentThinking(thinking);
      },
      (_fullResponse) => {
        const finalContent = fullContentRef.current;
        const assistantMsg: Message = {
          role: 'assistant',
          content: finalContent,
          thinking: thinkingRef.current || undefined,
          sources: sourcesRef.current.length > 0 ? sourcesRef.current : undefined,
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, assistantMsg]);
        setStreamingContent('');
        setStreamingStep('');
        setIsStreaming(false);

        if (messages.length === 0 && finalContent) {
          const title = content.length > 60 ? content.slice(0, 57) + '...' : content;
          chatApi.renameThread(activeThreadId, title).catch(() => {});
          setThreads((prev) =>
            prev.map((t) => (t.id === activeThreadId ? { ...t, title } : t)),
          );
        }
      },
      (err) => {
        console.error('Stream error:', err);
        setIsStreaming(false);
        setStreamingContent('');
        setStreamingStep('');
        const errorMsg: Message = {
          role: 'assistant',
          content: `Error: ${err.message}. Please try again.`,
          created_at: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      },
    );
  }, [activeThreadId, isStreaming, messages]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    if (streamingContent) {
      const assistantMsg: Message = {
        role: 'assistant',
        content: streamingContent,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    }
    setStreamingContent('');
    setStreamingStep('');
    setIsStreaming(false);
  }, [streamingContent]);

  return {
    threads,
    activeThreadId,
    messages,
    isStreaming,
    streamingContent,
    streamingStep,
    currentSources,
    loadThreads,
    selectThread,
    createThread,
    renameThread,
    deleteThread,
    sendMessage,
    stopStreaming,
  };
}
