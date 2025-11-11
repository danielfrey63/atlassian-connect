import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";

const PROFILE_DIR = path.join(os.tmpdir(), "chromium-playwright-profile");

function printHelp() {
  console.log(`
Usage: node atlassian-upload.js [options]

Modes:
  --mode, -m           update | clone   (default: update)

Required:
  --base_url, -b       Base URL of the Confluence site (e.g. https://confluence.sbb.ch)

Update mode:
  --manifest, -f       Path to manifest tree.json (default: ./output/tree.json)
  --source, -s         Directory for XML bodies (default: directory of manifest)
  --page_id, -p        Update a single page ID (requires --source pointing to XML file)

Clone mode:
  --root_id, -r        Destination root page ID to clone under (required for clone)
  --manifest, -f       Path to manifest tree.json (default: ./output/tree.json)
  --source, -s         Directory for XML bodies (default: directory of manifest)
  --suffix             Suffix used only if a duplicate title exists (default: Clone)

Options:
  --ask, -a            Interactive mode: prompts for parameters
  --dry-run            Do not change anything, only print planned actions
  --help, -h           Show this help message

Examples:
  node atlassian-upload.js -b https://confluence.sbb.ch --mode=update -f ./output/tree.json -s ./output
  node atlassian-upload.js -b https://confluence.sbb.ch --page_id=2393644957 -s ./output/page_1336019187_How-to_OpenShift/page_2393644957_High_Availability_Ingress_Traffic_Routing.xml
  node atlassian-upload.js -b https://confluence.sbb.ch --mode=clone --root_id=123456789 -f ./output/tree.json -s ./output --suffix=Clone
`);
}

function parseArgs(args) {
  const opts = {
    ask: false,
    base_url: null,
    mode: "update",
    manifest: path.join(process.cwd(), "output", "tree.json"),
    source: null,
    page_id: null,
    root_id: null,
    dry_run: false,
    suffix: null,
    help: false,
  };

  function getValue(arg) {
    const index = arg.indexOf('=');
    return index >= 0 ? arg.substring(index + 1) : null;
  }

  let expectBaseUrl=false, expectMode=false, expectManifest=false, expectSource=false, expectPageId=false, expectRootId=false, expectSuffix=false;
  for (let i=0;i<args.length;i++) {
    const arg = args[i];
    if (expectBaseUrl) { opts.base_url = arg; expectBaseUrl=false; continue; }
    if (expectMode) { opts.mode = arg; expectMode=false; continue; }
    if (expectManifest) { opts.manifest = arg; expectManifest=false; continue; }
    if (expectSource) { opts.source = arg; expectSource=false; continue; }
    if (expectPageId) { opts.page_id = arg; expectPageId=false; continue; }
    if (expectRootId) { opts.root_id = arg; expectRootId=false; continue; }
    if (expectSuffix) { opts.suffix = arg; expectSuffix=false; continue; }

    if (arg === '--ask' || arg === '-a') {
      opts.ask = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--dry-run') {
      opts.dry_run = true;
    } else if (arg === '--base_url') {
      expectBaseUrl = true;
    } else if (arg.startsWith('--base_url=')) {
      opts.base_url = getValue(arg);
    } else if (arg === '-b') {
      expectBaseUrl = true;
    } else if (arg.startsWith('-b=')) {
      opts.base_url = getValue(arg);
    } else if (arg === '--mode') {
      expectMode = true;
    } else if (arg.startsWith('--mode=')) {
      opts.mode = getValue(arg) || opts.mode;
    } else if (arg === '-m') {
      expectMode = true;
    } else if (arg.startsWith('-m=')) {
      opts.mode = getValue(arg) || opts.mode;
    } else if (arg === '--manifest' || arg === '-f') {
      expectManifest = true;
    } else if (arg.startsWith('--manifest=')) {
      opts.manifest = getValue(arg) || opts.manifest;
    } else if (arg.startsWith('-f=')) {
      opts.manifest = getValue(arg) || opts.manifest;
    } else if (arg === '--source' || arg === '-s') {
      expectSource = true;
    } else if (arg.startsWith('--source=')) {
      opts.source = getValue(arg) || opts.source;
    } else if (arg.startsWith('-s=')) {
      opts.source = getValue(arg) || opts.source;
    } else if (arg === '--page_id' || arg === '-p') {
      expectPageId = true;
    } else if (arg.startsWith('--page_id=')) {
      opts.page_id = getValue(arg);
    } else if (arg.startsWith('-p=')) {
      opts.page_id = getValue(arg);
    } else if (arg === '--root_id' || arg === '-r') {
      expectRootId = true;
    } else if (arg.startsWith('--root_id=')) {
      opts.root_id = getValue(arg);
    } else if (arg.startsWith('-r=')) {
      opts.root_id = getValue(arg);
    } else if (arg === '--suffix') {
      expectSuffix = true;
    } else if (arg.startsWith('--suffix=')) {
      opts.suffix = getValue(arg);
    }
  }

  return opts;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

function readManifest(manifestPath) {
  const text = fs.readFileSync(manifestPath, "utf-8");
  return JSON.parse(text);
}

async function openContext() {
  console.log(`📁 Verwende Profil: ${PROFILE_DIR}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false });
  const page = await context.newPage();
  return { context, page };
}

async function fetchJson(page, url) {
  const respText = await page.evaluate(async (url) => {
    const resp = await fetch(url, { credentials: "include", headers: { "Accept": "application/json", "Content-Type": "application/json" } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  }, url);
  return JSON.parse(respText);
}

async function putJson(page, url, body) {
  const respText = await page.evaluate(async ({ url, body }) => {
    const resp = await fetch(url, {
      method: "PUT",
      credentials: "include",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Atlassian-Token": "no-check"
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${errText}`);
    }
    return await resp.text();
  }, { url, body });
  return JSON.parse(respText);
}

