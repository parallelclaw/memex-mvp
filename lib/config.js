/**
 * memex configuration: ~/.memex/config.json
 *
 * Schema:
 *   {
 *     sources: {
 *       claude_code:   true | false,
 *       claude_cowork: true | false,
 *       cursor:        true | false,
 *       obsidian: true | false | { enabled: bool, vaults: string[] }
 *     }
 *   }
 *
 * Behavior:
 *   - File missing → defaults below (everything ON if its data exists). Preserves
 *     backward compat for users who installed before config was a thing.
 *   - File present but partial → merged with defaults.
 *   - Env var MEMEX_OBSIDIAN_VAULTS overrides config.sources.obsidian.vaults
 *     (useful for cron/scripts without touching the file).
 *
 * CLI source names accept both "claude-code" and "claude_code" forms;
 * normalizeSourceName() canonicalises to underscore (matches JSON keys).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const HOME = homedir();
const MEMEX_DIR = process.env.MEMEX_DIR || join(HOME, '.memex');
export const CONFIG_PATH = join(MEMEX_DIR, 'config.json');

export const KNOWN_SOURCES = ['claude_code', 'claude_cowork', 'cursor', 'obsidian', 'openclaw'];

/** What the daemon does when no config file exists — preserve current behavior. */
export const DEFAULT_CONFIG = Object.freeze({
  sources: {
    claude_code: true,
    claude_cowork: true,
    cursor: true,
    obsidian: { enabled: true, vaults: [] }, // empty vaults → autodetect
    openclaw: true, // v0.10.14+: auto-capture from ~/.openclaw/agents/main/sessions/
  },
  search: {
    // Half-life in days for the temporal recency boost in memex_search.
    // Score = bm25 * exp(-age_days / half_life). 30d ≈ recent week dominates,
    // month-old halved, 3-month-old in long tail. Set to 0 to disable.
    half_life_days: 30,
  },
});

/** Returns the configured default half-life (days) for recency boost. 0 disables. */
export function getSearchHalfLifeDays(config) {
  const v = config && config.search && config.search.half_life_days;
  if (typeof v !== 'number' || !isFinite(v) || v < 0) return 30;
  return v;
}

/**
 * Normalise a CLI source name. Accepts "claude-code", "claude_code", "code"
 * (alias), "cowork" (alias). Returns canonical name or null.
 */
export function normalizeSourceName(input) {
  if (!input) return null;
  const s = String(input).toLowerCase().replace(/-/g, '_');
  const aliases = {
    code: 'claude_code',
    cowork: 'claude_cowork',
  };
  const canonical = aliases[s] || s;
  return KNOWN_SOURCES.includes(canonical) ? canonical : null;
}

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return clone(DEFAULT_CONFIG);
  let raw;
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')); }
  catch (_) { return clone(DEFAULT_CONFIG); }
  return mergeWithDefaults(raw, DEFAULT_CONFIG);
}

export function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(config, null, 2));
  renameSync(tmp, CONFIG_PATH);
}

/**
 * Is a given named source enabled?
 *   - boolean → that
 *   - object with .enabled → that
 *   - undefined → default-on
 */
export function isSourceEnabled(name, config) {
  const v = config.sources && config.sources[name];
  if (v === undefined || v === null) return true;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'object' && 'enabled' in v) return !!v.enabled;
  return true;
}

/** Mutate config to set source enabled/disabled. Preserves nested structure for obsidian. */
export function setSourceEnabled(name, enabled, config) {
  if (!config.sources) config.sources = {};
  const existing = config.sources[name];
  if (typeof existing === 'object' && existing !== null) {
    existing.enabled = !!enabled;
  } else {
    config.sources[name] = !!enabled;
  }
}

/** Get configured Obsidian vault list (config + env var). Returns absolute paths. */
export function obsidianVaultsFromConfig(config) {
  const out = [];
  const fromConfig = config.sources && config.sources.obsidian;
  if (fromConfig && typeof fromConfig === 'object' && Array.isArray(fromConfig.vaults)) {
    for (const v of fromConfig.vaults) out.push(expandTilde(v));
  }
  const fromEnv = (process.env.MEMEX_OBSIDIAN_VAULTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(expandTilde);
  // Dedup, env wins
  return [...new Set([...fromEnv, ...out])];
}

export function addObsidianVault(path, config) {
  const abs = resolve(expandTilde(path));
  if (!config.sources) config.sources = {};
  if (!config.sources.obsidian || typeof config.sources.obsidian !== 'object') {
    config.sources.obsidian = { enabled: true, vaults: [] };
  }
  if (!Array.isArray(config.sources.obsidian.vaults)) {
    config.sources.obsidian.vaults = [];
  }
  if (!config.sources.obsidian.vaults.includes(abs)) {
    config.sources.obsidian.vaults.push(abs);
  }
  return abs;
}

export function removeObsidianVault(path, config) {
  const abs = resolve(expandTilde(path));
  const obs = config.sources && config.sources.obsidian;
  if (!obs || typeof obs !== 'object' || !Array.isArray(obs.vaults)) return false;
  const before = obs.vaults.length;
  obs.vaults = obs.vaults.filter((v) => resolve(expandTilde(v)) !== abs);
  return obs.vaults.length !== before;
}

// -------------------- Internal helpers --------------------
function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function mergeWithDefaults(parsed, defaults) {
  const out = clone(defaults);
  if (!parsed || typeof parsed !== 'object') return out;
  if (parsed.sources && typeof parsed.sources === 'object') {
    for (const key of KNOWN_SOURCES) {
      if (key in parsed.sources) out.sources[key] = parsed.sources[key];
    }
  }
  if (parsed.search && typeof parsed.search === 'object') {
    if (typeof parsed.search.half_life_days === 'number') {
      out.search.half_life_days = parsed.search.half_life_days;
    }
  }
  return out;
}

function expandTilde(p) {
  if (!p) return p;
  if (p === '~' || p === '~/') return HOME;
  if (p.startsWith('~/')) return join(HOME, p.slice(2));
  return p;
}
