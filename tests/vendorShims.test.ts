import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const openGraph = require('../vendor/open-graph') as {
  parse(html: string): Record<string, unknown>;
  getHTML(url: string, userAgent: string, cb: (error?: Error, html?: string) => void): void;
};
const fileType = require('../vendor/file-type') as {
  fromBuffer(input: Buffer): Promise<{ ext: string; mime: string } | undefined>;
};

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (!closeServer) return;
  await closeServer();
  closeServer = undefined;
});

describe('vendor compatibility shims', () => {
  it('parses open graph metadata without throwing on malformed numeric entities', () => {
    expect(() =>
      openGraph.parse('<meta property="og:title" content="bad &#999999999999;">')
    ).not.toThrow();
    expect(openGraph.parse('<meta property="og:title" content="Hello &amp; Hi">')).toMatchObject({
      title: 'Hello & Hi'
    });
  });

  it('returns an error for invalid redirect locations', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader('Location', 'http://[');
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');

    const error = await new Promise<Error | undefined>((resolve) => {
      openGraph.getHTML(`http://127.0.0.1:${address.port}`, 'test', (callbackError) => {
        resolve(callbackError);
      });
    });

    expect(error?.message).toBe('Invalid redirect URL');
  });

  it('detects common image types for Jimp compatibility', async () => {
    await expect(
      fileType.fromBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ).resolves.toEqual({ ext: 'png', mime: 'image/png' });
  });
});
