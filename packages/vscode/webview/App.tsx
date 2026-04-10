import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ChatMessage } from './components/ChatMessage';
import { ChatInput } from './components/ChatInput';
import { StatusBar } from './components/StatusBar';
import { getVSCodeAPI, useVSCodeListener } from './hooks/useVSCodeAPI';
import type { ExtensionToWebviewMessage, IndexStatus } from '@gitlore/core';
import './styles.css';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState('');
  const [status, setStatus] = useState<IndexStatus>({
    indexed: false,
    commitCount: 0,
    lastIndexedAt: null,
    lastIndexedHash: null,
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamingRef = useRef<Map<string, string>>(new Map());

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(scrollToBottom, [messages, scrollToBottom]);

  // Request status on mount
  useEffect(() => {
    getVSCodeAPI().postMessage({ command: 'getStatus' });
  }, []);

  const handleExtensionMessage = useCallback((message: ExtensionToWebviewMessage) => {
    switch (message.command) {
      case 'streamChunk': {
        const { id, content } = message.payload;
        const current = streamingRef.current.get(id) ?? '';
        const updated = current + content;
        streamingRef.current.set(id, updated);
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === id);
          if (existing) {
            return prev.map((m) => (m.id === id ? { ...m, content: updated } : m));
          }
          return [...prev, { id, role: 'assistant', content: updated }];
        });
        break;
      }
      case 'streamEnd': {
        streamingRef.current.delete(message.payload.id);
        setIsLoading(false);
        break;
      }
      case 'status':
      case 'indexComplete': {
        setStatus(message.payload);
        setIsIndexing(false);
        setIndexProgress('');
        break;
      }
      case 'indexProgress': {
        const { phase, current, total } = message.payload;
        setIndexProgress(`${phase}: ${current}/${total}`);
        break;
      }
      case 'error': {
        setIsLoading(false);
        setIsIndexing(false);
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: 'assistant',
            content: `**Error:** ${message.payload.message}`,
          },
        ]);
        break;
      }
    }
  }, []);

  useVSCodeListener(handleExtensionMessage);

  const handleSend = useCallback(
    (text: string) => {
      if (!text.trim() || isLoading) return;

      const userMsg: Message = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text,
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);
      getVSCodeAPI().postMessage({ command: 'query', payload: { text } });
    },
    [isLoading]
  );

  const handleIndex = useCallback(() => {
    setIsIndexing(true);
    setIndexProgress('Starting...');
    getVSCodeAPI().postMessage({ command: 'index' });
  }, []);

  const handleSummarize = useCallback(() => {
    setIsLoading(true);
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: "What's changed recently?",
    };
    setMessages((prev) => [...prev, userMsg]);
    getVSCodeAPI().postMessage({ command: 'summarize' });
  }, []);

  return (
    <div className="app">
      <StatusBar
        status={status}
        isIndexing={isIndexing}
        indexProgress={indexProgress}
        onIndex={handleIndex}
        onSummarize={handleSummarize}
      />
      <div className="messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <p className="empty-title">Git-Lore</p>
            <p className="empty-subtitle">
              {status.indexed
                ? 'Ask a question about your repository history.'
                : 'Index your repository to get started.'}
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <ChatMessage key={msg.id} role={msg.role} content={msg.content} />
        ))}
        {isLoading && messages[messages.length - 1]?.role === 'user' && (
          <div className="typing-indicator">
            <span /><span /><span />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <ChatInput onSend={handleSend} disabled={isLoading} />
    </div>
  );
};
