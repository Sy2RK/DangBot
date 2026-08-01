import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { DashScopeMediaClient } from '../../src/services/llm/dashScopeClient.js';

const config = await loadConfig();
if (!config.media.apiKey.trim()) {
  throw new Error('DashScope media API key is not configured.');
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'dangbot-dashscope-preflight-'));
try {
  const client = new DashScopeMediaClient(config.media, temporaryRoot);

  const imagePath = path.join(temporaryRoot, 'red-square.bmp');
  await writeFile(imagePath, solidBmp(64, 64, { red: 255, green: 0, blue: 0 }));
  const vision = await client.analyzeImage(
    '只回复图片主体颜色的英文小写单词。',
    { filePath: imagePath, mimeType: 'image/bmp' },
    AbortSignal.timeout(90_000)
  );
  if (!/\bred\b/iu.test(vision)) {
    throw new Error('qwen3.7-flash multimodal preflight did not recognize the red image.');
  }

  const voice = await client.generateVoice('小当语音预检。', AbortSignal.timeout(90_000));
  if (!voice.filePath.endsWith('.wav')) {
    throw new Error('Qwen Audio TTS preflight did not create a WAV artifact.');
  }

  const runImage = process.argv.includes('--paid-media') || process.argv.includes('--image');
  const runVideo = process.argv.includes('--paid-media') || process.argv.includes('--video');
  let generatedVideoUnderstanding = false;
  if (runImage) {
    await client.generateImage('极简白色背景上的一个红色圆点', {}, AbortSignal.timeout(180_000));
  }
  if (runVideo) {
    const videoPath = await client.generateVideo(
      '极简白色背景上的一个红色圆点缓慢向右移动，3秒',
      { timeoutMs: 10 * 60 * 1_000, pollIntervalMs: 15_000 },
      AbortSignal.timeout(11 * 60 * 1_000)
    );
    await client.analyzeVideo(
      '用一句中文概括这个视频的主要画面。',
      { filePath: videoPath, mimeType: 'video/mp4' },
      AbortSignal.timeout(180_000)
    );
    generatedVideoUnderstanding = true;
  }

  process.stdout.write(
    [
      'DashScope preflight passed.',
      `Multimodal: ${config.media.multimodalModel}`,
      `TTS: ${config.media.tts.model}`,
      `Paid image: ${runImage ? 'passed' : 'not requested'}`,
      `Paid video: ${runVideo ? 'passed' : 'not requested'}`,
      `Generated video understanding: ${generatedVideoUnderstanding ? 'passed' : 'not requested'}`,
      'Credential values: not printed',
      ''
    ].join('\n')
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function solidBmp(
  width: number,
  height: number,
  color: { red: number; green: number; blue: number }
): Buffer {
  const bytesPerPixel = 3;
  const rowSize = Math.ceil((width * bytesPerPixel) / 4) * 4;
  const pixelBytes = rowSize * height;
  const buffer = Buffer.alloc(54 + pixelBytes);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelBytes, 34);
  for (let row = 0; row < height; row += 1) {
    const offset = 54 + row * rowSize;
    for (let column = 0; column < width; column += 1) {
      const pixelOffset = offset + column * bytesPerPixel;
      buffer[pixelOffset] = color.blue;
      buffer[pixelOffset + 1] = color.green;
      buffer[pixelOffset + 2] = color.red;
    }
  }
  return buffer;
}
