import React from 'react';

interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ role, content }) => {
  return (
    <div className={`message message--${role}`}>
      <div className="message__avatar">
        {role === 'user' ? '👤' : '📜'}
      </div>
      <div className="message__body">
        <div className="message__content">{content}</div>
      </div>
    </div>
  );
};
