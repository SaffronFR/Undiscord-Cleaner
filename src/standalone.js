#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

// === CONFIG (depuis .env, fallback config.json) ===
const config = require('./config');
const TOKEN = config.discord.token;
let AUTHOR_ID = config.discord.authorId || null;
const EXCLUDED_GUILDS = config.excludedGuilds || [];
const INTERVAL_H = config.schedule?.intervalHours || 24;
const MAX_AGE_DAYS = config.cleanup?.maxAgeDays || 30;
const SEARCH_DELAY = config.cleanup?.searchDelay || 8000;
const DELETE_DELAY = config.cleanup?.deleteDelay || 1200;
const WEBHOOK_URL = config.webhook?.url || null;

if (!TOKEN) {
  console.error('Token Discord manquant. Configure le fichier .env (voir .env.example)');
  process.exit(1);
}

// === WEBHOOK API (edit live progress) ===
let webhookId, webhookToken;
if (WEBHOOK_URL) {
  const m = WEBHOOK_URL.match(/webhooks\/(\d+)\/([^/]+)/);
  if (m) { webhookId = m[1]; webhookToken = m[2]; }
}

let progressMsgId = null;

async function sendOrUpdateWebhook(description, color = 0x00b0f4, finalize = false, extraFields = []) {
  if (!webhookId) return;
  // Flush les messages en attente AVANT de créer/modifier l'embed progression
  if (!progressMsgId) await flushWebhook();
  // Ajouter le résumé des warnings dans la description, au-dessus du progrès
  const warnCount = guildWarnings.length;
  const warnLine = warnCount > 0 ? `⚠️ ${warnCount} avertissement${warnCount > 1 ? 's' : ''}\n` : '';
  const body = {
    embeds: [{
      color,
      description: (warnLine + description).slice(0, 4000),
      fields: extraFields.length > 0 ? extraFields : undefined,
      timestamp: fmtIsoTs(),
      footer: { text: `Undiscord Auto • ${os.hostname()}` },
    }],
  };
  try {
    if (progressMsgId) {
      // Éditer le message existant (même pour finaliser)
      await fetch(`https://discord.com/api/webhooks/${webhookId}/${webhookToken}/messages/${progressMsgId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (finalize) progressMsgId = null;
    } else {
      const resp = await fetch(`https://discord.com/api/webhooks/${webhookId}/${webhookToken}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const data = await resp.json();
        progressMsgId = data.id;
      }
    }
  } catch {}
}
function resetProgressMsg() { progressMsgId = null; }

// === WEBHOOK LOGGER (buffered + immediate for important) ===
const logBuffer = [];
let webhookTimer = null;

function sendWebhook(level, msg, immediate = false) {
  if (!WEBHOOK_URL) return;
  logBuffer.push({ level, msg, ts: fmtLogTs() });
  if (immediate) flushWebhook();
  else if (!webhookTimer) {
    webhookTimer = setTimeout(flushWebhook, 10000);
  }
}

function truncate(str, max = 1800) {
  return str.length > max ? str.slice(0, max) + '...' : str;
}

async function flushWebhook() {
  webhookTimer = null;
  if (!WEBHOOK_URL || logBuffer.length === 0) return;
  const batch = logBuffer.splice(0);
  const lines = batch.map(l => `[${l.level.toUpperCase()}] ${l.msg}`);
  const colors = { debug: 0x808080, info: 0x00b0f4, warn: 0xfaa61a, error: 0xf04747, success: 0x43b581 };
  const color = batch.some(l => l.level === 'error') ? 0xf04747
    : batch.some(l => l.level === 'warn') ? 0xfaa61a
    : batch.some(l => l.level === 'success') ? 0x43b581
    : 0x00b0f4;
  const body = {
    embeds: [{
      color,
      description: '```\n' + truncate(lines.join('\n'), 4000) + '\n```',
      timestamp: fmtIsoTs(),
      footer: { text: `Undiscord Auto • ${os.hostname()}` }
    }]
  };
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch { /* ignore webhook errors */ }
}

