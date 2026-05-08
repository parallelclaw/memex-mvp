# Multi-machine memex

> **TL;DR:** Полноценного распределённого sync'а с CRDT в memex пока нет — это в roadmap'е v0.4. До тех пор есть **три рабочих паттерна**, каждый со своими trade-off'ами. Выбирай по тому насколько тебе важна свежесть данных vs простота настройки.

## Почему это сложно

memex — это локальный SQLite-файл (`~/.memex/data/memex.db`) который активно пишется (auto-capture daemon, MCP-сервер при импорте inbox). Если **два экземпляра memex** на разных машинах одновременно пишут в **один и тот же** SQLite-файл через filesystem-sync (Syncthing/Dropbox/iCloud), почти гарантированный исход — повреждение БД. SQLite WAL-mode безопасен только когда все процессы видят одну файловую систему, не когда файл синкается «снаружи».

Поэтому ниже — паттерны которые **обходят** проблему конкурентной записи, не решают её.

---

## Паттерн A — Hub + read-replicas (рекомендуется)

**Идея:** одна машина «hub» — основная (например рабочий ноут). Только на ней крутится daemon и memex MCP-сервер. Остальные машины получают **read-only копию** БД через любой filesystem-sync.

**Как настроить:**

На hub-машине (рабочий ноут):
```bash
npx memex-sync install        # как обычно
```

Подключи Syncthing / iCloud Drive / Dropbox / OneDrive только к **папке `~/.memex/data/`**, не к `~/.memex/inbox/`:
```
Source on hub:    ~/.memex/data/         (read-write)
Target on B/C/…:  ~/.memex/data/         (read-only)
```

На read-replica машинах:
- НЕ запускай `memex-sync install` (иначе будет конкурентная запись)
- Подключи memex как обычный MCP-сервер в Claude Code config
- Доступ к памяти полный read-only — `memex_search`, `memex_get_conversation`, `memex_overview` все работают

**Плюсы:** простая настройка, single-writer гарантирован, не нужны custom-скрипты.

**Минусы:** read-replica eventually consistent (latency 5-30 секунд в зависимости от sync-провайдера). Если сидишь на ноутбуке-replica и одновременно ведёшь сессию Claude Code — она НЕ попадёт в memex пока ты не вернёшься к hub. Для большинства пользователей это OK.

**Гочи:**
- На read-replica добавь `&mode=ro` в путь к БД если возможно — снижает риск случайной записи
- Не запускай `npx memex-sync install` на replica — проверь через `npx memex-sync status` что daemon **не** установлен
- Если ты редактируешь конфиг через MCP (например `memex_archive_conversation`) на replica — изменение **не** залетит обратно на hub

---

## Паттерн B — Per-machine independent + shared archive

**Идея:** каждая машина ведёт свою memex.db самостоятельно (свой daemon, свой MCP). Синкается только **архив исходных файлов** (`~/.memex/data/conversations/`). Когда хочешь чтобы machine B увидела сессии с machine A — кладёшь файлы из архива в её inbox.

**Как настроить:**

На обеих машинах:
```bash
npx memex-sync install
```

Sync через Syncthing/iCloud только папки:
```
~/.memex/data/conversations/    (bi-directional)
```

Когда хочешь импортировать чужую активность на текущую машину:
```bash
# скопировать все накопленные с другой машины JSONL в свой inbox
cp ~/.memex/data/conversations/claude-code/*.jsonl ~/.memex/inbox/
cp ~/.memex/data/conversations/claude-cowork/*.jsonl ~/.memex/inbox/
```

memex inbox-watcher подберёт их за секунды, дедуп через UNIQUE(msg_id) отсечёт уже виденные сообщения.

**Плюсы:** обе машины полностью функциональны независимо. Никаких read-only ограничений.

**Минусы:** ручной шаг «принести историю с другой машины». Возможно автоматизировать через cron, но это уже custom.

**Гочи:**
- НЕ синкай `~/.memex/data/memex.db` — каждая машина имеет свой
- НЕ синкай `~/.memex/inbox/` — race с inbox-watcher
- Важно — у нас сейчас daemon процессит ингест **в архив автоматически после import**. Так что после первого ингеста на A, файл попадает в `data/conversations/`, Syncthing-копирует его на B. На B этот файл **уже** в архиве — не нужно повторно его инжектить.

---

## Паттерн C — Single-master через rsync (для CLI-power-users)

**Идея:** не используем непрерывный sync вообще. По требованию делаем `rsync` всего `~/.memex/` с одной машины на другую. Single-master, никаких race-условий.

**Как настроить:**

```bash
# Из B "забрать" свежее состояние с A
rsync -av --delete user@hostA:.memex/ ~/.memex/

# Не забудь остановить daemon на B перед rsync если он установлен:
launchctl unload ~/Library/LaunchAgents/com.parallelclaw.memex.sync.plist

# После rsync — снова запусти, но осторожно: 
# state-файл daemon'а тоже синкается, теперь B будет считать что уже видел все источники A
```

**Плюсы:** простой mental model, никаких длительных процессов sync, явный контроль когда происходит обмен.

**Минусы:** ручной запуск, потенциальная проблема с offset state daemon'а (если на B раньше был свой daemon — его state перезаписывается).

---

## Сравнительная таблица

| | Паттерн A (Hub+replicas) | Паттерн B (Per-machine) | Паттерн C (rsync) |
|---|---|---|---|
| Свежесть данных | 5-30 сек lag | сразу после copy | по нажатию |
| Сложность настройки | низкая | средняя | низкая |
| Риск повреждения БД | нулевой (single-writer) | нулевой (отдельные БД) | нулевой |
| Работает offline | ✅ | ✅ | ✅ |
| Запись с любой машины | ❌ | ✅ | ❌ (single-master) |
| Custom-скрипты нужны | ❌ | да (cp в inbox) | да (rsync wrapper) |

---

## Что сделать **нельзя** (общие грабли)

- ❌ **Синкать `~/.memex/data/memex.db` между двумя машинами с активным daemon'ом** — гарантированное повреждение БД через несколько часов
- ❌ **Синкать `~/.memex/inbox/`** — chokidar-watcher на одной машине может удалить файл из inbox раньше чем sync долетит до второй, второй машина потеряет данные
- ❌ **Хранить БД на сетевой ФС (NFS/SMB) и работать с ней с двух машин одновременно** — SQLite WAL не дружит с network FS

---

## Что в roadmap

**v0.4 — Multi-device sync через CRDT.** Каждая машина хранит локальную копию + change-log. Синхронизация через любой transport (cloud relay, peer-to-peer, USB). Конфликтное состояние невозможно by-design. Это нетривиальная инженерная задача (~3-4 недели), но она в плане.

До v0.4 — пользуйся паттернами выше. Для большинства pro-юзеров **Паттерн A (Hub + read-replicas)** покрывает 90% потребностей.

---

## Помощь

Если у тебя нестандартный setup и непонятно как лучше — открой [issue](https://github.com/parallelclaw/memex-mvp/issues) с описанием:
- сколько у тебя машин
- какой sync-провайдер ты уже используешь (Syncthing / iCloud / git-annex / etc.)
- ОС каждой машины
- хочешь ли write-доступ с каждой или только с одной

Подскажем какой паттерн оптимален.
