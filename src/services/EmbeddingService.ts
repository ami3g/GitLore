import type { ProgressCallback } from './GitProcessor';

type Pipeline = (texts: string | string[], options?: Record<string, unknown>) => Promise<{ tolist(): number[][] }>;

export class EmbeddingService {
  private pipeline: Pipeline | null = null;
  private modelId = 'Xenova/all-MiniLM-L6-v2';
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  private async init(): Promise<Pipeline> {
    if (this.pipeline) return this.pipeline;

    // Dynamic import — transformers.js is ESM
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = this.cacheDir;

    this.pipeline = (await pipeline('feature-extraction', this.modelId, {
      dtype: 'q8',
    })) as unknown as Pipeline;

    return this.pipeline;
  }

  async embed(text: string): Promise<number[]> {
    const pipe = await this.init();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return output.tolist()[0];
  }

  async embedBatch(
    texts: string[],
    onProgress?: ProgressCallback
  ): Promise<number[][]> {
    const pipe = await this.init();
    const results: number[][] = [];

    // Process in small batches to avoid OOM on large repos
    const batchSize = 16;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      onProgress?.('Generating embeddings', i, texts.length);

      for (const text of batch) {
        const output = await pipe(text, { pooling: 'mean', normalize: true });
        results.push(output.tolist()[0]);
      }
    }

    onProgress?.('Generating embeddings', texts.length, texts.length);
    return results;
  }

  dispose(): void {
    this.pipeline = null;
  }
}
