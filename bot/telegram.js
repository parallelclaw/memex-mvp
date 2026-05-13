/**
 * Thin wrapper around Telegram Bot API HTTP endpoints used by the bot.
 * Native fetch only — no node-telegram / telegraf / grammy dependency.
 *
 * - getUpdates: long-polling with offset persistence
 * - sendMessage / sendChatAction
 * - getFile + downloadFile (for voice messages)
 *
 * Errors that aren't fatal (network blips, Telegram 5xx, 429) are retried
 * with exponential backoff in the run loop, not here.
 */

const API_BASE = 'https://api.telegram.org';

export class TelegramClient {
  constructor(token) {
    if (!token) throw new Error('TelegramClient: token required');
    this.token = token;
    this.api = `${API_BASE}/bot${token}`;
    this.fileApi = `${API_BASE}/file/bot${token}`;
  }

  async _post(method, body) {
    const resp = await fetch(`${this.api}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.ok === false) {
      const err = new Error(`telegram ${method}: HTTP ${resp.status} ${json.description || ''}`);
      err.status = resp.status;
      err.tgError = json;
      throw err;
    }
    return json.result;
  }

  /** Long-poll for updates. Returns array of update objects. */
  async getUpdates({ offset, timeout = 30, allowedUpdates = ['message'] }) {
    const url = new URL(`${this.api}/getUpdates`);
    if (offset !== undefined && offset !== null) url.searchParams.set('offset', String(offset));
    url.searchParams.set('timeout', String(timeout));
    url.searchParams.set('allowed_updates', JSON.stringify(allowedUpdates));

    // HTTP timeout = polling timeout + buffer for connection setup.
    const resp = await fetch(url, { signal: AbortSignal.timeout((timeout + 15) * 1000) });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.ok === false) {
      const err = new Error(`telegram getUpdates: HTTP ${resp.status} ${json.description || ''}`);
      err.status = resp.status;
      throw err;
    }
    return json.result || [];
  }

  async sendMessage(chatId, text, opts = {}) {
    const body = { chat_id: chatId, text };
    if (opts.parse_mode) body.parse_mode = opts.parse_mode;
    if (opts.reply_to_message_id) body.reply_to_message_id = opts.reply_to_message_id;
    if (opts.disable_notification) body.disable_notification = true;
    return this._post('sendMessage', body);
  }

  async sendChatAction(chatId, action) {
    return this._post('sendChatAction', { chat_id: chatId, action });
  }

  /** getFile returns { file_id, file_unique_id, file_size, file_path }. */
  async getFile(fileId) {
    const url = new URL(`${this.api}/getFile`);
    url.searchParams.set('file_id', fileId);
    const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.ok === false) {
      throw new Error(`telegram getFile: HTTP ${resp.status} ${json.description || ''}`);
    }
    return json.result;
  }

  /** Download a file by file_path (returned by getFile). Returns Buffer. */
  async downloadFile(filePath) {
    const url = `${this.fileApi}/${filePath}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!resp.ok) {
      throw new Error(`telegram downloadFile: HTTP ${resp.status}`);
    }
    const buf = await resp.arrayBuffer();
    return Buffer.from(buf);
  }

  async getMe() {
    return this._post('getMe', {});
  }
}
