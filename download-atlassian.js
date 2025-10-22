import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";

const PROFILE_DIR = path.join(os.tmpdir(), "chromium-playwright-profile");

function printHelp() {
  console.log(`
Usage: node download-page.js [options] <page_id> <base_url>
Parameters:
  --base_url, -b      Position 1, mandatory base URL of the Confluence site
  --page_id, -p       Position 2, mandatory page ID to download

Options:
  --ask, -a           Interactive mode: prompts for all parameters
  --recursive, -r     Whether to download recursively (default: true)
  --destination, -d   Directory where to save files (default: current directory)
  --help, -h          Show this help message

Examples:
  node download-atlassian.js https://confluence.sbb.ch 3273443858 --recursive=false --destination="./output"
  node download-atlassian.js --ask
  `);
}

function parseArgs(args) {
  const opts = {
    ask: false,
    recursive: true,
    destination: process.cwd(),
    base_url: null,
    page_id: null,
    help: false,
  };

  function getValue(arg) {
    const index = arg.indexOf('=');
    return index >= 0 ? arg.substring(index + 1) : null;
  }

  let positional = [];
  let expectBaseUrl = false, expectPageId = false, expectDest = false, expectRec = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (expectBaseUrl) { opts.base_url = arg; expectBaseUrl = false; continue; }
    if (expectPageId) { opts.page_id = arg; expectPageId = false; continue; }
    if (expectDest) { opts.destination = arg; expectDest = false; continue; }
    if (expectRec) {
      opts.recursive = arg.toLowerCase() === "true";
      expectRec = false; continue;
    }

    if (arg === '--ask' || arg === '-a') {
      opts.ask = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--base_url') {
      expectBaseUrl = true;
    } else if (arg.startsWith('--base_url=')) {
      opts.base_url = getValue(arg);
    } else if (arg === '-b') {
      expectBaseUrl = true;
    } else if (arg.startsWith('-b=')) {
      opts.base_url = getValue(arg);
    } else if (arg === '--page_id') {
      expectPageId = true;
    } else if (arg.startsWith('--page_id=')) {
      opts.page_id = getValue(arg);
    } else if (arg === '-p') {
      expectPageId = true;
    } else if (arg.startsWith('-p=')) {
      opts.page_id = getValue(arg);
    } else if (arg === '--recursive') {
      expectRec = true;
    } else if (arg.startsWith('--recursive=')) {
      const val = getValue(arg);
      opts.recursive = val ? val.toLowerCase() === "true" : true;
    } else if (arg === '-r') {
      expectRec = true;
    } else if (arg.startsWith('-r=')) {
      const val = getValue(arg);
      opts.recursive = val ? val.toLowerCase() === "true" : true;
    } else if (arg === '--destination') {
      expectDest = true;
    } else if (arg.startsWith('--destination=')) {
      opts.destination = getValue(arg) || opts.destination;
    } else if (arg === '-d') {
      expectDest = true;
    } else if (arg.startsWith('-d=')) {
      opts.destination = getValue(arg) || opts.destination;
    } else {
      positional.push(arg);
    }
  }

  // Only assign positional arguments if toggles were not set
  if (!opts.base_url && positional.length > 0) {
    opts.base_url = positional.shift();
  }
  if (!opts.page_id && positional.length > 0) {
    opts.page_id = positional.shift();
  }

  return opts;
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(question, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function fetchChildren(pageId, baseUrl, page) {
  // Fetch child pages by REST API
  const url = `/rest/api/content/${pageId}/child/page?expand=body.storage,version`;
  const respText = await page.evaluate(async (url) => {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) throw new Error(`Children fetch HTTP ${resp.status}`);
    return await resp.text();
  }, url);
  const respJson = JSON.parse(respText);
  // Return array of child page objects (id, title)
  return (respJson.results || []).map(child => ({
    id: child.id,
    title: child.title
  }));
}