const pad = n => String(n).padStart(2, '0');
function fmtLogTs() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtIsoTs() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = pad(Math.floor(Math.abs(off) / 60));
  const mm = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${hh}:${mm}`;
}
function fmtDate(d) {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function fmtTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDateTime(d) {
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

function log(level, ...args) {
  const msg = args.join(' ');
  const ts = fmtLogTs();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  console.log(line);
  // Seuls les niveaux importants partent en webhook ; debug/warn restent dans le log serveur
  const important = level === 'error' || level === 'success';
  if (level === 'info' || level === 'success' || level === 'error') sendWebhook(level, msg, important);
}

let progressLine = '';
let guildProgressName = '';
let guildWarnings = [];
function logProgress(level, ...args) {
  const msg = args.join(' ');
  const ts = fmtLogTs();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (progressLine) process.stdout.write('\r' + ' '.repeat(progressLine.length) + '\r');
  progressLine = line;
  process.stdout.write(line);
  // Live edit du message webhook
  const color = level === 'warn' ? 0xfaa61a : level === 'error' ? 0xf04747 : 0x00b0f4;
  sendOrUpdateWebhook(`**${guildProgressName}**\n\`\`\`${msg}\`\`\``, color);
}
async function endProgress(level, ...args) {
  const msg = args.join(' ');
  const ts = fmtLogTs();
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  if (progressLine) process.stdout.write('\r' + ' '.repeat(progressLine.length) + '\r');
  progressLine = '';
  console.log(line);
  // Finaliser le message webhook de progression
  const color = level === 'success' ? 0x43b581 : level === 'warn' ? 0xfaa61a : 0x00b0f4;
  sendOrUpdateWebhook(`**${guildProgressName}**\n\`\`\`${msg}\`\`\``, color, true);
  // Envoyer les détails des avertissements dans un message séparé
  if (guildWarnings.length > 0) {
    const details = guildWarnings.map((w, i) => `${i + 1}. ${w}`).join('\n');
    try {
      await fetch(`https://discord.com/api/webhooks/${webhookId}/${webhookToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [{
            color: 0xfaa61a,
            description: `\`\`\`ini\n${details.slice(0, 4000)}\n\`\`\``,
            footer: { text: guildProgressName },
          }],
        }),
      });
    } catch {}
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// === DELETION LOGGER (with rotation) ===
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'deleted_messages.log');
const MAX_LOG_SIZE = 1024 * 1024 * 1024; // 1 GB (uncompressed)
const MAX_LOG_FILES = 15;                // 15 archives compressés (~130 MB chacun)
// Total: 1 GB + 15 × ~130 MB = ~3 GB pour ~64 millions de messages max

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

let rotating = false;
function rotateLog() {
  if (rotating) return;
  rotating = true;
  try {
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const oldPath = path.join(LOG_DIR, `deleted_messages.log.${i}.gz`);
      const newPath = path.join(LOG_DIR, `deleted_messages.log.${i + 1}.gz`);
      if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
    }
    const tempPath = path.join(LOG_DIR, 'deleted_messages.log.rotating');
    const firstPath = path.join(LOG_DIR, 'deleted_messages.log.1.gz');
    if (fs.existsSync(LOG_FILE)) {
      fs.renameSync(LOG_FILE, tempPath);
      const gzip = zlib.createGzip();
      const inp = fs.createReadStream(tempPath);
      const out = fs.createWriteStream(firstPath);
      inp.pipe(gzip).pipe(out);
      out.on('finish', () => { try { fs.unlinkSync(tempPath); } catch {} });
    }
  } finally {
    rotating = false;
  }
}

function logDeletion(msg) {
  const entry = {
    ts: fmtLogTs(),
    guildId: msg.guild_id,
    channelId: msg.channel_id,
    messageId: msg.id,
    author: `${msg.author?.username || '?'}#${msg.author?.discriminator || '?'}`,
    date: msg.timestamp,
    content: (msg.content || '').slice(0, 500),
  };
  try {
    const stats = fs.statSync(LOG_FILE);
    if (stats.size >= MAX_LOG_SIZE) rotateLog();
  } catch {}
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}

function toSnowflake(dateStr) {
  if (/[:T]/.test(dateStr)) {
    return ((new Date(dateStr).getTime() - 1420070400000) * 2 ** 22).toString();
  }
  return dateStr;
}

