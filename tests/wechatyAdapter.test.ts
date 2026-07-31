import { describe, expect, it } from 'vitest';
import { guessWechatyMimeType, WechatyAdapter } from '../src/adapters/wechaty/wechatyAdapter.js';
import { makeTestConfig, silentLogger } from './helpers.js';

describe('WechatyAdapter helpers', () => {
  it('recognizes images sent as generic WeChat attachments', () => {
    expect(guessWechatyMimeType('cat.png', undefined)).toBe('image/png');
    expect(guessWechatyMimeType('cat.jpg', undefined)).toBe('image/jpeg');
    expect(guessWechatyMimeType('cat.jpeg', undefined)).toBe('image/jpeg');
    expect(guessWechatyMimeType('cat.webp', undefined)).toBe('image/webp');
  });

  it('resolves automation responders through a live topic before stale loaded ids', async () => {
    const config = await makeTestConfig({
      auth: {
        rooms: [
          {
            stableId: 'stable-room',
            id: 'stable-room',
            runtimeIds: ['old-runtime'],
            topic: '猫窝',
            enabled: true,
            admins: []
          }
        ]
      }
    });
    const liveRoom = fakeRoom('live-room');
    const staleRoom = fakeRoom('stale-room');
    const findCalls: Array<Record<string, string>> = [];
    const adapter = new WechatyAdapter(config, {} as never, silentLogger());
    (adapter as any).bot = {
      Room: {
        find: async (query: Record<string, string>) => {
          findCalls.push(query);
          return query.topic === '猫窝' ? liveRoom : undefined;
        },
        load: () => staleRoom
      }
    };

    const responder = await adapter.createRoomResponder('stable-room');
    await responder?.replyText('测试');

    expect(findCalls).toContainEqual({ topic: '猫窝' });
    expect(liveRoom.sent).toEqual(['测试']);
    expect(staleRoom.sent).toEqual([]);
  });
});

function fakeRoom(id: string): { id: string; sent: string[]; say: (message: string) => Promise<void> } {
  return {
    id,
    sent: [],
    async say(message: string) {
      this.sent.push(message);
    }
  };
}