function sanitizeTitle(title) {
  return title.replace(/[\\/:*?"<>|]/g, "_").split(/[_ ]+/).slice(0, 5).join("_");
}

async function downloadPageInternal(pageId, baseUrl, recursive, destination, parentRelPath, page) {
  const targetUrl = `${baseUrl}/pages/viewpage.action?pageId=${pageId}`;
  console.log(`🌐 Öffne ${targetUrl} …`);

  await page.goto(targetUrl);

  await page.waitForFunction(
    (pid) => {
      const url = window.location.href;
      return url.includes(pid) || document.body.innerHTML.includes(pid);
    },
    pageId,
    { timeout: 60000 }
  );

  const currentUrl = page.url();
  console.log(`🔗 Aktuelle URL: ${currentUrl}`);
  if (!currentUrl.includes(pageId)) {
    console.warn(`⚠️ Redirect erkannt, aber pageId bleibt gültig.`);
  }

  console.log("📡 Hole REST-API-Daten im Browserkontext …");
  const jsonText = await page.evaluate(async (pid) => {
    const url = `/rest/api/content/${pid}?expand=body.storage,version`;
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  }, pageId);

  const data = JSON.parse(jsonText);
  const xml = data.body.storage.value;
  const safeTitle = sanitizeTitle(data.title);
  const baseName = `page_${pageId}_${safeTitle}`;

  // Write XML file at current level: "page_<ID>_5_words.xml"
  const xmlRelPath = path.join(parentRelPath, `${baseName}.xml`);
  const xmlFullPath = path.resolve(destination, xmlRelPath);
  fs.mkdirSync(path.dirname(xmlFullPath), { recursive: true });
  fs.writeFileSync(xmlFullPath, xml, "utf-8");

  console.log(`✅ "${data.title}" gespeichert als ${xmlFullPath}`);

  const manifestNode = {
    id: pageId,
    title: data.title,
    url: currentUrl,
    filepath: xmlRelPath,
    children: []
  };

  if (recursive) {
    const children = await fetchChildren(pageId, baseUrl, page);
    if (children.length > 0) {
      // Create sibling directory to store children: "page_<ID>_5_words"
      const childDirRel = path.join(parentRelPath, baseName);
      const childDirFull = path.resolve(destination, childDirRel);
      fs.mkdirSync(childDirFull, { recursive: true });

      for (const child of children) {
        const childNode = await downloadPageInternal(child.id, baseUrl, true, destination, childDirRel, page);
        manifestNode.children.push(childNode);
      }
    }
  }

  return manifestNode;
}

async function downloadPage(pageId, baseUrl, recursive, destination, manifest = null, parentRelPath = "") {
  console.log(`📁 Verwende Profil: ${PROFILE_DIR}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
  });
  const page = await context.newPage();

  try {
    const node = await downloadPageInternal(pageId, baseUrl, recursive, destination, parentRelPath, page);
    return node;
  } finally {
    await context.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.help || argv.length === 0) {
    printHelp();
    process.exit(0);
  }

  if (opts.ask) {
    opts.page_id = await prompt("Page ID: ");
    opts.base_url = await prompt("Base URL: ");
    const rec = await prompt("Recursive? (true/false, default true): ");
    if (rec.toLowerCase() === "false") opts.recursive = false;
    const dest = await prompt(`Destination? (default: ${process.cwd()}): `);
    if (dest.trim() !== "") opts.destination = dest.trim();
  }

  if (!opts.page_id || !opts.base_url) {
    console.error("❌ Fehlende erforderliche Parameter: page_id und base_url sind obligatorisch.");
    printHelp();
    process.exit(1);
  }

  try {
    const manifest = await downloadPage(opts.page_id, opts.base_url, opts.recursive, opts.destination, null, "");
    // Write tree.json manifest after download if recursion enabled
    if (opts.recursive) {
      const manifestPath = path.join(opts.destination, "tree.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
      console.log(`🗂️ Seitenhierarchie gespeichert als ${manifestPath}`);
    }
  } catch (err) {
    console.error(`❌ Exception: ${err.message}`);
    printHelp();
    process.exit(2);
  }
}

main();
