#!/usr/bin/env node
/**
 * discord_launcher.js - Lance Discord web headless + injecte autodelete_testing.js
 * Boucle en continu : cleanup → attend X heures → cleanup → ...
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const INTERVAL_MS = (config.schedule?.intervalHours || 24) * 3600000;

class DiscordAutoLauncher {
  constructor() {
    const candidates = [
      path.join(__dirname, '..', '..', 'Scripts', 'autodelete_testing.js'),
      path.join(__dirname, '..', 'Scripts', 'autodelete_testing.js'),
    ];
    let scriptPath;
    for (const p of candidates) {
      if (fs.existsSync(p)) { scriptPath = p; break; }
    }
    if (!scriptPath) throw new Error(`Script introuvable (cherché: ${candidates.join(', ')})`);
    this.scriptContent = fs.readFileSync(scriptPath, 'utf8');
    this.running = true;
  }

  async run() {
    const browser = await chromium.launch({
      headless: config.playwright.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--window-size=1920,1080'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    });

    const page = await context.newPage();

    // Injecter token + script AVANT le chargement
    await page.addInitScript((payload) => {
      localStorage.setItem('token', JSON.stringify(payload.token));
      try { eval(payload.scriptContent); } catch (e) {
        console.error('[Inject] Erreur eval:', e);
      }
    }, { token: config.discord.token, scriptContent: this.scriptContent });

    page.on('pageerror', err => logger.error(`[Page Error] ${err.message}`));

    while (this.running) {
      await this.runCleanup(page);
      if (!this.running) break;
      logger.info(`⏳ Prochain cleanup dans ${INTERVAL_MS / 3600000}h`);
      await this.sleep(INTERVAL_MS);
    }

    await browser.close();
    logger.info('🔒 Navigateur fermé');
  }

  async runCleanup(page) {
    this.cleanupDone = false;
    const capturedLogs = [];

    page.on('console', msg => {
      const text = msg.text();
      capturedLogs.push(text);
      if (text.includes('Auto cleanup finished')) this.cleanupDone = true;
      if (text.includes('[UNDISCORD]') || text.includes('Starting job') || text.includes('Auto cleanup') || text.includes('Job failed') || text.includes('Auto-start')) {
        logger.info(`[Page] ${text}`);
      }
    });

    logger.info('🔄 Rechargement Discord...');
    await page.goto('https://discord.com/channels/@me', {
      waitUntil: 'networkidle',
      timeout: 60000
    });
    logger.info('✅ Auto-start en cours...');

    // Attendre la fin du cleanup
    const maxWait = 4 * 60 * 60 * 1000;
    const pollInterval = 15000;
    let waited = 0;

    while (!this.cleanupDone && waited < maxWait && this.running) {
      await page.waitForTimeout(pollInterval);
      waited += pollInterval;
      try {
        const finished = await page.evaluate(() => {
          const el = document.querySelector('#logArea');
          return el ? el.innerText.includes('Auto cleanup finished') : false;
        });
        if (finished) {
          logger.info('✅ Cleanup terminé');
          this.cleanupDone = true;
          break;
        }
      } catch (e) { /* ignore */ }
    }

    if (!this.cleanupDone) {
      logger.warn('⚠️ Cleanup non détecté comme terminé. Derniers logs:');
      capturedLogs.slice(-5).forEach(l => logger.info(`  ${l}`));
    }
  }

  stop() {
    this.running = false;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Healthcheck
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'healthy', uptime: process.uptime() }));
}).listen(3000, () => logger.info('🌐 Healthcheck sur port 3000'));

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('🛑 SIGTERM, arrêt...');
  if (launcher) launcher.stop();
  setTimeout(() => process.exit(0), 5000);
});

const launcher = new DiscordAutoLauncher();
launcher.run().catch(err => {
  logger.error('💥 Erreur fatale:', err);
  process.exit(1);
});
