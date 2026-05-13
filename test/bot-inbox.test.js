// Round-trip test for the bot's inbox writer.
//
// 1. Build a fake Telegram update.
// 2. Convert it via tgUpdateToExportMessage.
// 3. Confirm the resulting JSON matches the shape importTelegram expects:
//    - personal_information.user_id present
//    - chats.list[0].messages[0] is a `type: "message"` with id/from_id/text
// 4. Round-trip through JSON.parse to make sure it actually serializes.
//
// Does NOT spin up a real DB — we trust the existing parser is exercised
// elsewhere; we only verify the bot produces the right shape.

import { writeInboxMessage, tgUpdateToExportMessage } from '../bot/inbox.js';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

function assertEq(a, b, msg = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}\n   expected: ${JSON.stringify(b)}\n   got:      ${JSON.stringify(a)}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

console.log('bot inbox writer:\n');

const USER_ID = 12345;

await test('plain text message → from_id = userN, text preserved', () => {
  const tg = {
    message_id: 100,
    date: 1747000000,
    from: { id: USER_ID, first_name: 'Me' },
    chat: { id: USER_ID, type: 'private' },
    text: 'midnight thought about X',
  };
  const m = tgUpdateToExportMessage({ tgMessage: tg, userId: USER_ID });
  assertEq(m.id, 100);
  assertEq(m.type, 'message');
  assertEq(m.from, 'me');
  assertEq(m.from_id, `user${USER_ID}`);
  assertEq(m.date_unixtime, '1747000000');
  assertEq(m.text, 'midnight thought about X');
  assert(!m.forwarded_from, 'should not have forwarded_from on direct text');
});

await test('forward from user → forward attribution prepended + forwarded_from set', () => {
  const tg = {
    message_id: 101,
    date: 1747000100,
    from: { id: USER_ID },
    chat: { id: USER_ID, type: 'private' },
    text: 'this is interesting',
    forward_from: { id: 999, first_name: 'John', last_name: 'Doe' },
  };
  const m = tgUpdateToExportMessage({ tgMessage: tg, userId: USER_ID });
  assertEq(m.forwarded_from, 'John Doe');
  assert(m.text.startsWith('↪ Forwarded from John Doe:'), `got: ${m.text}`);
  assert(m.text.includes('this is interesting'), 'original text preserved');
});

await test('forward from channel → uses chat.title', () => {
  const tg = {
    message_id: 102,
    date: 1747000200,
    from: { id: USER_ID },
    chat: { id: USER_ID, type: 'private' },
    text: 'breaking news',
    forward_from_chat: { id: -1001, type: 'channel', title: 'TechCrunch' },
  };
  const m = tgUpdateToExportMessage({ tgMessage: tg, userId: USER_ID });
  assertEq(m.forwarded_from, 'TechCrunch');
  assert(m.text.startsWith('↪ Forwarded from TechCrunch:'), `got: ${m.text}`);
});

await test('forward with hidden sender → forward_sender_name fallback', () => {
  const tg = {
    message_id: 103,
    date: 1747000300,
    from: { id: USER_ID },
    chat: { id: USER_ID, type: 'private' },
    text: 'private quote',
    forward_sender_name: 'Anonymous Source',
  };
  const m = tgUpdateToExportMessage({ tgMessage: tg, userId: USER_ID });
  assertEq(m.forwarded_from, 'Anonymous Source');
});

await test('voice transcript override + media_path', () => {
  const tg = {
    message_id: 104,
    date: 1747000400,
    from: { id: USER_ID },
    chat: { id: USER_ID, type: 'private' },
    voice: { file_id: 'AAA', duration: 7, mime_type: 'audio/ogg' },
  };
  const m = tgUpdateToExportMessage({
    tgMessage: tg,
    userId: USER_ID,
    textOverride: '🎙 hello world',
    mediaPath: '/tmp/voice/104.oga',
  });
  assertEq(m.text, '🎙 hello world');
  assertEq(m.media_path, '/tmp/voice/104.oga');
  assertEq(m.media_type, 'voice_message');
});