// === API HELPER ===
async function api(path, options = {}) {
  const url = `https://discord.com/api/v9${path}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { headers: optHeaders, ...rest } = options;
      const resp = await fetch(url, {
        headers: { 'Authorization': TOKEN, ...optHeaders },
        ...rest,
      });
      if (resp.status === 429) {
        const data = await resp.json().catch(() => ({}));
        const w = (data.retry_after || 5) * 1000;
        log('warn', `Rate limit sur ${path}, attente ${w}ms (tentative ${attempt + 1}/5)`);
        await wait(w + 1000);
        continue;
      }
      if (resp.status === 202) {
        const data = await resp.json().catch(() => ({}));
        const w = (data.retry_after || 5) * 1000;
        log('warn', `Channel non indexé, attente ${w}ms...`);
        await wait(w);
        continue;
      }
      if (resp.status === 400) {
        const txt = await resp.text().catch(() => '');
        return { ok: false, status: 400, body: txt };
      }
      return resp;
    } catch (err) {
      if (attempt < 4) {
        log('warn', `Erreur réseau sur ${path}, tentative ${attempt + 2}/5: ${err.message}`);
        await wait(5000 * (attempt + 1));
      } else {
        throw err;
      }
    }
  }
  throw new Error(`Échec après 5 tentatives sur ${path}`);
}

async function apiJSON(path, options = {}) {
  const resp = await api(path, options);
  if (resp.ok === false) return null;
  return resp.json().catch(() => null);
}

// === USER VALIDATION ===
async function validateToken() {
  const data = await apiJSON('/users/@me');
  if (!data || !data.id) {
    log('error', 'Token invalide ou expiré.');
    return null;
  }
  if (data.bot) {
    log('error', 'Token de bot détecté. Utilise un token utilisateur.');
    return null;
  }
  log('success', `Authentifié en tant que ${data.username}#${data.discriminator} (${data.id})`);
  if (!AUTHOR_ID) {
    AUTHOR_ID = data.id;
    log('info', `authorId auto-détecté: ${AUTHOR_ID}`);
  }
  return data;
}

async function getGuilds() {
  const guilds = await apiJSON('/users/@me/guilds?limit=200');
  return guilds || [];
}

// === SEARCH & DELETE ===
async function searchMessages(guildId, beforeId) {
  const params = new URLSearchParams({
    max_id: beforeId || '0',
    sort_by: 'timestamp',
    sort_order: 'desc',
    offset: '0',
    include_nsfw: 'true',
  });
  if (AUTHOR_ID) params.set('author_id', AUTHOR_ID);
  const resp = await api(`/guilds/${guildId}/messages/search?${params}`);
  if (!resp || !resp.ok) return { total_results: 0, messages: [] };
  return resp.json().catch(() => ({ total_results: 0, messages: [] }));
}

const failedThreads = new Set();

