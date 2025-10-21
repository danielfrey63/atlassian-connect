// Playwright + Chromium-Variante für Confluence-Login und API-Zugriff
// Erster Lauf: sichtbarer Login (headless: false)
// Folgende Läufe: automatisiert (headless: true)

import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';

const AUTH_FILE = 'auth.json';
const LOGIN_URL = 'https://confluence.sbb.ch';
const API_URL   = 'https://confluence.sbb.ch/rest/api/content/3273443858';

// 🔹 Login-Phase mit sichtbarem Browser – Session speichern
async function loginAndSaveState() {
  const tmpProfile = path.join(os.tmpdir(), 'chromium-playwright-profile');
  const browser = await chromium.launchPersistentContext(tmpProfile, {
    headless: false,        // sichtbar für Login
  });

  const page = await browser.newPage();
  console.log('🌐 Bitte melde dich im geöffneten Browser bei Confluence an …');
  await page.goto(LOGIN_URL, { waitUntil: 'load' });

  // Warte 30 Sekunden, damit du dich manuell einloggen kannst
  await page.waitForTimeout(30000);

  const state = await browser.storageState();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2));
  console.log(`✅ Login-Daten gespeichert in ${AUTH_FILE}`);

  await browser.close();
}

// 🔹 API-Zugriff mit gespeicherter Session
async function fetchWithStoredState() {
  const browser = await chromium.launch({
    headless: true,          // vollautomatisch
  });

  const context = await browser.newContext({ storageState: AUTH_FILE });
  const request = await context.request.get(API_URL);

  if (!request.ok()) {
    console.error(`❌ HTTP ${request.status()} – Session evtl. abgelaufen.`);
    console.error(await request.text());
  } else {
    const data = await request.json();
    console.log('✅ API-Antwort:');
    console.log(JSON.stringify(data, null, 2));
  }

  await browser.close();
}

// 🔹 Hauptlogik
(async () => {
  if (!fs.existsSync(AUTH_FILE)) {
    console.log('🔑 Keine gespeicherte Session gefunden – starte Login-Prozess …');
    await loginAndSaveState();
  } else {
    console.log('🧠 Verwende gespeicherte Session …');
    await fetchWithStoredState();
  }
})();
