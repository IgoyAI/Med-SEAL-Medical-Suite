import { useState, useEffect, useCallback } from 'react';
import { Button, Tag } from '@carbon/react';
import { UserMultiple, MachineLearningModel } from '@carbon/icons-react';
import ThreadSidebar from '../components/ThreadSidebar';
import ChatArea from '../components/ChatArea';
import PatientSelector from '../components/PatientSelector';
import PatientPanel from '../components/PatientPanel';
import { useChat } from '../hooks/useChat';
import { getPatientContext } from '../services/fhir';
import type { PatientContext } from '../types';

interface Props {
  username: string;
  sidebarOpen: boolean;
}

export default function ChatPage({ username, sidebarOpen }: Props) {
  const chat = useChat(username);
  const [patient, setPatient] = useState<PatientContext | null>(null);
  const [patientSelectorOpen, setPatientSelectorOpen] = useState(false);
  const [patientPanelOpen, setPatientPanelOpen] = useState(false);
  const [threadsLoading, setThreadsLoading] = useState(true);

  useEffect(() => {
    setThreadsLoading(true);
    chat.loadThreads().finally(() => setThreadsLoading(false));
  }, [chat.loadThreads]);

  const handleSelectPatient = useCallback(async (patientId: string, patientName: string) => {
    let ctx: PatientContext;
    try {
      ctx = await getPatientContext(patientId);
    } catch {
      ctx = {
        id: patientId,
        firstName: patientName.split(' ')[0] || '',
        lastName: patientName.split(' ').slice(1).join(' ') || '',
        dateOfBirth: '', gender: '',
        allergies: [], conditions: [], medications: [],
        observations: [], encounters: [], immunizations: [], imagingStudies: [],
      };
    }
    setPatient(ctx);
    setPatientPanelOpen(true);
    setPatientSelectorOpen(false);

    const existingThread = chat.threads.find((t) => t.patient_id === patientId);
    if (existingThread) {
      chat.selectThread(existingThread.id);
    } else {
      await chat.createThread(ctx.id, `${ctx.firstName} ${ctx.lastName}`);
    }
  }, [chat]);

  const handleNewChat = useCallback(() => {
    setPatientSelectorOpen(true);
  }, []);

  const handleSend = useCallback((content: string) => {
    chat.sendMessage(content, patient);
  }, [chat, patient]);

  const handleRetry = useCallback(() => {
    const lastUserMsg = [...chat.messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) chat.sendMessage(lastUserMsg.content, patient);
  }, [chat, patient]);

  if (!patient) {
    return (
      <div className="chat-page">
        <div className="chat-page__main">
          <div className="chat-page__no-thread">
            <div className="chat-page__no-thread-inner">
              <div className="chat-page__logo">
                <MachineLearningModel size={48} />
              </div>
              <h2>Med-SEAL CDSS</h2>
              <p>Select a patient to begin clinical decision support</p>
              <Button kind="primary" size="lg" renderIcon={UserMultiple} onClick={() => setPatientSelectorOpen(true)}>
                Select Patient
              </Button>
            </div>
          </div>
        </div>
        <PatientSelector open={patientSelectorOpen} onClose={() => setPatientSelectorOpen(false)} onSelect={handleSelectPatient} />
      </div>
    );
  }

  return (
    <div className="chat-page">
      <ThreadSidebar
        threads={chat.threads}
        activeThreadId={chat.activeThreadId}
        collapsed={!sidebarOpen}
        loading={threadsLoading}
        onSelect={(threadId) => {
          const thread = chat.threads.find((t) => t.id === threadId);
          if (thread?.patient_id && thread.patient_id !== patient?.id) {
            getPatientContext(thread.patient_id).then((ctx) => setPatient(ctx)).catch(() => {});
          }
          chat.selectThread(threadId);
        }}
        onCreate={handleNewChat}
        onRename={chat.renameThread}
      />

      <div className="chat-page__main">
        <div className="chat-page__topbar">
          <div className="chat-page__topbar-left">
            <div className="chat-page__model-badge">
              <MachineLearningModel size={16} />
              <span>Med-SEAL-V1</span>
            </div>
            <div className="chat-page__topbar-divider" />
            <Tag
              size="md"
              type="green"
              onClick={() => setPatientPanelOpen(!patientPanelOpen)}
              className="patient-tag"
            >
              {patient.firstName} {patient.lastName}
            </Tag>
          </div>
        </div>

        {chat.activeThreadId ? (
          <ChatArea
            messages={chat.messages}
            isStreaming={chat.isStreaming}
            streamingContent={chat.streamingContent}
            streamingStep={chat.streamingStep}
            patient={patient}
            onSend={handleSend}
            onStop={chat.stopStreaming}
            onRetry={handleRetry}
          />
        ) : (
          <div className="chat-page__no-thread">
            <div className="chat-page__no-thread-inner">
              <div className="chat-page__logo">
                <MachineLearningModel size={48} />
              </div>
              <h2>{patient.firstName} {patient.lastName}</h2>
              <p>Loading conversation...</p>
            </div>
          </div>
        )}
      </div>

      {patientPanelOpen && (
        <PatientPanel patient={patient} onClose={() => setPatientPanelOpen(false)} />
      )}

      <PatientSelector open={patientSelectorOpen} onClose={() => setPatientSelectorOpen(false)} onSelect={handleSelectPatient} />
    </div>
  );
}
