/**
 * Sync section of ~/.memex/config.json — owns its own defaults and helpers,
 * but persists through the same file as the rest of the config (so a single
 * config.json round-trips cleanly).
 *
 * Schema:
 *   sync: {
 *     server: {
 *       enabled:    false,                // are we running `memex sync server`?
 *       port:       8765,                 // listen port
 *       bind:       "0.0.0.0",            // 0.0.0.0 | 127.0.0.1 | tailscale-ip
 *       bearer:     "<64-hex>",           // 256-bit token (one per server)
 *       cert_path:  "~/.memex/sync-cert.pem",
 *       key_path:   "~/.memex/sync-key.pem",
 *       cert_fp:    "sha256:..."          // computed at server start
 *     },
 *     remotes: {
 *       "<alias>": {
 *         url:         "https://host:8765",
 *         bearer:      "<64-hex>",
 *         cert_fp:     "sha256:...",      // pinned fingerprint (from pair blob)
 *         pulled_to:   0,                 // last id we pulled FROM this remote
 *         pushed_to:   0,                 // last OUR id we pushed TO this remote
 *         last_sync_at: 0,                // unix ms; 0 = never
 *         last_error:  null               // string | null
 *       }
 *     }
 *   }
 *
 * The MEMEX_SYNC_EXPERIMENTAL=1 env var gates all sync activity at the CLI
 * layer; this module only knows shape, not whether the feature is on.
 */

import { loadConfig, saveConfig } from '../config.js';

export const DEFAULT_SYNC = Object.freeze({
  server: {
    enabled:   false,
    port:      8765,
    bind:      '0.0.0.0',
    bearer:    null,
    cert_path: null,
    key_path:  null,
    cert_fp:   null,
  },
  remotes: {},
});

export function loadSyncConfig() {
  const cfg = loadConfig();
  const sync = cfg.sync || {};
  return {
    server:  { ...DEFAULT_SYNC.server, ...(sync.server || {}) },
    remotes: { ...DEFAULT_SYNC.remotes, ...(sync.remotes || {}) },
  };
}

export function saveSyncConfig(syncCfg) {
  const cfg = loadConfig();
  cfg.sync = syncCfg;
  saveConfig(cfg);
}

/**
 * Merge `patch` into the sync.server section and persist. Other config sections
 * untouched. Returns the new server config.
 */
export function updateSyncServer(patch) {
  const sync = loadSyncConfig();
  sync.server = { ...sync.server, ...patch };
  saveSyncConfig(sync);
  return sync.server;
}

/**
 * Upsert a remote by alias. `patch` shallowly merges into the existing
 * remote (or seeds a new one with cursor=0).
 */
export function upsertSyncRemote(alias, patch) {
  if (!alias) throw new Error('upsertSyncRemote: alias required');
  const sync = loadSyncConfig();
  const existing = sync.remotes[alias] || {
    url: null, bearer: null, cert_fp: null,
    pulled_to: 0, pushed_to: 0,
    last_sync_at: 0, last_error: null,
  };
  sync.remotes[alias] = { ...existing, ...patch };
  saveSyncConfig(sync);
  return sync.remotes[alias];
}

export function getSyncRemote(alias) {
  const sync = loadSyncConfig();
  return sync.remotes[alias] || null;
}

export function listSyncRemotes() {
  return loadSyncConfig().remotes;
}

export function removeSyncRemote(alias) {
  const sync = loadSyncConfig();
  if (!(alias in sync.remotes)) return false;
  delete sync.remotes[alias];
  saveSyncConfig(sync);
  return true;
}

/**
 * Returns true iff MEMEX_SYNC_EXPERIMENTAL is set to a truthy value.
 * CLI commands and the MCP tool both consult this to refuse the operation
 * with a friendly "set the env var to enable" message.
 */
export function syncExperimentEnabled() {
  const v = process.env.MEMEX_SYNC_EXPERIMENTAL;
  if (!v) return false;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}
