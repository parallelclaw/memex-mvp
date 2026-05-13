/**
 * Bot config loader. Reads ~/.memex/bot.config.json (or $MEMEX_DIR/bot.config.json).
 *
 * Required:   telegram_bot_token, allowlist_user_ids[]
 * Optional:   nexara_api_key, voice_enabled, inbox_path, media_path, db_path
 *
 * Voice support is auto-disabled if no nexara_api_key is set, regardless of
 * the voice_enabled flag.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
export const BOT_CONFIG_PATH = join(MEMEX_DIR, 'bot.config.json');

const EXAMPLE = `{
  "telegram_bot_token": "<get from @BotFather>",
  "allowlist_user_ids": [<your numeric Telegram user_id — get from @userinfobot>],
  "voice_enabled": true,
  "nexara_api_key": "nx-..."
}`;

export function loadBotConfig() {
  if (!existsSync(BOT_CONFIG_PATH)) {
    const err = new Error(
      `bot config not found at ${BOT_CONFIG_PATH}\n\n` +
      `Create it with:\n  ${BOT_CONFIG_PATH}\n\n` +
      `Example contents:\n${EXAMPLE}`
    );
    err.code = 'NO_CONFIG';
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(BOT_CONFIG_PATH, 'utf-8'));
  } catch (e) {
    throw new Error(`failed to parse ${BOT_CONFIG_PATH}: ${e.message}`);
  }

  if (!parsed.telegram_bot_token || typeof parsed.telegram_bot_token !== 'string') {
    throw new Error('bot.config.json: telegram_bot_token (string) is required');
  }
  if (!Array.isArray(parsed.allowlist_user_ids) || parsed.allowlist_user_ids.length === 0) {
    throw new Error('bot.config.json: allowlist_user_ids[] (numeric TG user id(s)) is required');
  }

  const allowlist = parsed.allowlist_user_ids.map((x) => Number(x));
  if (allowlist.some((x) => !Number.isFinite(x))) {
    throw new Error('bot.config.json: allowlist_user_ids must be numbers');
  }

  const nexaraKey = parsed.nexara_api_key || null;
  return {
    telegram_bot_token: parsed.telegram_bot_token,
    allowlist_user_ids: allowlist,
    nexara_api_key: nexaraKey,
    voice_enabled: parsed.voice_enabled !== false && !!nexaraKey,
    inbox_path: parsed.inbox_path || join(MEMEX_DIR, 'inbox'),
    media_path: parsed.media_path || join(MEMEX_DIR, 'data', 'conversations', 'telegram', 'media'),
    db_path: parsed.db_path || join(MEMEX_DIR, 'data', 'memex.db'),
    state_path: parsed.state_path || join(MEMEX_DIR, 'data', 'bot-state.json'),
  };
}
