# memex-mvp · your AI's missing memory

> [English](README.md) · **Русский**

[![npm](https://img.shields.io/npm/v/memex-mvp.svg)](https://www.npmjs.com/package/memex-mvp)
[![downloads](https://img.shields.io/npm/dw/memex-mvp.svg)](https://www.npmjs.com/package/memex-mvp)
[![license](https://img.shields.io/npm/l/memex-mvp.svg)](LICENSE)

> **Единое хранилище для всех твоих AI и Telegram чатов.**

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

## Requirements / Требования

### Обязательное (без этого memex не запустится)

- **Node.js 20.x – 24.x** (рекомендуется **22 LTS**). В репо есть `.nvmrc` со значением `22` — если у тебя `nvm`, выполни `nvm use` в директории проекта.
- **macOS 12+ или Linux** с inotify (Windows — только через WSL).
- **Xcode Command Line Tools** на macOS (`xcode-select --install`) — нужны для нативной сборки `better-sqlite3`, если для твоей Node-версии нет prebuilt binaries.
- **MCP-совместимый AI-клиент** для использования: Claude Code, Cursor, Cline, Continue, Zed или любой другой клиент с поддержкой MCP. Без этого memex стрит индекс, но обращаться к нему будет некому.

### Опциональное (по ситуации)

- **Telegram Desktop** — если хочешь индексировать TG-чаты. Мобильное приложение Telegram **не умеет** экспорт; нужен именно Desktop-клиент.
- **iCloud Drive / Syncthing** — если хочешь sync БД между несколькими своими ноутами.
- **Ollama / llama.cpp** — на будущее для локального LLM-extraction слоя (профильные факты). Сейчас в roadmap'е.

### Аппаратные требования (small)

- **Disk space:** ~5-30 МБ типичный корпус за год. Большие Telegram-экспорты с медиа — отдельно, до сотен МБ.
- **RAM:** daemon ~30 МБ, MCP-сервер ~50 МБ. Незаметно.
- **CPU:** на холостом ходу < 1%. Импорт сессии — миллисекунды.

### Известные ограничения

| Что **не** работает | Почему |
|---|---|
| ❌ Web-only AI (ChatGPT в браузере, Claude.ai web) | Эти сессии живут на серверах вендора, на твоём диске их нет |
| ❌ Мобильные AI-приложения (ChatGPT iOS, Claude Android) | Phone-data не пишется на твой компьютер |
| ❌ Сессии на VPS / в облаке | Memex читает локальную файловую систему |
| ❌ Windows напрямую | Только через WSL (chokidar на Win работает плохо без inotify-shim) |
| ❌ Auto-capture daemon на Linux | `npx memex-sync install` работает только на macOS (LaunchAgent). На Linux запускай daemon в foreground или сделай свой systemd unit |
| ❌ Mobile capture сегодня | В roadmap'е — Telegram-бот в `bot/` директории |

### Положительное «ограничение»

✅ **Internet не нужен.** Memex после установки работает полностью офлайн. Никаких phone-home, никаких API-ключей, никаких облачных зависимостей. Это feature, не bug.

> ⚠ **Node 25+ известная проблема.** На bleeding-edge Node (25.x) `better-sqlite3` ещё не имеет prebuilt binaries — fallback на компиляцию из исходников падает на macOS с `fatal error: 'climits' file not found`. Решение: `nvm install 22 && nvm use 22`, потом `npm install`.

---

## Установка за 60 секунд

```bash
npm install -g memex-mvp
memex-sync install      # macOS LaunchAgent для auto-capture
```

Если `npm install -g` упирается в `EACCES` (системный Node на macOS) — два пути:

```bash
# A. Один раз — починить prefix, чтоб больше не страдать:
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc
source ~/.zshrc

# B. Или просто разово через sudo:
sudo npm install -g memex-mvp
```

**Альтернатива без global install** — `npx memex-mvp install` ставит всё во временный кэш, ничего глобально не оставляет.

После установки `memex-sync install` поднимет фоновый daemon (`~/.memex/{inbox,data}/` создадутся автоматически при первом запуске).

### Установка через AI-скилл (Claude Code / OpenClaw)

Если хочешь чтобы агент сам всё сделал — закинь [install-memex skill](skills/install-memex/) в `~/.claude/skills/`:

```bash
mkdir -p ~/.claude/skills
curl -fsSL https://raw.githubusercontent.com/parallelclaw/memex-mvp/main/skills/install-memex/SKILL.md \
  -o ~/.claude/skills/install-memex/SKILL.md
```

Затем в Claude Code (или любом Skills-aware агенте) скажи:

> установи memex

…или `/install-memex`. Агент сам сделает `npm install`, пропишет MCP-config, поднимет daemon и проверит что всё работает — ~2 минуты.

### Подключение к Claude Code

Сначала возьми **два абсолютных пути** в терминале:

```bash
pwd         # → путь до memex-mvp (из директории memex-mvp)
which node  # → путь до бинарника node (например /Users/you/.nvm/versions/node/v24.15.0/bin/node)
```

В `~/.claude/config.json` добавь, подставив оба пути:

```json
{
  "mcpServers": {
    "memex": {
      "command": "/абсолютный/путь/до/node",
      "args": ["/абсолютный/путь/до/memex-mvp/server.js"]
    }
  }
}
```

**Почему абсолютный путь к node, а не просто `"node"`?** GUI-приложения (Cursor, Cline VS Code, Claude Desktop) на macOS часто **не наследуют PATH из shell'a** (`~/.zshrc`). С `"command": "node"` MCP-сервер падает с `spawn node ENOENT` — особенно если node поставлен через nvm. Всегда используй путь из `which node`.

Перезапусти Claude Code. Готово — у тебя в session появятся `memex_*` tool'ы.

### Подключение к Cursor / Cline / Continue / Zed

Каждый клиент имеет свой `mcpServers` config (обычно в `~/.cursor/mcp.json`, `.cline/...`, и т.п.). Структура та же — `command` = абсолютный путь до node, `args` = `[путь к server.js]`. Та же ENOENT-проблема актуальна для всех GUI-MCP клиентов.

---

## Что поддерживается

| Источник | Формат | Статус |
|----------|--------|--------|
| **Claude Code** | `*.jsonl` сессии в `~/.claude/projects/` | ✅ работает (nested + flat форматы) |
| **Claude Cowork** | `cowork-*.jsonl` (через filename prefix), включая subagents | ✅ работает |
| **Cursor IDE** (Composer + Chat) | SQLite `state.vscdb` в `~/Library/Application Support/Cursor/` | ✅ работает (poll каждые 5 мин) |
| **Obsidian** vault notes | `.md` файлы + YAML frontmatter | ✅ работает (FSEvents, hash-based dedupe) |
| **Telegram** | `result.json` из Desktop export | ✅ работает |
| Claude.ai web export | будет в v0.3 | — |
| ChatGPT export | будет в v0.3 | — |
| Apple Notes | будет в v0.3 | — |

### Filename convention для inbox-файлов

Парсер различает источники по префиксу имени файла в inbox:
- `code-*.jsonl` или произвольное имя → tagged как `claude-code`
- `cowork-*.jsonl` → tagged как `claude-cowork`
- `cursor-*.jsonl` → tagged как `cursor`
- `obsidian-*.jsonl` → tagged как `obsidian`

Это позволяет фильтровать `memex_search` по конкретной экосистеме (`source: "cursor"`, `source: "obsidian"` и т.д.).

### Cursor IDE source — особый случай

Cursor хранит историю в SQLite (`state.vscdb`), не в JSONL-файлах. memex-sync daemon **поллит** эту БД каждые 5 минут (FSEvents бессмысленно — Cursor пишет в WAL практически на каждый keystroke). При обнаружении composer'а с обновлённым `lastUpdatedAt` daemon экспортит его dialogue (без thinking-bubbles и tool-call'ов) в inbox как `cursor-<short>.jsonl`. Заголовок берётся из `composerData.name` напрямую.

Поддерживаемые ОС для Cursor: macOS, Linux, Windows (пути в `lib/parse-cursor.js`).

### Obsidian source — заметки как первоклассные сущности

memex автоматически находит Obsidian-vault'ы в стандартных местах (`~/Documents/`, `~/Obsidian/`, `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/` для iCloud-синка). Vault — это любая папка с `.obsidian/` подпапкой внутри. Можно явно указать пути через env-переменную:

```bash
export MEMEX_OBSIDIAN_VAULTS=/path/to/vault1,/path/to/vault2
```

Каждая `.md` нота → одна conversation в memex. Title берётся из `title:` frontmatter → первого `# H1` → имени файла. YAML frontmatter парсится для метаданных (дат, тегов). Body индексируется в FTS5 как один user-сообщение.

**Privacy**:
- Обнаружение vault'ов opt-in (только стандартные пути; кастомные через env var)
- Игнорируются: `.obsidian/`, `.trash/`, `.git/`, `.DS_Store`, `*.sync-conflict-*`
- Per-note opt-out через frontmatter `memex: false`
- Hash-based dedupe — пишем в inbox только когда содержание реально изменилось, не на каждый mtime-touch

### Bulk import за одну команду

memex полностью самодостаточен — не нужен Python, не нужны внешние CLI:

```bash
npx memex-sync scan            # Claude Code + Cowork + Cursor + Obsidian сразу
npx memex-sync scan-claude     # только Claude Code + Cowork
npx memex-sync scan-cursor     # только Cursor
npx memex-sync scan-obsidian   # только Obsidian vault(s)
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

### Управление источниками

По умолчанию memex-sync **собирает всё что находит** на машине: Claude Code, Cowork, Cursor, Obsidian (auto-detect). Это удобно для quick-start, но любой источник можно отключить через CLI без удаления daemon'а:

```bash
npx memex-sync sources                       # показать что сейчас включено
npx memex-sync sources cursor disable        # выключить cursor
npx memex-sync sources cursor enable         # вернуть
npx memex-sync vault add /path/to/MyVault    # явный список Obsidian-vault'ов
npx memex-sync vault remove /path            # убрать
npx memex-sync restart                       # применить изменения
```

Конфиг живёт в `~/.memex/config.json`. Файла нет → сборка по дефолту. Как только что-то изменено через CLI — файл создаётся, daemon его уважает.

Privacy: agent через `memex_sources_status` сам показывает что именно отслеживается, и **никогда не выключает источники сам** — это всегда команда от пользователя.

### Подсказка для агента

Если ты подключил memex к Claude Code/Cursor/Cline и каждый раз когда вызываешь `memex_overview` видишь сверху ⚪ или 🔴 — это значит auto-capture не включён. Агент сам это увидит и предложит юзеру команду `npx memex-sync install`. Это та самая «один раз и забыл» механика — без README-чтения.

---

## Между устройствами / Across devices

### По-русски

Memex живёт на одной машине: daemon ловит локальные файлы, SQLite строится локально, MCP отдаёт локально.

Три паттерна для multi-device сегодня:

1. **Синк SQLite-файла.** `~/.memex/data/memex.db` — обычный файл. Реплицируй через iCloud / Syncthing / rsync / git-annex. Daemon пишет на основной машине; остальные читают тот же файл через свой локальный memex MCP-сервер. Один writer, много readers.
2. **Memex на каждом устройстве независимо.** Установи memex отдельно на каждый ноут. Каждый строит свой корпус. Нет синка, нет конфликтов — но память не унифицирована.
3. **Mobile через Telegram-бот** *(в roadmap'е, код написан в `bot/`).* Пересылаешь сообщения в @memex_bot с телефона → бот пишет JSON в `~/.memex/inbox/` основной машины → индексируется автоматически.

**iCloud setup на macOS:**
```bash
# Option A — symlink ~/.memex/data в iCloud Drive
mv ~/.memex/data ~/Library/Mobile\ Documents/com~apple~CloudDocs/memex/data
ln -s ~/Library/Mobile\ Documents/com~apple~CloudDocs/memex/data ~/.memex/data

# Option B — указать memex'у на iCloud-путь через env var
export MEMEX_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/memex"
```

⚠ **Только один writer.** Auto-capture daemon (`memex-sync`) запускай ровно на одной машине. Остальные устройства читают синхронизированный файл через свой локальный memex MCP-сервер — на них daemon не запускай. Параллельные writer'ы через filesystem sync могут корраптнуть WAL.

Подробнее — 3 паттерна с примерами для Syncthing/rsync — в [MULTI_MACHINE.md](MULTI_MACHINE.md).

### In English

Memex lives on one machine: daemon catches local files, SQLite builds locally, MCP serves locally.

Three patterns for multi-device today:

1. **Sync the SQLite file.** `~/.memex/data/memex.db` is a regular file. Replicate via iCloud / Syncthing / rsync / git-annex. Daemon writes on your primary machine; other machines read the same file through their local memex MCP server. One writer, many readers.
2. **Memex on each device independently.** Install memex separately on each laptop. Each builds its own corpus. No sync, no conflicts — but memory isn't unified.
3. **Mobile via Telegram bot** *(roadmap, code drafted in `bot/`).* Forward messages or write thoughts to @memex_bot from your phone → bot writes JSON to `~/.memex/inbox/` on your primary machine → indexed automatically.

iCloud setup on macOS: same commands as in the Russian section above (paths are language-agnostic).

⚠ **One writer only.** Run the auto-capture daemon (`memex-sync`) on exactly one machine. Other devices read the synced file through their local memex MCP server — they should not run the daemon on the same shared DB. Concurrent writers via filesystem sync can corrupt the WAL.

For 3 detailed patterns with Syncthing/rsync examples — see [MULTI_MACHINE.md](MULTI_MACHINE.md).

---

## Миграция между устройствами / One-time migration

> **Не то же самое что sync.** Это **разовый перенос** всей истории со старого ноута на новый — например при покупке нового мака. Sync — это паттерн в секции «Между устройствами» выше, когда два ноута постоянно делят одну БД через iCloud / Syncthing.

### По-русски

memex.db — обычный SQLite-файл, переезжает как любой документ.

**На старом ноуте:**

```bash
# 1. Останови daemon чтобы не было активной записи
launchctl unload ~/Library/LaunchAgents/com.parallelclaw.memex.sync.plist 2>/dev/null

# 2. Сверни WAL в основной файл (чтобы не потерять свежие записи)
sqlite3 ~/.memex/data/memex.db "PRAGMA wal_checkpoint(TRUNCATE)"

# 3. Скопируй ОДИН файл (AirDrop / scp / iCloud / external USB)
cp ~/.memex/data/memex.db ~/Desktop/memex-backup.db
```

⚠ Копируй **только `memex.db`** — НЕ копируй `memex.db-wal`, `memex.db-shm` (временные, после checkpoint'a не нужны) и НЕ копируй `~/.memex/data/ingest-state.json` (machine-specific — там пути и fingerprint'ы старого ноута).

**На новом ноуте:**

```bash
# 1. Установи memex как при первой установке
git clone https://github.com/parallelclaw/memex-mvp
cd memex-mvp && npm install

# 2. Положи DB-файл
mkdir -p ~/.memex/data
cp /path/to/memex-backup.db ~/.memex/data/memex.db

# 3. Пропиши MCP-конфиг с абсолютным путём к node (см. секцию "Подключение к Claude Code")

# 4. Перезапусти Cursor / Claude Code и вызови memex_overview
```

**Что переедет:** все разговоры, FTS5-индекс, Telegram-экспорты, conversation IDs. Поиск работает сразу.

**Что НЕ переедет автоматически:**
- Новые Claude Code / Cursor сессии нового ноута — это уже файлы нового ноута. Решение: `npx memex-sync install` на новом — daemon начнёт ловить новые сессии и добавлять их в ту же БД.
- `project_path` в существующих записях содержит **старые пути** (`/Users/oldname/...`). Memex не сломается, но `memex_list_projects` покажет старые пути. При необходимости — `UPDATE conversations SET project_path = REPLACE(...)` руками.

### In English

memex.db is a regular SQLite file — moves like any document.

**On the old laptop:**

```bash
# 1. Stop the daemon to prevent active writes
launchctl unload ~/Library/LaunchAgents/com.parallelclaw.memex.sync.plist 2>/dev/null

# 2. Checkpoint the WAL into the main file (don't lose recent writes)
sqlite3 ~/.memex/data/memex.db "PRAGMA wal_checkpoint(TRUNCATE)"

# 3. Copy ONE file (AirDrop / scp / iCloud / external USB)
cp ~/.memex/data/memex.db ~/Desktop/memex-backup.db
```

⚠ Copy **only `memex.db`** — do NOT copy `memex.db-wal`, `memex.db-shm` (transient, unneeded after checkpoint), and do NOT copy `~/.memex/data/ingest-state.json` (machine-specific — it contains paths and fingerprints from the old laptop).

**On the new laptop:**

```bash
# 1. Install memex like a first-time install
git clone https://github.com/parallelclaw/memex-mvp
cd memex-mvp && npm install

# 2. Place the DB file
mkdir -p ~/.memex/data
cp /path/to/memex-backup.db ~/.memex/data/memex.db

# 3. Wire MCP config with absolute path to node (see "Connecting to Claude Code" above)

# 4. Restart Cursor / Claude Code and call memex_overview
```

**What transfers:** all conversations, FTS5 index, Telegram exports, conversation IDs. Search works immediately.

**What does NOT auto-transfer:**
- New Claude Code / Cursor sessions on the new laptop — those are new files on the new machine. Solution: run `npx memex-sync install` on the new laptop — the daemon will start catching new sessions and adding them to the same DB.
- `project_path` in existing rows still contains **old paths** (`/Users/oldname/...`). Memex won't break, but `memex_list_projects` will show old paths. If needed — `UPDATE conversations SET project_path = REPLACE(...)` manually.

---

## Приватность и безопасность / Privacy & Security

### По-русски

Один файл со всеми твоими AI-разговорами — звучит страшнее, чем есть.

✅ **Что memex делает:** Живёт только на твоей машине, никуда не звонит, без API-ключей, без network access. OS-level права на файлы — читает только твой user.

❌ **Что не делает:** Не шифрует БД, не редактирует секреты которые ты вставлял в чаты с AI, нет пароля на сам memex.

📦 **Не добавляет риск — концентрирует.** Твоя AI-история **уже** на диске в plain text — Claude Code JSONL, Cursor `state.vscdb`, Cowork session files, Obsidian `.md`, Telegram local DB. Memex консолидирует их в один SQLite-файл. Те же данные, в одном месте вместо пяти. Attack surface не растёт — растёт видимость.

🛡️ **Топ-рекомендация: FileVault.** На macOS: `System Settings → Privacy & Security → FileVault → Turn On`. Шифрует весь диск AES-256 на уровне OS. Без твоего пароля диск нечитаем — закрывает ~80% реалистичных угроз (украденный ноут, кража backup, malware без root). На Linux то же делает LUKS. Сделай это **прежде** чем волноваться про app-level шифрование.

### In English

One file with all your AI conversations — sounds scarier than it is.

✅ **What memex does:** Lives only on your machine, never phones home, no API keys, no network access. OS-level file permissions — readable only by your user.

❌ **What it doesn't:** Doesn't encrypt the DB file, doesn't redact secrets you pasted into AI chats, no password on memex itself.

📦 **Doesn't add risk — concentrates it.** Your AI history is **already** on disk in plain text — Claude Code JSONL, Cursor `state.vscdb`, Cowork session files, Obsidian `.md`, Telegram local DB. Memex consolidates them into one SQLite file. Same data, one place instead of five. Attack surface doesn't grow — visibility does.

🛡️ **Top recommendation: FileVault.** On macOS: `System Settings → Privacy & Security → FileVault → Turn On`. Encrypts the entire disk with AES-256 at the OS level. Without your password, the disk is unreadable — closes ~80% of realistic threats (stolen laptop, stolen backup, non-root malware). On Linux: LUKS does the same. Do this **before** worrying about app-level encryption.

---

## Telegram export

1. Telegram **Desktop** (mobile не умеет export)
2. Чат → меню → **Export chat history**
3. **Format: JSON** (не HTML)
4. **Path:** `~/.memex/inbox/`
5. Готово. Memex подхватит автоматически.

---

## Как использовать на практике / How to actually use it

Полный guide с **6 типовыми use case'ами** (Telegram → action plan, cross-AI bridge, recall, project resume, patterns, deck-анализ), описанием всех MCP-tools и troubleshooting — в [HELP.md](HELP.md). Скопируй любой промпт из этого файла → вставь в свой AI-агент → попробуй сразу после установки.

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
