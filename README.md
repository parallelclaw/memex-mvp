# memex-mvp · your AI's missing memory

> **Claude забывает каждую сессию. Memex помнит навсегда.**

Локальный MCP-сервер, который индексирует **все ваши разговоры с AI** — Claude Code, Claude Cowork, Telegram-боты, ChatGPT-экспорты — в один FTS5-search и отдаёт их **любому MCP-совместимому AI-агенту** (Cursor, Cline, Claude Code, Continue, Zed) через 4 простых tool'а.

Никакого облака. Никакого аккаунта. Только твой ноут.

---

## Как это работает

```
~/.memex/inbox/   ← кладёшь сюда экспорты (или симлинк на Claude Code .jsonl)
   ↓ chokidar watcher
   ↓
parser (Telegram JSON / Claude Code JSONL — flat и nested)
   ↓
SQLite + FTS5 (~/.memex/data/memex.db)
   ↓
MCP server (stdio JSON-RPC)
   ↓
любой клиент → 4 tool'а:
   • memex_search          — full-text поиск
   • memex_recent          — последние N сообщений
   • memex_get_conversation — полный транскрипт чата
   • memex_list_sources    — что импортировано
```

Спроси своему агенту «помнишь как мы решили проблему с миграцией Postgres?» — он **сам** вызовет `memex_search`, найдёт релевантное и ответит с реальным контекстом.

---

## Установка за 3 минуты

```bash
git clone https://github.com/parallelclaw/memex-mvp.git
cd memex-mvp
bash install.sh
```

Скрипт создаст `~/.memex/{inbox,data}/`, поставит npm-зависимости, выведет пути для конфига Claude.

### Подключение к Claude Code

В `~/.claude/config.json` добавь:

```json
{
  "mcpServers": {
    "memex": {
      "command": "node",
      "args": ["/абсолютный/путь/до/memex-mvp/server.js"]
    }
  }
}
```

Перезапусти Claude Code. Готово — у тебя в session появятся `memex_*` tool'ы.

### Подключение к Cursor / Cline / Continue / Zed

Каждый клиент имеет свой `mcpServers` config (обычно в `~/.cursor/mcp.json`, `.cline/...`, и т.п.). Структура та же — `command: "node"`, `args: [путь к server.js]`.

---

## Что поддерживается

| Источник | Формат | Статус |
|----------|--------|--------|
| **Claude Code** | `*.jsonl` сессии | ✅ работает (nested + flat форматы) |
| **Claude Cowork** | `cowork-*.jsonl` (через filename prefix) | ✅ работает |
| **Telegram** | `result.json` из Desktop export | ✅ работает |
| ChatGPT export | будет в v0.2 | — |
| Obsidian vault | будет в v0.2 | — |

### Filename convention для Claude Code и Cowork

Парсер различает источники по префиксу:
- `code-*.jsonl` или произвольное имя → tagged как `claude-code`
- `cowork-*.jsonl` → tagged как `claude-cowork`

Это позволяет фильтровать `memex_search` по конкретной экосистеме.

### Совместимый feeder

[claude-backup](https://github.com/parallelclaw/claude-backup) — Python-CLI который автоматически находит ВСЕ твои Code+Cowork сессии и кидает чистые dialogue-only JSONL'ы прямо в memex inbox:

```bash
claude-backup feed-memex
# → симлинки/файлы появляются в ~/.memex/inbox/
# → memex chokidar подхватывает за ~1 секунду
# → готово
```

Это самый ленивый workflow. Один раз — и забыл.

---

## Telegram export

1. Telegram **Desktop** (mobile не умеет export)
2. Чат → меню → **Export chat history**
3. **Format: JSON** (не HTML)
4. **Path:** `~/.memex/inbox/`
5. Готово. Memex подхватит автоматически.

---

## Проверь что работает

В Claude Code/Cursor/Cline напиши:

```
Используй memex_list_sources — что у меня в локальной памяти?
```

Должен ответить чем-то вроде:

```
Total messages: 15021
Sources:
  • telegram     — 13640 messages, 3 chat(s)
  • claude-code  — 1381 messages, 16 chat(s)
```

Дальше пробуй настоящие запросы:

```
Помнишь как мы обсуждали бизнес-модели для арбитража?
Найди мою сессию про SberBusiness структуру.
Что было в апреле про создание YC-презентации?
```

Агент сам вызовет `memex_search`, отдаст реальные совпадения с conversation_id и timestamps.

---

## MCP tools

### `memex_search(query, limit?, source?)`
Full-text поиск через FTS5. Возвращает ranked сниппеты с `<<word>>` подсветкой. Опциональный фильтр по source.

### `memex_recent(limit?, source?)`
Последние N сообщений по timestamp.

### `memex_get_conversation(conversation_id, limit?)`
Полный transcript одного чата.

### `memex_list_sources()`
Метаданные: счётчики по источникам, последние импорты, путь к БД.

---

## Архитектура

```
memex-mvp/
├── server.js            ← MCP-server + parsers + chokidar watcher (~600 строк)
├── package.json         ← 3 dependencies (mcp-sdk, better-sqlite3, chokidar)
├── install.sh           ← создаёт ~/.memex/, npm install, печатает config
└── test/parser.test.js  ← unit-тесты парсера (13 кейсов)

~/.memex/
├── inbox/               ← drop-zone, chokidar watching
├── data/
│   ├── memex.db         ← SQLite с FTS5 (3 таблицы: messages, messages_fts, conversations)
│   ├── memex.log        ← server log
│   └── conversations/   ← обработанные оригиналы (telegram/, claude-code/)
```

### Schema

- `messages` — `(source, conversation_id, msg_id, role, sender, text, ts, metadata)` с UNIQUE на `(source, conversation_id, msg_id)` для дедупликации
- `messages_fts` — FTS5 виртуальная таблица, токенизатор `unicode61 remove_diacritics` (русский + английский, case-insensitive)
- `conversations` — агрегаты per-чат (first_ts, last_ts, message_count)

---

## Ограничения v0.1

- 🟡 Поиск keyword-based — нет semantic similarity. «арбитраж» найдёт «арбитраж», но не «монетизация трафика»
- 🟡 Manual import (кладёшь файл в inbox) — нет автоматического pull
- 🟡 Single-device — нет cross-machine sync
- 🟡 Plaintext SQLite — нет encryption-at-rest
- 🟡 ID-based dedupe только если у сообщений есть стабильный `id` (наш [claude-backup feed-memex](https://github.com/parallelclaw/claude-backup) генерирует sha1 hash)

Всё лечится в следующих версиях.

---

## Roadmap

- **v0.1** (сейчас) — Telegram + Claude Code + Claude Cowork, FTS5, dialogue-only фильтр noise'а
- **v0.2** — Semantic search через BGE-M3 + sqlite-vec; ChatGPT export; Obsidian vault
- **v0.3** — Cloud relay (zero-knowledge) для auto-pull с серверов
- **v0.4** — Multi-device sync (CRDT-based)
- **v1.0** — Personal embedding adapter, behavioral routing rules

---

## Companion projects

- **[claude-backup](https://github.com/parallelclaw/claude-backup)** — Python-CLI для экспорта Claude Code/Cowork сессий в Markdown, с командой `feed-memex` для интеграции

---

## Лицензия

MIT — делай что хочешь.