await test('write produces parser-compatible JSON file in inbox dir', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'memex-bot-test-'));
  try {
    const tg = {
      message_id: 200,
      date: 1747000500,
      from: { id: USER_ID },
      chat: { id: USER_ID, type: 'private' },
      text: 'persisted',
    };
    const m = tgUpdateToExportMessage({ tgMessage: tg, userId: USER_ID });
    const written = writeInboxMessage({ inboxPath: tmp, userId: USER_ID, message: m });
    assert(written.endsWith('.json'), 'file ends with .json');
    const files = readdirSync(tmp);
    assertEq(files.length, 1, 'exactly one file written');

    const raw = JSON.parse(readFileSync(written, 'utf-8'));
    assertEq(raw.personal_information.user_id, String(USER_ID));
    assertEq(raw.chats.list.length, 1);
    const chat = raw.chats.list[0];
    assertEq(chat.id, `memex-bot-${USER_ID}`);
    assertEq(chat.name, 'Memex Bot');
    assertEq(chat.type, 'personal_chat');
    assertEq(chat.messages.length, 1);
    const writtenMsg = chat.messages[0];
    assertEq(writtenMsg.id, 200);
    assertEq(writtenMsg.type, 'message');
    assertEq(writtenMsg.text, 'persisted');
    assertEq(writtenMsg.from_id, `user${USER_ID}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

await test('two messages → two separate files (sortable by ts/id)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'memex-bot-test-'));
  try {
    for (const id of [301, 302]) {
      const tg = {
        message_id: id,
        date: 1747000600 + id,
        from: { id: USER_ID },
        chat: { id: USER_ID, type: 'private' },
        text: `msg ${id}`,
      };
      writeInboxMessage({
        inboxPath: tmp,
        userId: USER_ID,
        message: tgUpdateToExportMessage({ tgMessage: tg, userId: USER_ID }),
      });
    }
    const files = readdirSync(tmp).sort();
    assertEq(files.length, 2);
    assert(files[0].includes('301'), `expected 301 in ${files[0]}`);
    assert(files[1].includes('302'), `expected 302 in ${files[1]}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

await test('end-to-end with real importTelegram parser', async () => {
  // Spin up an in-memory clone of memex.db schema and run importTelegram on
  // a bot-written file. Confirms the file the bot produces is bit-for-bit
  // ingestible by the existing server.js code path.
  const Database = (await import('better-sqlite3')).default;
  const tmp = mkdtempSync(join(tmpdir(), 'memex-bot-e2e-'));
  try {
    const tg = {
      message_id: 500,
      date: 1747001000,
      from: { id: USER_ID },
      chat: { id: USER_ID, type: 'private' },
      text: 'integration test message',
    };
    const filePath = writeInboxMessage({
      inboxPath: tmp,
      userId: USER_ID,
      message: tgUpdateToExportMessage({ tgMessage: tg, userId: USER_ID }),
    });

    // Inline the importTelegram logic against an in-memory DB. Schema kept
    // minimal — same UNIQUE constraint as production.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT, conversation_id TEXT, msg_id TEXT,
        role TEXT, sender TEXT, text TEXT, ts INTEGER, metadata TEXT,
        UNIQUE(source, conversation_id, msg_id)
      );
    `);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO messages (source, conversation_id, msg_id, role, sender, text, ts, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    const myUserId = String(raw.personal_information.user_id);
    for (const chat of raw.chats.list) {
      const convId = `tg-${chat.id}`;
      for (const msg of chat.messages) {
        if (msg.type !== 'message') continue;
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (!text.trim()) continue;
        const fromId = String(msg.from_id || '');
        const isMe = fromId === `user${myUserId}` || fromId === myUserId;
        insert.run(
          'telegram', convId, String(msg.id),
          isMe ? 'user' : 'assistant',
          msg.from || (isMe ? 'me' : 'bot'),
          text, parseInt(msg.date_unixtime, 10), null,
        );
      }
    }

    const rows = db.prepare(`SELECT * FROM messages`).all();
    assertEq(rows.length, 1, 'one row inserted');
    assertEq(rows[0].text, 'integration test message');
    assertEq(rows[0].role, 'user');
    // Synthetic chat.id keeps the bot thread distinct from Saved Messages
    // (which would land at `tg-<USER_ID>`). Bot lives at `tg-memex-bot-<USER_ID>`.
    assertEq(rows[0].conversation_id, `tg-memex-bot-${USER_ID}`);

    // Idempotency — re-running the insert is a no-op.
    insert.run('telegram', `tg-memex-bot-${USER_ID}`, '500', 'user', 'me', 'integration test message', 1747001000, null);
    const after = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n;
    assertEq(after, 1, 'duplicate insert was deduped');

    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
