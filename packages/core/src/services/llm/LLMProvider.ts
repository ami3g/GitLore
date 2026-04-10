import type { LLMMessage } from '../../types';

export type StreamCallback = (chunk: string) => void;

export interface LLMProvider {
  sendMessage(
    messages: LLMMessage[],
    onChunk?: StreamCallback
  ): Promise<string>;

  testConnection(): Promise<boolean>;
}
