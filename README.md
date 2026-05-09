# memex-mvp · your AI's missing memory

> **Claude забывает каждую сессию. Memex помнит навсегда.**

Локальный MCP-сервер, который индексирует **все ваши разговоры с AI** — Claude Code, Claude Cowork, Telegram-боты, ChatGPT-экспорты — в один FTS5-search и отдаёт их **любому MCP-совместимому AI-агенту** (Cursor, Cline, Claude Code, Continue, Zed) через 8 простых tool'ов.

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
любой клиент → 8 tool'ов:
   • memex_overview              — снэпшот корпуса + статус auto-capture
   • memex_search                — full-text поиск (с дедупом по чатам)
   • memex_recent                — последние N сообщений
   • memex_list_conversations    — список чатов по recency
   • memex_get_conversation      — полный транскрипт чата
   • memex_archive_conversation  — скрыть чат из выдачи (но не из поиска)
   • memex_status                — здоровье memex-sync daemon'а
   • memex_list_sources          — что импортировано
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
| **Claude Code** | `*.jsonl` сессии в `~/.claude/projects/` | ✅ работает (nested + flat форматы) |
| **Claude Cowork** | `cowork-*.jsonl` (через filename prefix), включая subagents | ✅ работает |
| **Cursor IDE** (Composer + Chat) | SQLite `state.vscdb` в `~/Library/Application Support/Cursor/` | ✅ работает (poll каждые 5 мин) |
| **Telegram** | `result.json` из Desktop export | ✅ работает |
| Claude.ai web export | будет в v0.2 | — |
| ChatGPT export | будет в v0.2 | — |
| Obsidian vault | будет в v0.2 | — |

### Filename convention для inbox-файлов

Парсер различает источники по префиксу имени файла в inbox:
- `code-*.jsonl` или произвольное имя → tagged как `claude-code`
- `cowork-*.jsonl` → tagged как `claude-cowork`
- `cursor-*.jsonl` → tagged как `cursor`

Это позволяет фильтровать `memex_search` по конкретной экосистеме (`source: "cursor"` и т.д.).

### Cursor IDE source — особый случай

Cursor хранит историю в SQLite (`state.vscdb`), не в JSONL-файлах. memex-sync daemon **поллит** эту БД каждые 5 минут (FSEvents бессмысленно — Cursor пишет в WAL практически на каждый keystroke). При обнаружении composer'а с обновлённым `lastUpdatedAt` daemon экспортит его dialogue (без thinking-bubbles и tool-call'ов) в inbox как `cursor-<short>.jsonl`. Заголовок берётся из `composerData.name` напрямую.

Поддерживаемые ОС для Cursor: macOS, Linux, Windows (пути в `lib/parse-cursor.js`).

### Bulk import за одну команду

memex полностью самодостаточен — не нужен Python, не нужны внешние CLI:

```bash
npx memex-sync scan          # Claude Code + Cowork + Cursor сразу
npx memex-sync scan-claude   # только Claude Code + Cowork
npx memex-sync scan-cursor   # только Cursor
```

Сканирует все источники один раз, эмитит JSONL в inbox, выходит. Идемпотентен — повторный запуск пропускает неизменённые файлы через state-cache. Удобно для cron, manual-первого-импорта, или дебага без daemon'а.

### Two pieces

memex поставляется в виде **двух независимых частей:**

- **MCP server** (`server.js`) — пассивная база знаний, всегда доступна после `npm install`. Отдаёт 8 tool'ов любому MCP-агенту.
- **memex-sync** (`ingest.js`) — **опциональный** фоновый daemon. Watch'ит `~/.claude/projects/` (Code) и `~/Library/Application Support/Claude/local-agent-mode-sessions/` (Cowork) через FSEvents и автоматически добавляет новые сессии в память в реальном времени.

> **Без memex-sync память замёрзла** на момент последнего ручного импорта. **С ним** — каждая новая сессия становится searchable за ~1.5 секунды.

### Включить auto-capture (memex-sync)

Одна команда — и dameon регистрируется как macOS LaunchAgent, автозапускается при логине, переживает перезагрузку и крэши:

```bash
npx memex-sync install
```

Дальше:

```bash
npx memex-sync status      # три состояния: installed / running / watching
npx memex-sync logs        # tail -f лог в реальном времени
npx memex-sync uninstall   # снять с автозапуска (БД остаётся)
```

Без `install` daemon можно гонять и в foreground'е (для отладки):

```bash
npx memex-sync             # = serve, в foreground
```

### Что под капотом

- chokidar (FSEvents на macOS, inotify на Linux) на обе source-директории
- Per-file state в `~/.memex/data/ingest-state.json` (sha1 первых 256B + size + mtime) — повторный запуск пропускает неизменённые файлы
- Safety rescan каждые 30 минут — ловит пропущенные FSEvents после sleep/lid-close
- Atomic writes (temp + rename) в `~/.memex/inbox/` — никаких частичных JSONL
- Idempotent: новые сообщения идут через UNIQUE(msg_id), дубли отсекаются на уровне БД
- LaunchAgent работает с `LowPriorityIO=true`, `Nice=5` — не мешает основной работе ноута

