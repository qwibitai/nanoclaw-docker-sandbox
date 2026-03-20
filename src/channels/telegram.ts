import https from 'node:https';
import {
  type Api,
  Bot,
  type Context,
  type Filter,
  webhookCallback,
} from 'grammy';

import {
  ASSISTANT_NAME,
  TELEGRAM_WEBHOOK_PORT,
  TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_WEBHOOK_URL,
  TRIGGER_PATTERN,
} from '../config.js';
import { startWebhookServer, type WebhookServer } from '../telegram-webhook.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import type {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { type ChannelOpts, registerChannel } from './registry.js';

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onPermissionResponse?: (
    groupFolder: string,
    requestId: string,
    decision: 'once' | 'always' | 'deny',
  ) => void;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private webhookServer: WebhookServer | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private lastProcessedUpdateId = 0;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private registerDedupMiddleware(): void {
    if (!this.bot) return;
    this.bot.use(async (ctx, next) => {
      if (ctx.update.update_id <= this.lastProcessedUpdateId) return;
      await next();
      this.lastProcessedUpdateId = ctx.update.update_id;
    });
  }

  private startHealthMonitor(): void {
    const HEALTH_INTERVAL = 5 * 60 * 1000;
    this.healthInterval = setInterval(async () => {
      if (!this.bot) return;
      try {
        const info = await this.bot.api.getWebhookInfo();
        if (!info.url) {
          logger.warn('Webhook dropped by Telegram, re-registering');
          await this.bot.api.setWebhook(TELEGRAM_WEBHOOK_URL, {
            secret_token: TELEGRAM_WEBHOOK_SECRET || undefined,
          });
        }
        if (info.last_error_date) {
          logger.warn(
            {
              lastError: info.last_error_message,
              lastErrorDate: new Date(
                info.last_error_date * 1000,
              ).toISOString(),
              pendingUpdates: info.pending_update_count,
            },
            'Telegram webhook has errors',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Webhook health check failed');
      }
    }, HEALTH_INTERVAL);
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    this.registerDedupMiddleware();

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : 'title' in ctx.chat
            ? ctx.chat.title
            : 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : 'title' in ctx.chat
            ? ctx.chat.title
            : chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle permission approval callbacks (inline once/always/deny buttons)
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      // Format: once_<reqId> | always_<reqId> | deny_<reqId>
      const match = data.match(
        /^(once|always-allow|always-deny|always|deny)_(.+)$/,
      );
      if (!match) return;

      const [, action, requestId] = match;
      if (!action || !requestId) return;
      const chatJid = `tg:${ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];

      if (!group) {
        logger.warn({ chatJid }, 'Permission response from unregistered chat');
        await ctx.answerCallbackQuery({ text: 'Unknown chat — ignored.' });
        return;
      }

      // Map action to decision (always-allow/always-deny both map to 'always')
      const decision: 'once' | 'always' | 'deny' =
        action === 'always-allow' ||
        action === 'always-deny' ||
        action === 'always'
          ? 'always'
          : (action as 'once' | 'deny');
      this.opts.onPermissionResponse?.(group.folder, requestId, decision);

      const labelMap: Record<string, string> = {
        once: '✅ Approved (once)',
        deny: '❌ Denied',
        'always-allow': '✅ Rule saved (always allow)',
        'always-deny': '🚫 Rule saved (always deny)',
        always: '✅ Rule saved',
      };
      await ctx.answerCallbackQuery({ text: labelMap[action] ?? '✅ Done' });

      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: { inline_keyboard: [] },
        });
      } catch {
        /* non-critical */
      }

      logger.info(
        { chatJid, requestId, decision },
        'Permission response received',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (
      ctx: Filter<Context, 'message'>,
      placeholder: string,
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Webhook mode: init bot, start HTTP server, register webhook
    await this.bot.init();
    logger.info(
      { username: this.bot.botInfo.username, id: this.bot.botInfo.id },
      'Telegram bot initialized (webhook mode)',
    );

    const handler = webhookCallback(this.bot, 'http', {
      secretToken: TELEGRAM_WEBHOOK_SECRET || undefined,
    });
    this.webhookServer = await startWebhookServer({
      port: TELEGRAM_WEBHOOK_PORT,
      handler,
    });

    await this.bot.api.setWebhook(TELEGRAM_WEBHOOK_URL, {
      secret_token: TELEGRAM_WEBHOOK_SECRET || undefined,
    });
    logger.info({ url: TELEGRAM_WEBHOOK_URL }, 'Telegram webhook registered');

    this.startHealthMonitor();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendPermissionRequest(
    jid: string,
    requestId: string,
    egressType: string,
    subject: string,
    groupFolder: string,
    proposal: {
      name: string;
      patterns: string[];
      effect: string;
      scope: string;
      description: string;
    } | null,
    toolInput?: unknown,
  ): Promise<number | null> {
    if (!this.bot) return null;

    // Format subject for display
    let displaySubject: string;
    const mcpMatch = subject.match(/^mcp__([^_]+)__(.+)$/);
    if (mcpMatch) {
      const server = mcpMatch[1] ?? '';
      const tool = mcpMatch[2] ?? '';
      displaySubject = `${escHtml(server)} → <code>${escHtml(tool)}</code>`;
    } else {
      displaySubject = `<code>${escHtml(subject)}</code>`;
    }

    const typeLabel =
      egressType === 'connect'
        ? '🌐 HTTPS'
        : egressType === 'http'
          ? '🌐 HTTP'
          : '🔧 MCP';

    // Only show input if it has meaningful content (not empty object/null)
    let toolInputText = '';
    if (toolInput != null) {
      const raw =
        typeof toolInput === 'string'
          ? toolInput
          : JSON.stringify(toolInput, null, 2);
      const isEmptyObject = raw === '{}' || raw === 'null' || raw === '""';
      if (!isEmptyObject && raw.trim()) {
        const truncated = raw.length > 500 ? `${raw.slice(0, 497)}...` : raw;
        toolInputText = `\n<pre>${escHtml(truncated)}</pre>`;
      }
    }

    const text =
      `🔐 <b>Permission</b>\n\n` +
      `${typeLabel} ${displaySubject}\n` +
      `Group: ${escHtml(groupFolder)}` +
      toolInputText;

    // Row 1: Allow once / Deny once
    // Row 2: Always allow/deny (if proposal exists)
    const row1 = [
      { text: '✅ Allow once', callback_data: `once_${requestId}` },
      { text: '❌ Deny once', callback_data: `deny_${requestId}` },
    ];

    const keyboard = [row1];

    if (proposal) {
      const effectEmoji = proposal.effect === 'deny' ? '🚫' : '✅';
      const effectLabel =
        proposal.effect === 'deny' ? 'Always deny' : 'Always allow';
      const patternsLine = proposal.patterns.join(', ');
      const callbackAction =
        proposal.effect === 'deny' ? 'always-deny' : 'always-allow';
      keyboard.push([
        {
          text: `${effectEmoji} ${effectLabel}: ${proposal.description}\n${patternsLine}`,
          callback_data: `${callbackAction}_${requestId}`,
        },
      ]);
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const msg = await this.bot.api.sendMessage(numericId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard },
      });
      logger.info({ jid, requestId }, 'Permission request sent');
      return msg.message_id;
    } catch (err) {
      logger.error(
        { jid, requestId, err },
        'Failed to send permission request',
      );
      return null;
    }
  }

  async clearPermissionKeyboard(jid: string, messageId: number): Promise<void> {
    if (!this.bot) return;
    try {
      const numericId = parseInt(jid.replace(/^tg:/, ''), 10);
      await this.bot.api.editMessageReplyMarkup(numericId, messageId, {
        reply_markup: { inline_keyboard: [] },
      });
    } catch {
      /* non-critical — message may already be gone */
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    if (this.webhookServer) {
      await this.webhookServer.stop();
      this.webhookServer = null;
    }
    if (this.bot) {
      try {
        await this.bot.api.deleteWebhook();
      } catch (err) {
        logger.error({ err }, 'Failed to delete webhook on disconnect');
      }
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_URL',
    'TELEGRAM_WEBHOOK_SECRET',
  ]);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  const webhookUrl =
    process.env.TELEGRAM_WEBHOOK_URL || envVars.TELEGRAM_WEBHOOK_URL || '';
  if (!webhookUrl) {
    logger.error(
      'Telegram: TELEGRAM_WEBHOOK_URL not set — cannot start. ' +
        'Set TELEGRAM_WEBHOOK_URL in .env to your Cloudflare Tunnel URL (e.g. https://nanoclaw-tg.yourdomain.com/webhook)',
    );
    return null;
  }
  return new TelegramChannel(token, opts);
});
