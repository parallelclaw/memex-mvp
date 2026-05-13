/**
 * Long-poll runner — owns the getUpdates loop, allowlist gating, update
 * dispatch (text / forward / voice / command), and error backoff.
 *
 * Each accepted message is converted into a Telegram-Desktop-export-format
 * JSON snippet and dropped into the memex inbox. The MCP server's existing
 * inbox watcher does the rest (parse → DB → archive). Bot does NOT touch
 * SQLite for ingest, only for /search and /recent reads.
 *
 * State (last update offset) lives in ~/.memex/data/bot-state.json so a
 * restart resumes where it stopped instead of replaying Telegram's 24h
 * server-side buffer.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TelegramClient } from './telegram.js';
import { writeInboxMessage, tgUpdateToExportMessage } from './inbox.js';
import { transcribe } from './nexara.js';
import { searchMemex, recentMemex, renderSearchResults, renderRecent } from './search.js';

const HELP_TEXT =
  '*Memex bot* — your mobile capture surface.\n\n' +
  'Send any text, forward any message, or send a voice note — it goes ' +
  'straight into your memex memory.\n\n' +
  'Commands:\n' +
  '  /search <query> — search across all memex sources\n' +
  '  /recent — most recent captures\n' +
  '  /help — this message\n\n' +
  '_Bot is local-only: when your laptop is asleep, messages buffer on ' +
  "Telegram's side for ~24h and catch up on next poll. For longer gaps, " +
  'export the chat from Telegram Desktop and drop result.json into ' +
  '~/.memex/inbox/.';

export class BotRunner {
  constructor({ config, log }) {
    this.config = config;
    this.log = log || ((...a) => console.error('[bot]', ...a));
    this.tg = new TelegramClient(config.telegram_bot_token);
    this.allowlist = new Set(config.allowlist_user_ids);
    this.lastUpdateId = this._loadOffset();
    this.shuttingDown = false;
  }

  _loadOffset() {
    try {
      if (existsSync(this.config.state_path)) {
        const s = JSON.parse(readFileSync(this.config.state_path, 'utf-8'));
        if (typeof s.lastUpdateId === 'number') return s.lastUpdateId;
      }
    } catch (_) {}
    return 0;
  }

  _saveOffset() {
    try {
      mkdirSync(dirname(this.config.state_path), { recursive: true });
      const tmp = this.config.state_path + '.tmp';
      writeFileSync(tmp, JSON.stringify({ lastUpdateId: this.lastUpdateId }));
      renameSync(tmp, this.config.state_path);
    } catch (e) {
      this.log(`! could not save offset: ${e.message}`);
    }
  }

  async start() {
    let me;
    try { me = await this.tg.getMe(); }
    catch (e) {
      throw new Error(`getMe failed — token invalid? ${e.message}`);
    }
    this.log(`✓ connected as @${me.username} (id=${me.id})`);
    this.log(`  allowlist: ${[...this.allowlist].join(', ')}`);
    this.log(`  inbox:     ${this.config.inbox_path}`);
    this.log(`  voice:     ${this.config.voice_enabled ? 'enabled (Nexara)' : 'disabled'}`);
    this.log(`  resuming from update_id ${this.lastUpdateId}`);

    let backoffMs = 1000;
    while (!this.shuttingDown) {
      try {
        const updates = await this.tg.getUpdates({
          offset: this.lastUpdateId + 1,
          timeout: 30,
        });
        backoffMs = 1000;
        for (const update of updates) {
          if (this.shuttingDown) break;
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          try {
            await this._handleUpdate(update);
          } catch (e) {
            this.log(`! handler error on update ${update.update_id}: ${e.stack || e.message}`);
          }
        }
        if (updates.length > 0) this._saveOffset();
      } catch (e) {
        if (this.shuttingDown) break;
        this.log(`! poll error: ${e.message}, retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60000);
      }
    }
    this.log('poll loop exited');
  }

  stop() {
    this.shuttingDown = true;
  }

  async _handleUpdate(update) {
    const msg = update.message;
    if (!msg) return;
    const fromId = msg.from?.id;
    const chatId = msg.chat?.id;
    if (!fromId || !chatId) return;

    if (!this.allowlist.has(Number(fromId))) {
      this.log(`! rejecting message from non-allowlisted user ${fromId} (${msg.from?.username || '?'})`);
      try {
        await this.tg.sendMessage(
          chatId,
          'This bot is private and not accepting messages. (Memex personal capture surface.)'
        );
      } catch (_) {}
      return;
    }

    // Commands first.
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (text.startsWith('/')) {
      return this._handleCommand({ chatId, msg, text });
    }

    // Voice message
    if (msg.voice) {
      return this._handleVoice({ chatId, msg });
    }

    // Text or forwarded text/caption
    if (text || msg.caption || msg.forward_from || msg.forward_from_chat || msg.forward_sender_name) {
      return this._handleText({ chatId, msg });
    }

    // Anything else (photo / sticker / document without caption etc.) — not
    // in v0.1 scope; acknowledge so user knows it didn't silently succeed.
    try {
      await this.tg.sendMessage(
        chatId,
        '⚠️ Only text, forwarded messages, and voice notes are captured in this version.'
      );
    } catch (_) {}
  }

  async _handleText({ chatId, msg }) {
    const exportMsg = tgUpdateToExportMessage({
      tgMessage: msg,
      userId: this.allowlist.values().next().value, // single-user bot — first allowlisted id
    });
    if (!exportMsg.text) {
      // Empty after assembly — nothing to capture.
      return;
    }
    try {
      const path = writeInboxMessage({
        inboxPath: this.config.inbox_path,
        userId: this.allowlist.values().next().value,
        message: exportMsg,
      });
      this.log(`+ captured msg ${msg.message_id} (${exportMsg.text.length} chars) → ${path.split('/').pop()}`);
      const ack = msg.forward_from || msg.forward_from_chat || msg.forward_sender_name
        ? '✓ saved (forward)'
        : '✓ saved';
      await this.tg.sendMessage(chatId, ack, { reply_to_message_id: msg.message_id, disable_notification: true });
    } catch (e) {
      this.log(`! capture failed: ${e.message}`);
      try { await this.tg.sendMessage(chatId, `⚠️ Couldn't save: ${e.message.slice(0, 200)}`); } catch (_) {}
    }
  }

  async _handleVoice({ chatId, msg }) {
    if (!this.config.voice_enabled) {
      try {
        await this.tg.sendMessage(
          chatId,
          '⚠️ Voice capture is disabled (no Nexara API key configured).',
          { reply_to_message_id: msg.message_id }
        );
      } catch (_) {}
      return;
    }
    try {
      await this.tg.sendChatAction(chatId, 'typing');
    } catch (_) {}

    let audioBuf, mediaPath = null;
    try {
      const file = await this.tg.getFile(msg.voice.file_id);
      audioBuf = await this.tg.downloadFile(file.file_path);
    } catch (e) {
      this.log(`! voice download failed: ${e.message}`);
      try { await this.tg.sendMessage(chatId, `⚠️ Couldn't download voice: ${e.message.slice(0, 200)}`, { reply_to_message_id: msg.message_id }); } catch (_) {}
      return;
    }

    // Persist OGG before transcription so the original is recoverable
    // even if Nexara is down.
    try {
      mkdirSync(this.config.media_path, { recursive: true });
      mediaPath = join(this.config.media_path, `${msg.message_id}.oga`);
      writeFileSync(mediaPath, audioBuf);
    } catch (e) {
      this.log(`! could not save voice file: ${e.message}`);
      mediaPath = null;
    }

    let transcript;
    try {
      const result = await transcribe({
        audioBuffer: audioBuf,
        apiKey: this.config.nexara_api_key,
        filename: `${msg.message_id}.oga`,
        mimeType: 'audio/ogg',
        language: 'ru',
      });
      transcript = result.text;
    } catch (e) {
      this.log(`! transcription failed: ${e.message}`);
      try { await this.tg.sendMessage(chatId, `⚠️ Transcription failed: ${e.message.slice(0, 200)}`, { reply_to_message_id: msg.message_id }); } catch (_) {}
      return;
    }
    if (!transcript) {
      try { await this.tg.sendMessage(chatId, '⚠️ Transcription was empty.', { reply_to_message_id: msg.message_id }); } catch (_) {}
      return;
    }

    const userId = this.allowlist.values().next().value;
    const exportMsg = tgUpdateToExportMessage({
      tgMessage: msg,
      userId,
      textOverride: `🎙 ${transcript}`,
      mediaPath,
    });

    try {
      const path = writeInboxMessage({
        inboxPath: this.config.inbox_path,
        userId,
        message: exportMsg,
      });
      this.log(`+ captured voice ${msg.message_id} (${transcript.length} chars) → ${path.split('/').pop()}`);
      const preview = transcript.length > 140 ? transcript.slice(0, 140) + '…' : transcript;
      await this.tg.sendMessage(
        chatId,
        `✓ transcribed: ${preview}`,
        { reply_to_message_id: msg.message_id, disable_notification: true }
      );
    } catch (e) {
      this.log(`! capture failed: ${e.message}`);
      try { await this.tg.sendMessage(chatId, `⚠️ Couldn't save transcript: ${e.message.slice(0, 200)}`); } catch (_) {}
    }
  }

  async _handleCommand({ chatId, msg, text }) {
    // Strip @botname suffix Telegram appends in groups (e.g. /search@MyBot foo)
    const m = text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    if (!m) return;
    const cmd = m[1].toLowerCase();
    const arg = (m[2] || '').trim();

    if (cmd === 'help' || cmd === 'start') {
      await this.tg.sendMessage(chatId, HELP_TEXT, { parse_mode: 'Markdown' });
      return;
    }
    if (cmd === 'search') {
      if (!arg) {
        await this.tg.sendMessage(chatId, 'Usage: `/search <query>`', { parse_mode: 'Markdown' });
        return;
      }
      const { rows, error } = searchMemex({ dbPath: this.config.db_path, query: arg, limit: 3 });
      if (error) {
        await this.tg.sendMessage(chatId, `⚠️ ${error}`);
        return;
      }
      const body = renderSearchResults(arg, rows);
      await this.tg.sendMessage(chatId, body, { parse_mode: 'Markdown' });
      return;
    }
    if (cmd === 'recent') {
      const { rows, error } = recentMemex({ dbPath: this.config.db_path, limit: 5 });
      if (error) {
        await this.tg.sendMessage(chatId, `⚠️ ${error}`);
        return;
      }
      await this.tg.sendMessage(chatId, renderRecent(rows), { parse_mode: 'Markdown' });
      return;
    }
    // Unknown command — capture it as text so it isn't lost.
    return this._handleText({ chatId, msg });
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