memex MCP server и memex-sync — два независимых процесса. MCP server отвечает агентам, memex-sync кормит inbox. Связи нет, кроме общей файловой системы.

### Подсказка для агента

Если ты подключил memex к Claude Code/Cursor/Cline и каждый раз когда вызываешь `memex_overview` видишь сверху ⚪ или 🔴 — это значит auto-capture не включён. Агент сам это увидит и предложит юзеру команду `npx memex-sync install`. Это та самая «один раз и забыл» механика — без README-чтения.

### Несколько машин

Если ты пользуешься memex'ом с двух+ ноутов — см. [MULTI_MACHINE.md](MULTI_MACHINE.md). Там 3 рабочих паттерна синхронизации (Hub + read-replicas / Per-machine independent / rsync), их trade-off'ы, и грабли которых стоит избегать (например — нельзя синкать `memex.db` между машинами с активным daemon'ом). Полноценный CRDT-sync — в roadmap'е v0.4.

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

> **Все tool'ы поддерживают параметр `format: "markdown" | "json"`** (дефолт `"markdown"`).
> Markdown — для глаз, JSON — для агентов: меньше токенов, можно парсить поля напрямую.

> **Server-side instructions для агентов.** В MCP `initialize`-ответе сервер отдаёт ~3 КБ системного контекста: что хранится, какой tool когда выбирать, FTS5-синтаксис, известные ограничения. Любой подключающийся агент (Claude Code, Cursor, Cline, Continue) получает это автоматически — отдельную инструкцию писать не нужно. Текст в `SERVER_INSTRUCTIONS` в [server.js](server.js).

### `memex_overview(recent_limit?, format?)`
Снэпшот корпуса одним вызовом — для ориентации в начале сессии. Возвращает: общее число сообщений, breakdown по источникам (telegram / claude-code / claude-cowork), date range, и последние N разговоров с заголовками. Этот call даёт агенту mental map за ~500 токенов и резко повышает качество последующих `memex_search` запросов (т.к. агент уже знает что у пользователя в памяти есть, а чего нет). Server-side instructions явно рекомендуют вызывать его первым шагом в новой сессии.

### `memex_search(query, limit?, source?, group_by_conversation?, include_archived?, format?)`
Full-text поиск через FTS5. Возвращает ranked сниппеты с `<<word>>` подсветкой. Опциональный фильтр по source.

**По умолчанию `group_by_conversation: true`** — возвращает один лучший хит на каждый conversation_id плюс `match_count` (сколько всего совпадений в этом чате). Это убирает шум, когда один длинный диалог занимает всю выдачу одинаковыми кусками. Передай `false` чтобы получить классический список всех совпадений.

Архивные чаты по умолчанию исключены из выдачи; передай `include_archived: true` чтобы искать везде.

### `memex_recent(limit?, source?, include_archived?, format?)`
Последние N сообщений по timestamp.

### `memex_list_conversations(limit?, source?, since_ts?, include_archived?, format?)`
Список чатов отсортированных по последней активности (most recent first). Каждая запись — `conversation_id`, источник, заголовок, диапазон дат и кол-во сообщений. Удобно, когда хочется быстро увидеть какие у тебя вообще разговоры с конкретным ботом или внутри одного источника, прежде чем вытаскивать полный транскрипт.

Архивные чаты скрыты по дефолту, помечены 🗄️ если включены через `include_archived: true`.

### `memex_get_conversation(conversation_id, limit?, format?)`
Полный transcript одного чата.

### `memex_archive_conversation(conversation_id, archive?)`
Заархивировать (или восстановить) чат. Архивный чат остаётся в индексе и доступен для поиска через `include_archived: true`, но не засоряет дефолтную выдачу `memex_list_conversations` / `memex_search`. Передай `archive: false` чтобы расколоть.

### `memex_list_sources(format?)`
Метаданные: счётчики по источникам, последние импорты, путь к БД, число архивных чатов.

---

## Архитектура

```
memex-mvp/
├── server.js            ← MCP-server + parsers + chokidar inbox watcher
├── ingest.js            ← optional daemon: live-tail Code/Cowork → inbox
├── lib/parse.js         ← shared dialogue parser (used by both)
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
- 🟡 ID-based dedupe требует стабильного `id` у сообщений; memex-sync (и claude-backup feed-memex для совместимости) генерируют sha1-hash из `role|timestamp|text[:200]` для гарантии

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

- **[claude-backup](https://github.com/parallelclaw/claude-backup)** — отдельный Python-CLI для экспорта Claude Code/Cowork сессий **в Markdown** (для backup'а, чтения вне memex, sharing). **Не нужен для memex** — `npx memex-sync scan-claude` импортирует ту же историю напрямую без Python. Используй claude-backup если хочется именно Markdown-файлы как side-effect.

---

## Лицензия

MIT — делай что хочешь.
