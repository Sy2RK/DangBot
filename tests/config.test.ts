import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('Hermes-only config', () => {
  it('has no legacy backend switch or text/search client configuration', async () => {
    const config = await loadConfig('/dev/null');
    expect(config.agent).not.toHaveProperty('backend');
    expect(config).not.toHaveProperty('search');
    expect(config).not.toHaveProperty('llm');
    expect(config.agent.hermes.model).toBe('deepseek-v4-flash');
    expect(config.agent.hermes.maxConcurrentRuns).toBe(2);
  });

  it('pins media models and scoped memory bridge', async () => {
    const config = await loadConfig('/dev/null');
    expect(config.media).toMatchObject({
      multimodalModel: 'qwen3.7-flash',
      imageModel: 'qwen-image-3.0-pro'
    });
    expect(config.media.tts.model).toBe('qwen-audio-3.0-tts-flash');
    expect(config.media.videoModels).toEqual({
      textToVideo: 'happyhorse-1.1-t2v',
      imageToVideo: 'happyhorse-1.1-i2v',
      referenceToVideo: 'happyhorse-1.1-r2v',
      videoEdit: 'happyhorse-1.0-video-edit'
    });
    expect(config.agent.memoryBridge.baseURL).toBe('http://127.0.0.1:18643');
  });
});
