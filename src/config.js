const fs = require('fs');
const path = require('path');

// Mini chargeur .env sans dépendance
function loadEnvFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '..', '.env'));

const env = (name, fallback = null) => {
  const value = process.env[name];
  return value !== undefined && value !== '' ? value : fallback;
};

const parseList = value => (value ? value.split(',').map(s => s.trim()).filter(Boolean) : []);
const parseNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// Base : config.json (compatibilité), surchargé ensuite par .env / variables d'environnement
let config = {
  discord: { token: null, authorId: null },
  excludedGuilds: [],
  schedule: { intervalHours: 24 },
  cleanup: { maxAgeDays: 30, searchDelay: 30000, deleteDelay: 1200 },
  webhook: { url: null, minLevel: 'info' },
};

try {
  const fileConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8'));
  config = {
    ...config,
    ...fileConfig,
    discord: { ...config.discord, ...(fileConfig.discord || {}) },
    schedule: { ...config.schedule, ...(fileConfig.schedule || {}) },
    cleanup: { ...config.cleanup, ...(fileConfig.cleanup || {}) },
    webhook: { ...config.webhook, ...(fileConfig.webhook || {}) },
  };
} catch {
  console.warn("⚠️  config.json manquant, utilisation des variables d'environnement (.env)");
}

config = {
  ...config,
  discord: {
    ...config.discord,
    token: env('DISCORD_TOKEN', config.discord.token),
    authorId: env('DISCORD_AUTHOR_ID', config.discord.authorId) || null,
  },
  excludedGuilds: parseList(env('EXCLUDED_GUILDS', config.excludedGuilds?.join(',') || '')),
  schedule: {
    ...config.schedule,
    intervalHours: parseNumber(env('SCHEDULE_INTERVAL_HOURS', config.schedule.intervalHours), config.schedule.intervalHours),
  },
  cleanup: {
    ...config.cleanup,
    maxAgeDays: parseNumber(env('CLEANUP_MAX_AGE_DAYS', config.cleanup.maxAgeDays), config.cleanup.maxAgeDays),
    searchDelay: parseNumber(env('CLEANUP_SEARCH_DELAY', config.cleanup.searchDelay), config.cleanup.searchDelay),
    deleteDelay: parseNumber(env('CLEANUP_DELETE_DELAY', config.cleanup.deleteDelay), config.cleanup.deleteDelay),
  },
  webhook: {
    ...config.webhook,
    url: env('WEBHOOK_URL', config.webhook.url),
    minLevel: env('WEBHOOK_MIN_LEVEL', config.webhook.minLevel),
  },
};

module.exports = config;
