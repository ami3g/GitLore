import type { LLMMessage } from '../../types';
import type { LLMProvider, StreamCallback } from './LLMProvider';

export class OllamaProvider implements LLMProvider {
  private endpoint: string;
  private model: string;

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.model = model;
  }

  async sendMessage(
    messages: LLMMessage[],
    onChunk?: StreamCallback
  ): Promise<string> {
    const url = `${this.endpoint}/api/chat`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: !!onChunk,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama error (${response.status}): ${text}`);
    }

    if (onChunk && response.body) {
      return this.readStream(response.body, onChunk);
    }

    const data = (await response.json()) as { message?: { content?: string } };
    return data.message?.content ?? '';
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    onChunk: StreamCallback
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        // Ollama streams NDJSON — one JSON object per line
        const lines = text.split('\n').filter(Boolean);

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as {
              message?: { content?: string };
              done?: boolean;
            };
            const content = parsed.message?.content ?? '';
            if (content) {
              fullResponse += content;
              onChunk(content);
            }
          } catch {
            // Incomplete JSON chunk — will be completed in next read
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return fullResponse;
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  updateConfig(endpoint: string, model: string): void {
    this.endpoint = endpoint.replace(/\/$/, '');
    this.model = model;
  }
}
