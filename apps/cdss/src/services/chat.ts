import { apiFetch } from './api';
import type { Thread, Message, PatientContext } from '../types';

export async function listThreads(username: string): Promise<Thread[]> {
  return apiFetch<Thread[]>(`/cdss/threads?username=${encodeURIComponent(username)}`);
}

export async function createThread(username: string, patientId?: string, patientName?: string): Promise<Thread> {
  return apiFetch<Thread>('/cdss/threads', {
    method: 'POST',
    body: JSON.stringify({ username, patientId, patientName }),
  });
}

export async function renameThread(id: number, title: string): Promise<void> {
  await apiFetch(`/cdss/threads/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ title }),
  });
}

export async function deleteThread(id: number): Promise<void> {
  await apiFetch(`/cdss/threads/${id}`, { method: 'DELETE' });
}

export async function getMessages(threadId: number): Promise<Message[]> {
  return apiFetch<Message[]>(`/cdss/threads/${threadId}/messages`);
}

export async function streamChat(
  threadId: number,
  message: string,
  patient: PatientContext | null,
  history: Message[],
  onChunk: (text: string) => void,
  onSources: (sources: any[]) => void,
  onStep: (step: string) => void,
  onThinking: (thinking: string) => void,
  onDone: (fullResponse: string) => void,
  onError: (err: Error) => void,
): Promise<AbortController> {
  const controller = new AbortController();

  try {
    const res = await fetch(`/api/cdss/threads/${threadId}/messages/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        patient,
        history: history.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(err);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter((l) => l.startsWith('data: '));

      for (const line of lines) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          onDone(accumulated);
          return controller;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.text) {
            accumulated += parsed.text;
            onChunk(parsed.text);
          }
          if (parsed.sources) {
            onSources(parsed.sources);
          }
          if (parsed.step) {
            onStep(parsed.step);
          }
          if (parsed.thinking) {
            onThinking(parsed.thinking);
          }
        } catch {
          // skip malformed chunks
        }
      }
    }

    onDone(accumulated);
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      onError(err);
    }
  }

  return controller;
}
