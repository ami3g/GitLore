import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ChatMessage } from '../components/ChatMessage';
import { ChatInput } from '../components/ChatInput';
import { TopKSelector } from '../components/TopKSelector';
import { useGitLore, useIPCEvent } from '../hooks/useElectronAPI';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface AskPageProps {
  repoPath: string;
}

export const AskPage: React.FC<AskPageProps> = ({ repoPath }) => {
  const api = useGitLore();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [topK, setTopK] = useState(5);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamingRef = useRef<Map<string, string>>(new Map());

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(scrollToBottom, [messages, scrollToBottom]);

  // Stream chunk handler
  useIPCEvent('gitlore:stream-chunk', useCallback(({ id, content }) => {
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
  }, []));

  // Stream end
  useIPCEvent('gitlore:stream-end', useCallback(({ id }) => {
    streamingRef.current.delete(id);
    setIsLoading(false);
  }, []));

  // Error handler
  useIPCEvent('gitlore:error', useCallback(({ message }) => {
    setIsLoading(false);
    setMessages((prev) => [
      ...prev,
      { id: `err-${Date.now()}`, role: 'assistant', content: `**Error:** ${message}` },
    ]);
  }, []));

  const handleSend = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;
    const userMsg: Message = { id: `user-${Date.now()}`, role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);
    try {
      await api.query(repoPath, text, topK);
    } catch (err: unknown) {
      setIsLoading(false);
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: 'assistant', content: `**Error:** ${errMsg}` },
      ]);
    }
  }, [isLoading, api, repoPath, topK]);

  return (
    <div className="ask-page">
      <div className="ask-page__chat">
        <div className="ask-page__toolbar">
          <TopKSelector value={topK} onChange={setTopK} />
        </div>
        <div className="ask-page__messages">
          {messages.length === 0 && (
            <div className="empty-state empty-state--inline">
              <p className="empty-state__title">Ask anything about your repo</p>
              <p className="empty-state__subtitle">
                "Why was the auth middleware rewritten?" · "Who owns the payment module?"
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
    </div>
  );
};
