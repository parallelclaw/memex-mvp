/**
 * Shared Telegram-importer logic — used by both server.js (live, via inbox
 * watcher) and the CLI (`memex telegram import` direct write).
 *
 * Takes a better-sqlite3 Database connection (write mode) and a parsed
 * Telegram object (the shape produced by Telegram Desktop JSON export OR
 * lib/parse-telegram-html.js).
 *
 * Returns:
 *   {
 *     totalImported: <int>,           // messages inserted across all chats
 *     chats: [{
 *       conversation_id, title, msg_count, first_ts, last_ts
 *     }, ...]
 *   }
 *
 * UNIQUE(source, conversation_id, msg_id) handles dedupe — re-importing the
 * same chat (e.g. a fresh export with newer messages) only adds the delta.
 */

import { readFileSync } from 'node:fs';

export function importTelegramRaw(db, raw) {
  if (typeof raw === 'string') {
    raw = JSON.parse(readFileSync(raw, 'utf-8'));
  }

  const insertMessage = db.prepare(`
    INSERT INTO messages (source, conversation_id, msg_id, role, sender, text, ts, metadata, edited_at, uuid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, conversation_id, msg_id) DO UPDATE SET
      text = CASE
        WHEN excluded.edited_at IS NOT NULL
         AND (messages.edited_at IS NULL OR excluded.edited_at > messages.edited_at)
        THEN excluded.text ELSE messages.text END,
      edited_at = CASE
        WHEN excluded.edited_at IS NOT NULL
         AND (messages.edited_at IS NULL OR excluded.edited_at > messages.edited_at)
        THEN excluded.edited_at ELSE messages.edited_at END,
      uuid = COALESCE(messages.uuid, excluded.uuid)
  `);

  const upsertConversation = db.prepare(`
    INSERT INTO conversations (conversation_id, source, title, first_ts, last_ts, message_count, parent_conversation_id, project_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      title = excluded.title,
      first_ts = MIN(first_ts, excluded.first_ts),
      last_ts = MAX(last_ts, excluded.last_ts),
      parent_conversation_id = COALESCE(excluded.parent_conversation_id, parent_conversation_id),
      project_path = COALESCE(excluded.project_path, project_path),
      message_count = (
        SELECT COUNT(*) FROM messages
         WHERE messages.conversation_id = conversations.conversation_id
      )
  `);

  const chats = Array.isArray(raw.chats?.list)
    ? raw.chats.list
    : Array.isArray(raw.list)
    ? raw.list
    : raw.messages
    ? [raw]
    : [];

  const myUserId = String(raw?.personal_information?.user_id || raw?.user_id || '');
  let totalImported = 0;
  const chatSummaries = [];

  const tx = db.transaction((chatList) => {
    for (const chat of chatList) {
      if (!Array.isArray(chat.messages)) continue;

      const conversationId = `tg-${chat.id ?? chat.name ?? 'unknown'}`;
      const title =
        chat.name ||
        (chat.type === 'saved_messages' ? 'Saved Messages' : `Telegram chat ${chat.id}`);

      let first_ts = Infinity;
      let last_ts = 0;
      let chatMsgs = 0;

      for (const msg of chat.messages) {
        if (msg.type !== 'message') continue;

        let text = '';
        if (typeof msg.text === 'string') {
          text = msg.text;
        } else if (Array.isArray(msg.text)) {
          text = msg.text
            .map((f) => (typeof f === 'string' ? f : f.text || ''))
            .join('');
        }
        if (!text || !text.trim()) continue;

        const ts = parseInt(msg.date_unixtime || '0', 10);
        if (ts) {
          first_ts = Math.min(first_ts, ts);
          last_ts = Math.max(last_ts, ts);
        }

        const editedAt = msg.edited_unixtime
          ? parseInt(msg.edited_unixtime, 10) || null
          : null;

        const fromId = String(msg.from_id || '');
        const isMe =
          (myUserId && fromId === `user${myUserId}`) ||
          (myUserId && fromId === myUserId);
        const role = isMe ? 'user' : 'assistant';

        insertMessage.run(
          'telegram',
          conversationId,
          String(msg.id),
          role,
          msg.from || (isMe ? 'me' : 'bot'),
          text,
          ts,
          JSON.stringify({
            chat_name: chat.name,
            chat_type: chat.type,
            reply_to: msg.reply_to_message_id || null,
          }),
          editedAt,
          null
        );
        chatMsgs += 1;
      }

      if (chatMsgs > 0) {
        upsertConversation.run(
          conversationId,
          'telegram',
          title,
          isFinite(first_ts) ? first_ts : null,
          last_ts || null,
          chatMsgs,
          null,
          null
        );
        totalImported += chatMsgs;
        chatSummaries.push({
          conversation_id: conversationId,
          title,
          msg_count: chatMsgs,
          first_ts: isFinite(first_ts) ? first_ts : null,
          last_ts: last_ts || null,
        });
      }
    }
  });

  tx(chats);
  return { totalImported, chats: chatSummaries };
}