async function deleteMessage(channelId, messageId) {
  const resp = await api(`/channels/${channelId}/messages/${messageId}`, { method: 'DELETE' });
  if (!resp) return 'RETRY';
  if (resp.status === 204 || resp.ok) return 'OK';
  if (resp.status === 429) return 'RETRY';
  if (resp.status === 404) return 'OK'; // déjà supprimé
  if (resp.status === 400 && resp.body) {
    try {
      const r = JSON.parse(resp.body);
      if (r.code === 50083) {
        if (failedThreads.has(channelId)) {
          guildWarnings.push(`Thread archivé ${channelId} (déjà échoué)`);
          return 'FAILED';
        }
        log('warn', `Thread ${channelId} archivé, tentative de désarchivage...`);
        const unarchResp = await api(`/channels/${channelId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: false }),
        });
        if (!unarchResp) {
          log('warn', `Aucune réponse au désarchivage du thread ${channelId}, ignoré`);
          return 'FAILED';
        }
        if (unarchResp.status === 200 || unarchResp.ok) {
          log('info', `Thread ${channelId} désarchivé, nouvelle tentative`);
          return 'RETRY';
        }
        let errBody;
        try {
          errBody = typeof unarchResp.body === 'string' ? unarchResp.body : await unarchResp.text();
        } catch { errBody = 'inconnu'; }
        failedThreads.add(channelId);
        const warnMsg = `Thread archivé ${channelId} (HTTP ${unarchResp.status})`;
        guildWarnings.push(warnMsg);
        log('warn', `${warnMsg}: ${String(errBody).slice(0, 100)}`);
        return 'FAILED';
      }
    } catch {}
  }
  return 'FAILED';
}

async function cleanupGuild(guildId, guildName) {
  const maxDate = new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString();
  const maxId = toSnowflake(maxDate);

  log('info', `  → ${guildName || guildId}: recherche messages avant le ${fmtDate(new Date(maxDate))}...`);
  guildProgressName = `${guildName || guildId}`;
  guildWarnings = [];
  resetProgressMsg();

  const cutOffId = toSnowflake(maxDate);
  const firstPage = await searchMessages(guildId, cutOffId);
  const total = firstPage.total_results || 0;
  if (total === 0) {
    log('info', `  Aucun message trouvé`);
    return { deleted: 0, failed: 0, total: 0 };
  }

  log('info', `  ${total} messages trouvés au total`);
  let deleted = 0, failed = 0, emptyPages = 0;
  let beforeId = cutOffId;
  const processedIds = new Set();

  while (true) {
    const page = await searchMessages(guildId, beforeId);
    const conversations = page.messages || [];
    if (conversations.length === 0) {
      emptyPages++;
      if (emptyPages >= 2) break;
      await wait(2000);
      continue;
    }
    emptyPages = 0;

    let foundOnPage = 0, skippedByType = 0, skippedPinned = 0;
    let oldestId = beforeId;

    for (const conv of conversations) {
      for (const msg of conv) {
        if (!msg) { skippedByType++; continue; }
        if (processedIds.has(msg.id)) continue;
        processedIds.add(msg.id);
        if (BigInt(msg.id) < BigInt(oldestId)) oldestId = msg.id;
        if (msg.type !== 0 && msg.type !== 15 && msg.type !== 18 && msg.type !== 19) { skippedByType++; continue; }
        if (msg.pinned) { skippedPinned++; continue; }
        foundOnPage++;

        let attempts = 0;
        while (attempts < 3) {
          const result = await deleteMessage(msg.channel_id, msg.id);
          if (result === 'OK') { deleted++; logDeletion(msg); break; }
          if (result === 'RETRY') { attempts++; await wait(DELETE_DELAY); }
          else { failed++; break; }
        }
        await wait(DELETE_DELAY);
      }
    }

    log('debug', `${foundOnPage} trouvés, ${skippedByType} filtrés (type), ${skippedPinned} épinglés`);
    logProgress('info', `  ${deleted + failed}/${total} (${deleted} supprimés, ${failed} échoués)`);

    if (foundOnPage > 0) {
      // Des messages trouvés : on re-interroge le même beforeId
      // Les messages déjà traités (processedIds) seront ignorés,
      // l'API renvoie les suivants après suppression
      await wait(SEARCH_DELAY);
      continue;
    }
    if (oldestId === beforeId) break;
    beforeId = String(BigInt(oldestId) - 1n);
    await wait(SEARCH_DELAY);
  }

  const summary = `${deleted} supprimés, ${failed} échoués sur ${total} trouvés`;
  await endProgress(deleted > 0 ? 'success' : 'info', `  Terminé: ${summary}`);
  return { deleted, failed, total };
}

// === CYCLE SUMMARY ===
function sendCycleSummary(stats, totalDel, totalFail, nextCleanupDate) {
  if (!WEBHOOK_URL) return;
  const active = stats.filter(s => (s.found || 0) > 0 || (s.deleted || 0) > 0 || (s.failed || 0) > 0 || s.error);
  const lines = ['```ml\n'];
  lines.push(`${'Serveur'.padEnd(30)} ${'Trouvés'.padStart(8)} ${'Suppr.'.padStart(7)} ${'Échoués'.padStart(7)}`);
  lines.push(`${''.padEnd(30, '─')} ${''.padEnd(8, '─')} ${''.padEnd(7, '─')} ${''.padEnd(7, '─')}`);
  for (const s of active) {
    const name = (s.name || '?').slice(0, 28);
    lines.push(`${name.padEnd(30)} ${String(s.found || 0).padStart(8)} ${String(s.deleted || 0).padStart(7)} ${String(s.failed || 0).padStart(7)}`);
  }
  if (active.length === 0) lines.push(`${'Aucun message trouvé'.padEnd(30)}`);
  lines.push(`${''.padEnd(30, '─')} ${''.padEnd(8, '─')} ${''.padEnd(7, '─')} ${''.padEnd(7, '─')}`);
  lines.push(`${'TOTAL'.padEnd(30)} ${String(totalDel + totalFail).padStart(8)} ${String(totalDel).padStart(7)} ${String(totalFail).padStart(7)}`);
  lines.push('```');
  const desc = lines.join('\n').slice(0, 4000);
  const nd = nextCleanupDate || new Date(Date.now() + INTERVAL_H * 3600000);
  const body = {
    embeds: [{
      color: totalFail > 0 ? 0xfaa61a : 0x43b581,
      title: `📊 Cycle du ${fmtDate(new Date())}`,
      description: desc,
      fields: [
        { name: 'Prochain cleanup', value: `${fmtDateTime(nd)}`, inline: true },
        { name: 'Statut', value: totalFail > 0 ? '⚠️ Terminé avec des erreurs' : '✅ Terminé sans erreur', inline: true },
      ],
      timestamp: fmtIsoTs(),
      footer: { text: `Undiscord Auto • ${os.hostname()}` },
    }],
  };
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// === MAIN LOOP ===
let running = true;

async function main() {
  log('success', '=== UNDISCORD AUTO-CLEANUP VPS ===');
  log('info', `Intervalle: ${INTERVAL_H}h | Âge max: ${MAX_AGE_DAYS} jours | Serveurs exclus: ${EXCLUDED_GUILDS.length || 'aucun'}`);

  const user = await validateToken();
  if (!user) { process.exit(1); }

  while (running) {
    const cycleStart = Date.now();
    log('info', 'Récupération de la liste des serveurs...');
    let guilds;
    try {
      guilds = await getGuilds();
    } catch (e) {
      log('error', `Erreur récupération serveurs: ${e.message}`);
      await wait(60000);
      continue;
    }
    log('info', `${guilds.length} serveurs trouvés`);
    // Pause pour laisser le bucket rate limit se refroidir avant les recherches
    await wait(5000);

    const toProcess = guilds.filter(g => !EXCLUDED_GUILDS.includes(g.id));
    log('info', `${toProcess.length} à traiter (${guilds.length - toProcess.length} exclus)`);

    const cycleStats = [];
    let totalDeleted = 0, totalFailed = 0;
    for (let i = 0; i < toProcess.length; i++) {
      if (!running) break;
      const g = toProcess[i];
      log('info', `[${i + 1}/${toProcess.length}] ${g.name} (${g.id})`);
      try {
        const result = await cleanupGuild(g.id, g.name);
        cycleStats.push({ name: g.name, found: result.total, deleted: result.deleted, failed: result.failed });
        totalDeleted += result.deleted;
        totalFailed += result.failed;
      } catch (e) {
        cycleStats.push({ name: g.name, found: 0, deleted: 0, failed: 0, error: e.message });
        log('error', `  ERREUR: ${e.message}`);
      }
      if (i < toProcess.length - 1) await wait(5000);
    }

    // Attendre jusqu'à la prochaine échéance fixe (toutes les INTERVAL_H depuis le début du cycle)
    const elapsed = Date.now() - cycleStart;
    const waitMs = Math.max(0, INTERVAL_H * 3600000 - elapsed);
    const nextDate = new Date(Date.now() + waitMs);

    log('success', `Cycle terminé: ${totalDeleted} supprimés, ${totalFailed} échoués au total`);
    sendCycleSummary(cycleStats, totalDeleted, totalFailed, nextDate);
    log('info', `Prochain cleanup à ${fmtTime(nextDate)} (${fmtDate(nextDate)})`);
    await wait(waitMs);
  }
}

// === HEALTHCHECK ===
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'healthy', uptime: process.uptime() }));
}).listen(3000, () => log('info', 'Healthcheck sur http://0.0.0.0:3000'));

process.on('SIGTERM', async () => {
  log('warn', 'SIGTERM reçu, arrêt en cours...');
  running = false;
  await flushWebhook();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('warn', 'SIGINT reçu, arrêt en cours...');
  running = false;
  await flushWebhook();
  process.exit(0);
});

main().catch(async e => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
