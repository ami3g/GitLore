import OpenAI from 'openai';
import type { LLMMessage } from '../../types';
import type { LLMProvider, StreamCallback } from './LLMProvider';

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI | null = null;
  private model: string;
  private getApiKey: () => Promise<string | undefined>;

  constructor(model: string, getApiKey: () => Promise<string | undefined>) {
    this.model = model;
    this.getApiKey = getApiKey;
  }

  private async getClient(): Promise<OpenAI> {
    if (this.client) return this.client;

    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'OpenAI API key not set. Run "Git-Lore: Set OpenAI API Key" command.'
      );
    }

    this.client = new OpenAI({ apiKey });
    return this.client;
  }

  async sendMessage(
    messages: LLMMessage[],
    onChunk?: StreamCallback
  ): Promise<string> {
    const client = await this.getClient();

    if (onChunk) {
      const stream = await client.chat.completions.create({
        model: this.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      });

      let fullResponse = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (delta) {
          fullResponse += delta;
          onChunk(delta);
        }
      }
      return fullResponse;
    }

    const response = await client.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    return response.choices[0]?.message?.content ?? '';
  }

  async testConnection(): Promise<boolean> {
    try {
      const client = await this.getClient();
      await client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  updateModel(model: string): void {
    this.model = model;
  }

  resetClient(): void {
    this.client = null;
  }
}
