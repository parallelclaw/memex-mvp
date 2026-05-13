/**
 * Build a minimal Telegram-Desktop-export JSON snippet for one captured
 * message and write it atomically to the memex inbox.
 *
 * The shape mirrors what `importTelegram` (server.js) expects:
 *   {
 *     personal_information: { user_id: "<me>" },
 *     chats: { list: [{ id, name, type, messages: [oneMsg] }] }
 *   }
 *
 * One file per message. The conversation_id derived by the parser is
 * `tg-<chat.id>`. We set chat.id to the string `memex-bot-<userId>` (NOT
 * the bare Telegram user_id) so the resulting conversation_id is
 * `tg-memex-bot-<userId>` — distinct from any real Telegram chat.id and,
 * critically, distinct from "Saved Messages" exports (which Telegram
 * Desktop emits with chat.id == your own user_id, so a synthetic prefix
 * here is the only thing keeping the two streams from merging).
 *
 * Every captured message — typed, forwarded, voice-transcribed — lands
 * in this same dedicated thread.
 *
 * Idempotency is automatic: each message uses Telegram's stable msg.id,
 * and `messages` has UNIQUE(source, conversation_id, msg_id). Reprocessing
 * the same update is a no-op at the DB layer.
 */

import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const CHAT_NAME = 'Memex Bot';

/**
 * Write a single message to the inbox. Returns the absolute path written.
 *
 * @param {object} opts
 * @param {string} opts.inboxPath  - directory to write into
 * @param {number|string} opts.userId - the bot owner's Telegram user_id (becomes chat.id and from_id seed)
 * @param {object} opts.message    - the constructed TG-export message object (id, type, date, date_unixtime, from, from_id, text, [forwarded_from], [media_path], …)
 */
export function writeInboxMessage({ inboxPath, userId, message }) {
  if (!inboxPath) throw new Error('writeInboxMessage: inboxPath required');
  if (userId === undefined || userId === null) throw new Error('writeInboxMessage: userId required');
  if (!message || !message.id) throw new Error('writeInboxMessage: message.id required');

  mkdirSync(inboxPath, { recursive: true });

  const payload = {
    personal_information: { user_id: String(userId) },
    chats: {
      list: [
        {
          // Synthetic chat.id keeps the bot thread separate from any real
          // Telegram chat (including Saved Messages, which uses the bare
          // user_id). Resulting conversation_id is `tg-memex-bot-<userId>`.
          id: `memex-bot-${userId}`,
          name: CHAT_NAME,
          type: 'personal_chat',
          messages: [message],
        },
      ],
    },
  };

  const ts = parseInt(message.date_unixtime, 10) || Math.floor(Date.now() / 1000);
  const fileName = `bot-${ts}-${message.id}.json`;
  const targetPath = join(inboxPath, fileName);
  const tmpPath = targetPath + '.tmp';

  try {
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
    renameSync(tmpPath, targetPath);
  } catch (e) {
    try { unlinkSync(tmpPath); } catch (_) {}
    throw e;
  }
  return targetPath;
}

/**
 * Convert a Telegram getUpdates `update.message` into the export-format
 * message object expected by the parser.
 *
 * Forwards: prepend `↪ Forwarded from <name>:` to text so it's searchable
 * via FTS5; also keep `forwarded_from` on the record for archival round-trip
 * (parser ignores it but the JSON lives forever in ~/.memex/data/conversations).
 *
 * Voice: caller passes `textOverride` (the Nexara transcription) and
 * `mediaPath` (where the OGG was saved).
 *
 * @param {object} opts
 * @param {object} opts.tgMessage     - raw Telegram message
 * @param {number|string} opts.userId - bot owner's user_id (used as from_id)
 * @param {string} [opts.textOverride] - replace text (used for voice transcripts)
 * @param {string} [opts.mediaPath]   - absolute path to saved media (informational)
 */
export function tgUpdateToExportMessage({ tgMessage, userId, textOverride, mediaPath }) {
  const ts = tgMessage.date || Math.floor(Date.now() / 1000);
  const isoDate = new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, '');

  const fwd = tgMessage.forward_from || tgMessage.forward_from_chat;
  let forwardedName = null;
  if (fwd) {
    if (tgMessage.forward_from) {
      const f = tgMessage.forward_from;
      forwardedName = [f.first_name, f.last_name].filter(Boolean).join(' ') || f.username || `user${f.id}`;
    } else {
      const c = tgMessage.forward_from_chat;
      forwardedName = c.title || c.username || `chat${c.id}`;
    }
  } else if (tgMessage.forward_sender_name) {
    forwardedName = tgMessage.forward_sender_name;
  }

  // Resolve text payload from possible sources.
  let text;
  if (typeof textOverride === 'string') {
    text = textOverride;
  } else if (typeof tgMessage.text === 'string') {
    text = tgMessage.text;
  } else if (typeof tgMessage.caption === 'string') {
    text = tgMessage.caption;
  } else {
    text = '';
  }

  if (forwardedName && text) {
    text = `↪ Forwarded from ${forwardedName}:\n\n${text}`;
  } else if (forwardedName && !text) {
    text = `↪ Forwarded from ${forwardedName}: (no text)`;
  }

  const msg = {
    id: tgMessage.message_id,
    type: 'message',
    date: isoDate,
    date_unixtime: String(ts),
    from: 'me',
    from_id: `user${userId}`,
    text,
  };

  if (forwardedName) {
    msg.forwarded_from = forwardedName;
  }
  if (mediaPath) {
    msg.media_path = mediaPath;
    msg.media_type = 'voice_message';
  }
  if (tgMessage.reply_to_message?.message_id) {
    msg.reply_to_message_id = tgMessage.reply_to_message.message_id;
  }
  return msg;
}