async function postJson(page, url, body) {
  const respText = await page.evaluate(async ({ url, body }) => {
    const resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Atlassian-Token": "no-check"
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${errText}`);
    }
    return await resp.text();
  }, { url, body });
  return JSON.parse(respText);
}

async function getPageById(page, id) {
  const url = `/rest/api/content/${id}?expand=version,title,space`;
  return await fetchJson(page, url);
}

async function searchByTitle(page, spaceKey, title) {
  const url = `/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}&type=page`;
  const res = await fetchJson(page, url);
  return res.results || [];
}

async function makeUniqueTitle(page, spaceKey, baseTitle, suffix) {
  // Only apply suffix when a duplicate exists
  const existsBase = await searchByTitle(page, spaceKey, baseTitle);
  if (!existsBase || existsBase.length === 0) {
    return baseTitle;
  }
  const firstCandidate = `${baseTitle} ${suffix}`;
  const existsFirst = await searchByTitle(page, spaceKey, firstCandidate);
  if (!existsFirst || existsFirst.length === 0) {
    return firstCandidate;
  }
  for (let i = 1; i <= 100; i++) {
    const candidate = `${baseTitle} ${suffix} ${i}`;
    const exists = await searchByTitle(page, spaceKey, candidate);
    if (!exists || exists.length === 0) {
      return candidate;
    }
  }
  // Fallback if too many collisions
  return `${baseTitle} ${suffix} ${Date.now()}`;
}

function readXmlFile(sourceDir, relPathOrFile) {
  const fullPath = relPathOrFile && fs.existsSync(relPathOrFile) && fs.statSync(relPathOrFile).isFile()
    ? relPathOrFile
    : path.resolve(sourceDir, relPathOrFile);
  const xml = fs.readFileSync(fullPath, "utf-8");
  return { xml, fullPath };
}

async function updateSinglePage(page, baseUrl, pageId, xmlFilePath, dryRun=false) {
  const targetUrl = `${baseUrl}/pages/viewpage.action?pageId=${pageId}`;
  console.log(`🌐 Öffne ${targetUrl} …`);
  await page.goto(targetUrl);
  await page.waitForFunction((pid)=>window.location.href.includes(pid), pageId, { timeout: 60000 });

  const current = await getPageById(page, pageId);
  const title = current.title;
  const version = current.version?.number || 1;

  const { xml } = readXmlFile(path.dirname(xmlFilePath), xmlFilePath);
  console.log(`✍️ Aktualisiere Seite ID=${pageId} Titel="${title}" Version=${version} → ${version+1}`);

  if (dryRun) {
    console.log(`DRY-RUN: PUT /rest/api/content/${pageId} body.storage.value length=${xml.length}`);
    return { id: pageId, title, status: "dry-run" };
  }

  const body = {
    id: pageId,
    type: "page",
    title,
    version: { number: version + 1 },
    body: { storage: { value: xml, representation: "storage" } }
  };
  try {
    await putJson(page, `/rest/api/content/${pageId}`, body);
    console.log(`✅ Aktualisiert: ID=${pageId} Titel="${title}"`);
    return { id: pageId, title, status: "updated" };
  } catch (err) {
    console.error(`❌ Fehler beim Aktualisieren ID=${pageId}: ${err.message}`);
    return { id: pageId, title, status: `error:${err.message}` };
  }
}

async function updateTree(page, baseUrl, manifest, sourceDir, dryRun=false) {
  const summary = [];

  async function processNode(node) {
    const xmlPath = node.filepath;
    const { xml, fullPath } = readXmlFile(sourceDir, xmlPath);

    // Open page to ensure session context
    const targetUrl = `${baseUrl}/pages/viewpage.action?pageId=${node.id}`;
    console.log(`🌐 Öffne ${targetUrl} …`);
    await page.goto(targetUrl);
    await page.waitForFunction((pid)=>window.location.href.includes(pid), node.id, { timeout: 60000 });

    let title = node.title;
    let version = 1;
    try {
      const current = await getPageById(page, node.id);
      title = current.title;
      version = current.version?.number || 1;
    } catch (err) {
      console.warn(`⚠️ Konnte Metadaten nicht lesen ID=${node.id}: ${err.message}`);
    }

    console.log(`✍️ Aktualisiere Seite ID=${node.id} Titel="${title}" Datei=${fullPath}`);
    if (dryRun) {
      console.log(`DRY-RUN: PUT /rest/api/content/${node.id} body.storage.value length=${xml.length}`);
      summary.push({ id: node.id, title, status: "dry-run" });
    } else {
      const body = {
        id: node.id,
        type: "page",
        title,
        version: { number: version + 1 },
        body: { storage: { value: xml, representation: "storage" } }
      };
      try {
        await putJson(page, `/rest/api/content/${node.id}`, body);
        console.log(`✅ Aktualisiert: ID=${node.id} Titel="${title}"`);
        summary.push({ id: node.id, title, status: "updated" });
      } catch (err) {
        console.error(`❌ Fehler ID=${node.id} Titel="${title}": ${err.message}`);
        summary.push({ id: node.id, title, status: `error:${err.message}` });
      }
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        await processNode(child);
      }
    }
  }

  await processNode(manifest);
  return summary;
}

async function cloneTree(page, baseUrl, manifest, sourceDir, rootId, dryRun=false, suffix=null) {
  // Ensure browser navigates to root page to set session before any relative REST calls [SF][REH]
  const rootViewUrl = `${baseUrl}/pages/viewpage.action?pageId=${rootId}`;
  console.log(`🌐 Öffne ${rootViewUrl} …`);
  await page.goto(rootViewUrl);
  await page.waitForFunction((rid)=>window.location.href.includes(rid), rootId, { timeout: 60000 });

  // Resolve root space
  const rootInfo = await getPageById(page, rootId);
  const spaceKey = rootInfo.space?.key;
  if (!spaceKey) throw new Error("Konnte Space-Key für root_id nicht bestimmen.");

  const map = {}; // oldId -> newId
  const summary = [];

  async function createUnder(parentId, node) {
    const xmlPath = node.filepath;
    const { xml, fullPath } = readXmlFile(sourceDir, xmlPath);

    // Determine desired title with duplicate handling
    const baseTitle = node.title;
    const finalSuffix = (suffix && suffix.trim()) ? suffix.trim() : "Clone";
    let desiredTitle = baseTitle;
    try {
      desiredTitle = await makeUniqueTitle(page, spaceKey, baseTitle, finalSuffix);
      if (desiredTitle !== baseTitle) {
        console.log(`🔁 Titel angepasst wegen Duplikat: "${baseTitle}" → "${desiredTitle}"`);
      }
    } catch (err) {
      console.warn(`⚠️ Konnte Duplikatsuche nicht durchführen für "${baseTitle}": ${err.message}`);
    }

    const body = {
      type: "page",
      title: desiredTitle,
      space: { key: spaceKey },
      ancestors: [{ id: parentId }],
      body: { storage: { value: xml, representation: "storage" } }
    };

    if (dryRun) {
      console.log(`DRY-RUN: POST /rest/api/content title="${desiredTitle}" parent=${parentId} xmlLen=${xml.length}`);
      const fakeId = `dry-${node.id}`;
      map[node.id] = fakeId;
      summary.push({ oldId: node.id, newId: fakeId, title: desiredTitle, status: "dry-run" });
    } else {
      try {
        const created = await postJson(page, `/rest/api/content`, body);
        const newId = created.id;
        map[node.id] = newId;
        console.log(`✅ Erstellt: "${desiredTitle}" alt=${node.id} neu=${newId}`);
        summary.push({ oldId: node.id, newId, title: desiredTitle, status: "created" });
        // Recurse into children
        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            await createUnder(newId, child);
          }
        }
      } catch (err) {
        console.error(`❌ Fehler beim Erstellen "${desiredTitle}" alt=${node.id}: ${err.message}`);
        summary.push({ oldId: node.id, newId: null, title: desiredTitle, status: `error:${err.message}` });
      }
    }
  }

  // Create top-level page under root_id for manifest root
  await createUnder(rootId, manifest);

  return { map, summary };
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.help || argv.length === 0) {
    printHelp();
    process.exit(0);
  }

  if (opts.ask) {
    opts.base_url = await prompt("Base URL: ");
    const mode = await prompt("Mode (update/clone, default update): ");
    if (mode.trim()) opts.mode = mode.trim();
    if (opts.mode === "update") {
      const pageIdAns = await prompt("Single page ID (optional): ");
      if (pageIdAns.trim()) opts.page_id = pageIdAns.trim();
      const manifestAns = await prompt(`Manifest path (default ${opts.manifest}): `);
      if (manifestAns.trim()) opts.manifest = manifestAns.trim();
      const sourceAns = await prompt("Source directory (default: directory of manifest): ");
      if (sourceAns.trim()) opts.source = sourceAns.trim();
    } else if (opts.mode === "clone") {
      opts.root_id = await prompt("Root page ID: ");
      const manifestAns = await prompt(`Manifest path (default ${opts.manifest}): `);
      if (manifestAns.trim()) opts.manifest = manifestAns.trim();
      const sourceAns = await prompt("Source directory (default: directory of manifest): ");
      if (sourceAns.trim()) opts.source = sourceAns.trim();
      const suffixAns = await prompt("Suffix for duplicate titles (optional, default: Clone): ");
      if (suffixAns.trim()) opts.suffix = suffixAns.trim();
    }
    const dryAns = await prompt("Dry-run? (true/false, default false): ");
    if (dryAns.toLowerCase() === "true") opts.dry_run = true;
  }

  if (!opts.base_url) {
    console.error("❌ Fehlender Parameter: --base_url ist obligatorisch.");
    printHelp();
    process.exit(1);
  }

  // Default source dir from manifest
  if (!opts.source && opts.manifest) {
    opts.source = path.dirname(path.resolve(opts.manifest));
  }

  const { context, page } = await openContext();
  try {
    if (opts.mode === "update") {
      if (opts.page_id) {
        if (!opts.source || !fs.existsSync(opts.source)) {
          console.error("❌ --source muss auf die XML-Datei verweisen, wenn --page_id gesetzt ist.");
          process.exit(1);
        }
        const res = await updateSinglePage(page, opts.base_url, opts.page_id, opts.source, opts.dry_run);
        const summaryPath = path.join(process.cwd(), "upload-summary.json");
        fs.writeFileSync(summaryPath, JSON.stringify([res], null, 2), "utf-8");
        console.log(`🗂️ Zusammenfassung gespeichert als ${summaryPath}`);
      } else {
        if (!opts.manifest || !fs.existsSync(opts.manifest)) {
          console.error("❌ Manifest nicht gefunden. Verwende --manifest.");
          process.exit(1);
        }
        const manifest = readManifest(opts.manifest);
        const summary = await updateTree(page, opts.base_url, manifest, opts.source, opts.dry_run);
        const summaryPath = path.join(path.dirname(path.resolve(opts.manifest)), "upload-summary.json");
        fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
        console.log(`🗂️ Zusammenfassung gespeichert als ${summaryPath}`);
      }
    } else if (opts.mode === "clone") {
      if (!opts.root_id) {
        console.error("❌ Für clone-Modus ist --root_id erforderlich.");
        process.exit(1);
      }
      if (!opts.manifest || !fs.existsSync(opts.manifest)) {
        console.error("❌ Manifest nicht gefunden. Verwende --manifest.");
        process.exit(1);
      }
      const manifest = readManifest(opts.manifest);
      const { map, summary } = await cloneTree(page, opts.base_url, manifest, opts.source, opts.root_id, opts.dry_run, opts.suffix);
      const baseDir = path.dirname(path.resolve(opts.manifest));
      const newTree = {
        id: map[manifest.id] || manifest.id,
        title: manifest.title,
        url: "",
        filepath: manifest.filepath,
        children: (manifest.children || []).map(child => ({
          id: map[child.id] || child.id,
          title: child.title,
          url: "",
          filepath: child.filepath,
          children: child.children || []
        }))
      };
      const newTreePath = path.join(baseDir, "new-tree.json");
      const mapPath = path.join(baseDir, "upload-map.json");
      const summaryPath = path.join(baseDir, "upload-summary.json");
      fs.writeFileSync(newTreePath, JSON.stringify(newTree, null, 2), "utf-8");
      fs.writeFileSync(mapPath, JSON.stringify(map, null, 2), "utf-8");
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
      console.log(`🗂️ neue Manifestdatei: ${newTreePath}`);
      console.log(`🗂️ ID-Mapping gespeichert als ${mapPath}`);
      console.log(`🗂️ Zusammenfassung gespeichert als ${summaryPath}`);
    } else {
      console.error(`❌ Unbekannter Modus: ${opts.mode}`);
      printHelp();
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Exception: ${err.message}`);
    printHelp();
    process.exit(2);
  } finally {
    await context.close();
  }
}

main();