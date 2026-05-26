import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { FileBox } from 'file-box';
import { WechatyBuilder, types as WechatyTypes } from 'wechaty';
import { stripBotMention } from '../../core/parser.js';
import type { BotRequestRouter } from '../../core/router.js';
import type { AppConfig, BotResponder, IncomingAttachment, IncomingMessage } from '../../types.js';
import { ensureDir, fileSize, safeFileName } from '../../utils/fs.js';

type WechatyMessage = any;
type WechatyRoom = any;

export class WechatyAdapter {
  private bot: any;

  constructor(
    private readonly config: AppConfig,
    private readonly router: BotRequestRouter,
    private readonly logger: Logger
  ) {}

  async start(): Promise<void> {
    this.bot = WechatyBuilder.build({
      name: this.config.bot.name,
      puppet: process.env.WECHATY_PUPPET ?? this.config.wechat.puppet,
      puppetOptions: this.config.wechat.puppetOptions
    } as any);

    this.bot
      .on('scan', (qrcode: string, status: string) => {
        this.logger.info(
          {
            status,
            qrcodeUrl: `https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`
          },
          'scan QR code to login'
        );
      })
      .on('login', (user: any) => {
        this.logger.info({ user: contactName(user), id: user?.id }, 'wechat login');
      })
      .on('logout', (user: any) => {
        this.logger.warn({ user: contactName(user), id: user?.id }, 'wechat logout');
      })
      .on('ready', () => {
        this.logger.info('wechat bot ready');
      })
      .on('heartbeat', (data: unknown) => {
        this.logger.debug({ data }, 'wechat heartbeat');
      })
      .on('error', (error: Error) => {
        this.logger.error({ error }, 'wechat adapter error');
      })
      .on('message', async (message: WechatyMessage) => {
        try {
          await this.onMessage(message);
        } catch (error) {
          this.logger.error({ error }, 'failed to handle wechat message');
        }
      });

    await this.bot.start();
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
    }
  }

  private async onMessage(message: WechatyMessage): Promise<void> {
    if (typeof message.self === 'function' && message.self()) return;

    const room = typeof message.room === 'function' ? message.room() : undefined;
    if (!room) return;

    const talker = typeof message.talker === 'function' ? message.talker() : undefined;
    const roomTopic = await roomTopicOf(room);
    const text = typeof message.text === 'function' ? message.text() : '';
    const mentioned = await this.isMentioned(message, text);
    const mentionText = await this.mentionText(message, text, mentioned);
    const attachments = await this.downloadAttachments(message, room.id, talker?.id);

    const incoming: IncomingMessage = {
      id: message.id ?? `msg_${randomUUID()}`,
      roomId: room.id,
      roomTopic,
      senderId: talker?.id ?? 'unknown',
      senderName: contactName(talker),
      text,
      mentioned,
      mentionText,
      attachments,
      timestamp: new Date()
    };

    const responder = new WechatyResponder(room, talker, this.config.bot.name);
    await this.router.handleMessage(incoming, responder);
  }

  private async isMentioned(message: WechatyMessage, text: string): Promise<boolean> {
    if (typeof message.mentionSelf === 'function') {
      try {
        return await message.mentionSelf();
      } catch (error) {
        this.logger.debug({ error }, 'mentionSelf failed, falling back to text matching');
      }
    }

    return stripBotMention(text, this.config.bot.mentionAliases).mentioned;
  }

  private async mentionText(message: WechatyMessage, text: string, mentioned: boolean): Promise<string> {
    if (!mentioned) return text.trim();

    if (typeof message.mentionText === 'function') {
      try {
        const mentionText = await message.mentionText();
        if (mentionText?.trim()) return mentionText.trim();
      } catch (error) {
        this.logger.debug({ error }, 'mentionText failed, falling back to text matching');
      }
    }

    return stripBotMention(text, this.config.bot.mentionAliases).text;
  }

  private async downloadAttachments(
    message: WechatyMessage,
    roomId: string,
    userId?: string
  ): Promise<IncomingAttachment[]> {
    const type = typeof message.type === 'function' ? message.type() : undefined;
    if (!isAttachmentType(type)) return [];
    if (typeof message.toFileBox !== 'function') return [];

    const fileBox = await message.toFileBox();
    const originalName = safeFileName(fileBox.name ?? `${message.id ?? randomUUID()}`);
    const fileName = originalName.includes('.') ? originalName : `${originalName}${extensionForType(type)}`;
    const dir = path.join(this.config.storage.uploadsDir, safeFileName(roomId), safeFileName(userId ?? 'unknown'));
    await ensureDir(dir);

    const filePath = path.join(dir, `${Date.now()}_${fileName}`);
    await fileBox.toFile(filePath, true);
    const sizeBytes = await fileSize(filePath);
    const mimeType = this.guessMimeType(fileName, type);
    const kind = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : 'file';

    return [
      {
        name: fileName,
        path: filePath,
        mimeType,
        sizeBytes,
        kind,
        messageId: message.id
      }
    ];
  }

  private guessMimeType(fileName: string, type: unknown): string {
    const ext = path.extname(fileName).toLowerCase();
    if (isImageType(type)) {
      if (ext === '.webp') return 'image/webp';
      if (ext === '.png') return 'image/png';
      return 'image/jpeg';
    }

    if (isVideoType(type)) {
      if (ext === '.webm') return 'video/webm';
      if (ext === '.mov') return 'video/mov';
      if (ext === '.mpeg' || ext === '.mpg') return 'video/mpeg';
      return 'video/mp4';
    }

    if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
    if (ext === '.webm') return 'video/webm';
    if (ext === '.mov') return 'video/mov';
    if (ext === '.mpeg' || ext === '.mpg') return 'video/mpeg';
    if (ext === '.pdf') return 'application/pdf';
    if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (ext === '.csv') return 'text/csv';
    if (ext === '.md') return 'text/markdown';
    if (ext === '.txt') return 'text/plain';
    return 'application/octet-stream';
  }
}

class WechatyResponder implements BotResponder {
  constructor(
    private readonly room: WechatyRoom,
    private readonly talker: any,
    private readonly botName: string
  ) {}

  async replyText(text: string): Promise<void> {
    const prefix = this.talker ? `@${contactName(this.talker)} ` : '';
    await this.room.say(`${prefix}${text}`);
  }

  async replyFile(filePath: string, displayName?: string): Promise<void> {
    await this.room.say(FileBox.fromFile(filePath, displayName));
  }

  async replyImage(filePath: string, displayName?: string): Promise<void> {
    await this.room.say(FileBox.fromFile(filePath, displayName));
  }
}

function isAttachmentType(type: unknown): boolean {
  return isImageType(type) || isVideoType(type) || type === WechatyTypes.Message.Attachment;
}

function isImageType(type: unknown): boolean {
  return type === WechatyTypes.Message.Image;
}

function isVideoType(type: unknown): boolean {
  return type === WechatyTypes.Message.Video;
}

function extensionForType(type: unknown): string {
  if (isImageType(type)) return '.jpg';
  if (isVideoType(type)) return '.mp4';
  return '.bin';
}

async function roomTopicOf(room: WechatyRoom): Promise<string> {
  if (typeof room.topic !== 'function') return room?.id ?? '';
  return room.topic();
}

function contactName(contact: any): string {
  if (!contact) return 'unknown';
  if (typeof contact.name === 'function') return contact.name();
  return contact.name ?? contact.id ?? 'unknown';
}
