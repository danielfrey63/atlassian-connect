import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";

const PROFILE_DIR = path.join(os.tmpdir(), "chromium-playwright-profile");

// ------------------------------
// CLI
// ------------------------------
function printHelp() {
  console.log(
    [
      "Usage (PowerShell, CMD, Shell):",
      "  cd atlassian-connect",
      "  node atlassian-download.js <base_url> <page_id> [options]",
      "",
      "Parameters (positional):",
      "  <base_url>           Position 1, mandatory base URL of the Confluence site (e.g. https://confluence.my-company.ch)",
      "  <page_id>            Position 2, mandatory page ID to download (see URL of page that contains the ID)",
      "",
      "Options:",
      "  --ask, -a           Interactive mode: prompts for all parameters",
      "  --recursive, -r     Whether to download recursively (default: true)",
      "  --destination, -d   Directory where to save files (default: current directory)",
      "  --format, -f        Export format: xml | md | both (default: xml)",
      "  --help, -h          Show this help message",
      "",
      "Examples:",
      "  node atlassian-download.js https://confluence.my-company.ch 3273443858 --recursive=false --destination=./output --format=md",
      "  node atlassian-download.js --ask",
    ].join("\n")
  );
}

function parseArgs(args) {
  const opts = {
    ask: false,
    recursive: true,
    destination: process.cwd(),
    base_url: null,
    page_id: null,
    help: false,
    format: "xml", // xml | md | both
    unknown: [],
  };

  function getValue(arg) {
    const index = arg.indexOf("=");
    return index >= 0 ? arg.substring(index + 1) : null;
  }

  let positional = [];
  let expectBaseUrl = false,
    expectPageId = false,
    expectDest = false,
    expectRec = false,
    expectFormat = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (expectBaseUrl) {
      opts.base_url = arg;
      expectBaseUrl = false;
      continue;
    }
    if (expectPageId) {
      opts.page_id = arg;
      expectPageId = false;
      continue;
    }
    if (expectDest) {
      opts.destination = arg;
      expectDest = false;
      continue;
    }
    if (expectRec) {
      opts.recursive = arg.toLowerCase() === "true";
      expectRec = false;
      continue;
    }
    if (expectFormat) {
      opts.format = (arg || "xml").toLowerCase();
      expectFormat = false;
      continue;
    }

    if (arg === "--ask" || arg === "-a") {
      opts.ask = true;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--base_url") {
      expectBaseUrl = true;
    } else if (arg.startsWith("--base_url=")) {
      opts.base_url = getValue(arg);
    } else if (arg === "-b") {
      expectBaseUrl = true;
    } else if (arg.startsWith("-b=")) {
      opts.base_url = getValue(arg);
    } else if (arg === "--page_id") {
      expectPageId = true;
    } else if (arg.startsWith("--page_id=")) {
      opts.page_id = getValue(arg);
    } else if (arg === "-p") {
      expectPageId = true;
    } else if (arg.startsWith("-p=")) {
      opts.page_id = getValue(arg);
    } else if (arg === "--recursive") {
      expectRec = true;
    } else if (arg.startsWith("--recursive=")) {
      const val = getValue(arg);
      opts.recursive = val ? val.toLowerCase() === "true" : true;
    } else if (arg === "-r") {
      expectRec = true;
    } else if (arg.startsWith("-r=")) {
      const val = getValue(arg);
      opts.recursive = val ? val.toLowerCase() === "true" : true;
    } else if (arg === "--destination") {
      expectDest = true;
    } else if (arg.startsWith("--destination=")) {
      opts.destination = getValue(arg) || opts.destination;
    } else if (arg === "-d") {
      expectDest = true;
    } else if (arg.startsWith("-d=")) {
      opts.destination = getValue(arg) || opts.destination;
    } else if (arg === "--format") {
      expectFormat = true;
    } else if (arg.startsWith("--format=")) {
      opts.format = (getValue(arg) || "xml").toLowerCase();
    } else if (arg === "-f") {
      expectFormat = true;
    } else if (arg.startsWith("-f=")) {
      opts.format = (getValue(arg) || "xml").toLowerCase();
    } else {
      // Treat any unknown flag (starting with '-') as an error, otherwise a positional argument
      if (/^-{1,2}[A-Za-z0-9_-]+/.test(arg)) {
        opts.unknown.push(arg);
      } else {
        positional.push(arg);
      }
    }
  }

  // Only assign positional arguments if toggles were not set
  if (!opts.base_url && positional.length > 0) {
    opts.base_url = positional.shift();
  }
  if (!opts.page_id && positional.length > 0) {
    opts.page_id = positional.shift();
  }

  // Normalize format
  if (!["xml", "md", "both"].includes(opts.format)) {
    opts.format = "xml";
  }

  return opts;
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

// ------------------------------
// Helpers
// ------------------------------
function sanitizeTitle(title) {
  return title.replace(/[\\/:*?"<>|]/g, "_").split(/[_ ]+/).slice(0, 5).join("_");
}

function sanitizeFilename(name) {
  return (name || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/,+/g, "_");
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
  return (respJson.results || []).map((child) => ({
    id: child.id,
    title: child.title,
  }));
}

// ------------------------------
// MD conversion executed in browser
// ------------------------------
async function convertXmlToMarkdown(page, xml) {
  const result = await page.evaluate((xmlText) => {
    function parseXmlWithNamespaces(xmlInput) {
      const withNs =
        '<?xml version="1.0"?>' +
        '<root xmlns:ac="http://atlassian.com/content" xmlns:ri="http://atlassian.com/resource">' +
        xmlInput +
        "</root>";
      const parser = new DOMParser();
      let doc = parser.parseFromString(withNs, "application/xml");
      const parserErr = doc.querySelector("parsererror");
      if (parserErr) {
        // Fallback: parse as HTML to still traverse content
        const htmlDoc = parser.parseFromString(xmlInput, "text/html");
        return { doc: htmlDoc, isHtml: true };
      }
      return { doc, isHtml: false };
    }

    const refs = []; // { type: 'attachment'|'external', name, url }
    const { doc, isHtml } = parseXmlWithNamespaces(xmlText);

    // Utility to get text content
    function getText(node) {
      return node ? (node.textContent || "").trim() : "";
    }

    // Handle ac:image
    function handleAcImage(node) {
      const attach = node.querySelector("ri\\:attachment");
      const url = node.querySelector("ri\\:url");
      const alt = node.getAttribute("alt") || getText(node);
      if (attach) {
        const name = attach.getAttribute("ri:filename") || attach.getAttribute("ri\\:filename") || getText(attach);
        if (name) {
          refs.push({ type: "attachment", name });
          return `![${alt || name}](ATTACH://${name})`;
        }
      }
      if (url) {
        const u = url.getAttribute("ri:value") || url.getAttribute("ri\\:value") || getText(url);
        if (u) {
          refs.push({ type: "external", url: u });
          return `![${alt || ""}](${u})`;
        }
      }
      return ""; // Unknown image form
    }

    // Handle ac:link to attachments
    function handleAcLink(node) {
      const attach = node.querySelector("ri\\:attachment");
      const bodyText = node.querySelector("ac\\:plain-text-link-body") || node;
      const text = getText(bodyText) || "attachment";
      if (attach) {
        const name = attach.getAttribute("ri:filename") || attach.getAttribute("ri\\:filename") || getText(attach);
        if (name) {
          refs.push({ type: "attachment", name });
          return `[${text}](ATTACH://${name})`;
        }
      }
      return text;
    }

    // Handle ac:structured-macro (image variants, thumbnail, view-file)
    function handleStructuredMacro(node) {
      const macroName = node.getAttribute("ac:name") || node.getAttribute("ac\\:name") || "";
      const params = {};
      node.querySelectorAll("ac\\:parameter").forEach((p) => {
        const nm = p.getAttribute("ac:name") || p.getAttribute("ac\\:name") || "";
        params[nm] = getText(p);
      });
      const alt = params.alt || "";
      const nameCandidate = params.attachment || params.file || params.name;
      const urlCandidate = params.url;

      if (macroName === "image" || macroName === "thumbnail" || macroName === "view-file") {
        if (nameCandidate) {
          refs.push({ type: "attachment", name: nameCandidate });
          return `![${alt || nameCandidate}](ATTACH://${nameCandidate})`;
        }
        if (urlCandidate) {
          refs.push({ type: "external", url: urlCandidate });
          return `![${alt || ""}](${urlCandidate})`;
        }
      }
      // Default: render inner content with block separation if rich-text-body present
      const body = node.querySelector("ac\\:rich-text-body");
      if (body) {
        return renderChildren(body) + "\n\n";
      }
      return renderChildren(node) + "\n\n";
    }

    // Generic inline formatting
    function formatInline(node) {
      const tag = (node.tagName || "").toLowerCase();
      if (tag === "strong" || tag === "b") return `**${getText(node)}**`;
      if (tag === "em" || tag === "i") return `*${getText(node)}*`;
      if (tag === "code") return "`" + getText(node) + "`";
      return getText(node);
    }

    // Table rendering with explicit <br/> handling inside cells
    function escapeMdTableCell(text) {
      return (text || "").replace(/\|/g, "\\|");
    }

    function renderCell(cell) {
      let out = "";
      cell.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue || "";
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = (child.tagName || "").toLowerCase();
          if (tag === "br") {
            out += "<br/>";
          } else if (tag === "p") {
            const inner = renderCell(child).trim();
            out += inner ? inner + "<br/>" : "";
          } else if (tag === "strong" || tag === "b" || tag === "em" || tag === "i" || tag === "code" || tag === "span") {
            out += formatInline(child);
          } else if (tag === "a") {
            const href = child.getAttribute("href") || "";
            const text = (child.textContent || "").trim() || href;
            out += href ? `[${text}](${href})` : text;
          } else if (tag === "ul" || tag === "ol") {
            const isOl = tag === "ol";
            let idx = 1;
            const items = Array.from(child.querySelectorAll(":scope > li"))
              .map((li) => {
                const t = (li.textContent || "").trim();
                return t ? (isOl ? `${idx++}. ${t}` : `- ${t}`) : "";
              })
              .filter(Boolean);
            out += items.join("<br/>");
          } else {
            // default: recurse into nested elements
            out += renderCell(child);
          }
        }
      });
      // Normalize whitespace and consolidate excessive breaks
      out = out.replace(/\n+/g, " ").replace(/(?:\s*<br\/>\s*){3,}/g, "<br/><br/>");
      return escapeMdTableCell(out.trim());
    }

    function renderTable(tbl) {
      const rows = Array.from(tbl.querySelectorAll("tr"));
      if (!rows.length) return "";
      let md = "";
      const firstCells = Array.from(rows[0].querySelectorAll("th,td")).map((c) => renderCell(c));
      md += "| " + firstCells.join(" | ") + " |\n";
      md += "|" + firstCells.map(() => " --- ").join("|") + "|\n";
      for (let i = 1; i < rows.length; i++) {
        const cells = Array.from(rows[i].querySelectorAll("th,td")).map((c) => renderCell(c));
        md += "| " + cells.join(" | ") + " |\n";
      }
      return md + "\n";
    }

    // Helpers to manage block separation and child rendering
    function isBlockTag(tag) {
      return [
        "div","section","article","header","footer","aside","main","nav",
        "ac:rich-text-body","ac:layout","ac:layout-section","ac:structured-macro"
      ].includes(tag);
    }

    function renderChildren(node) {
      let out = "";
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          out += renderBlock(child);
        }
      });
      return out;
    }

    function renderBlock(node) {
      const tag = (node.tagName || "").toLowerCase();

      // Confluence specific
      if (tag === "ac:image") return handleAcImage(node);
      if (tag === "ac:link") return handleAcLink(node);
      if (tag === "ac:structured-macro") return handleStructuredMacro(node);

      // Headings
      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag.slice(1));
        return "#".repeat(level) + " " + renderChildren(node).trim() + "\n\n";
      }
      if (tag === "p") {
        const inner = renderChildren(node).trim();
        return inner ? inner + "\n\n" : "";
      }
      if (tag === "br") {
        return "  \n";
      }
      if (tag === "pre") {
        return "```\n" + (node.textContent || "") + "\n```\n\n";
      }
      if (tag === "ul") {
        return (
          Array.from(node.querySelectorAll(":scope > li"))
            .map((li) => "- " + (li.textContent || "").trim())
            .join("\n") + "\n\n"
        );
      }
      if (tag === "ol") {
        let idx = 1;
        return (
          Array.from(node.querySelectorAll(":scope > li"))
            .map((li) => (idx++) + ". " + (li.textContent || "").trim())
            .join("\n") + "\n\n"
        );
      }
      if (tag === "table") {
        return renderTable(node);
      }
      if (tag === "a") {
        const href = node.getAttribute("href") || "";
        const text = (node.textContent || "").trim() || href;
        return href ? `[${text}](${href})` : text;
      }

      // Inline formats inside blocks
      const inlineTags = ["strong", "b", "em", "i", "code", "span"];
      if (inlineTags.includes(tag)) return formatInline(node);

      // Generic Confluence containers: ensure block separation
      if (isBlockTag(tag)) {
        const inner = renderChildren(node);
        return inner ? inner + "\n\n" : "";
      }

      // Default: recurse into children without forcing block separation
      return renderChildren(node);
    }

    // Collect top-level blocks under our synthetic root (XML) or body (HTML)
    let root = doc.querySelector("root") || doc.body || doc;
    let md = "";
    Array.from(root.childNodes).forEach((child) => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        md += renderBlock(child);
      } else if (child.nodeType === Node.TEXT_NODE) {
        const t = (child.nodeValue || "").trim();
        if (t) md += t + "\n\n";
      }
    });

    return { markdown: md, refs };
  }, xml);

  return result;
}

// ------------------------------
// Attachments
// ------------------------------
async function fetchAttachments(page, pageId) {
  const url = `/rest/api/content/${pageId}/child/attachment?limit=1000&expand=version,_links`;
  const respText = await page.evaluate(async (url) => {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) throw new Error(`Attachment fetch HTTP ${resp.status}`);
    return await resp.text();
  }, url);
  const j = JSON.parse(respText);
  const results = j.results || [];
  return results.map((item) => {
    const title = item.title || "";
    const download = item._links?.download || "";
    const contentType = item.metadata?.mediaType || item.type || "";
    return {
      title,
      download, // relative like /download/attachments/ID/filename.png
      contentType,
    };
  });
}

async function downloadAttachmentBinary(page, fullUrl) {
  try {
    // Use Playwright's request context instead of browser fetch to avoid response cloning issues
    const response = await page.request.get(fullUrl);
    
    console.log(`    Response status: ${response.status()} ${response.statusText()}`);
    
    if (!response.ok()) {
      throw new Error(`HTTP ${response.status()}: ${response.statusText()}`);
    }
    
    const buffer = await response.body();
    console.log(`    Downloaded ${buffer.length} bytes`);
    
    if (buffer.length === 0) {
      throw new Error(`Response body is empty (0 bytes) - possible authentication or access issue`);
    }
    
    // Convert to base64
    const base64 = buffer.toString('base64');
    console.log(`    Base64 length: ${base64.length}`);
    
    const contentType = response.headers()['content-type'] || 'application/octet-stream';
    
    return {
      base64,
      size: buffer.length,
      contentType,
    };
  } catch (error) {
    console.error(`    Error downloading: ${error.message}`);
    throw error;
  }
}

function replaceAttachPlaceholders(markdown, replacements) {
  let md = markdown;
  for (const rep of replacements) {
    const original = rep.originalName;
    const sanitized = rep.sanitizedName;
    const encoded = encodeURIComponent(original);

    const local = rep.localRelPath;
    const server = rep.serverUrl;

    // Replace ATTACH://original
    md = md.replace(new RegExp(`ATTACH://${escapeRegex(original)}`, "g"), local || server || "");
    // Replace ATTACH://sanitized
    md = md.replace(new RegExp(`ATTACH://${escapeRegex(sanitized)}`, "g"), local || server || "");
    // Replace ATTACH://encoded
    md = md.replace(new RegExp(`ATTACH://${escapeRegex(encoded)}`, "g"), local || server || "");
  }
  return md;
}

function escapeRegex(s) {
  return (s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function updateXmlAttachmentReferences(xmlContent, attachmentMap) {
  let updatedXml = xmlContent;
  
  // Replace ri:attachment elements with local file references
  // Pattern: <ri:attachment ri:filename="filename.ext" />
  for (const [originalName, localPath] of Object.entries(attachmentMap)) {
    // Escape special XML characters in filenames
    const escapedOriginal = originalName
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    
    // Build regex to match ri:attachment elements with this filename
    const pattern = new RegExp(
      `<ri:attachment\\s+ri:filename="${escapeRegex(escapedOriginal)}"[^>]*/>`,
      'g'
    );
    
    // Replace with local path reference
    updatedXml = updatedXml.replace(pattern, (match) => {
      // Preserve other attributes if present, just update the filename to local path
      return match.replace(
        `ri:filename="${escapedOriginal}"`,
        `ri:filename="${localPath}"`
      );
    });
  }
  
  return updatedXml;
}

// ------------------------------
// Core download
// ------------------------------
async function downloadPageInternal(
  pageId,
  baseUrl,
  recursive,
  destination,
  parentRelPath,
  page,
  format
) {
  const targetUrl = `${baseUrl}/pages/viewpage.action?pageId=${pageId}`;
  console.log(`Opening ${targetUrl} ...`);

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
  console.log(`Current URL: ${currentUrl}`);
  if (!currentUrl.includes(pageId)) {
    console.warn(`Redirect detected, but pageId remains valid.`);
  }

  console.log("Fetching REST API data in browser context ...");
  const jsonText = await page.evaluate(async (pid) => {
    const url = `/rest/api/content/${pid}?expand=body.storage,version`;
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  }, pageId);

  const data = JSON.parse(jsonText);
  const xml = data.body?.storage?.value || "";
  const safeTitle = sanitizeTitle(data.title || "");
  const baseName = `${pageId}_${safeTitle}`;

  // Always write XML if format is xml or both
  if (format === "xml" || format === "both") {
    let finalXml = xml;
    const attachmentMap = {};
    
    // Fetch and download attachments for XML format
    let attachments = [];
    try {
      attachments = await fetchAttachments(page, pageId);
    } catch (err) {
      console.warn(`Could not fetch attachments for XML: ${err.message}`);
    }
    
    // Only create attachment directory and download if there are attachments
    if (attachments.length > 0) {
      const attachDirRel = path.join(parentRelPath, baseName);
      const attachDirFull = path.resolve(destination, attachDirRel);
      fs.mkdirSync(attachDirFull, { recursive: true });
      console.log(`Created attachment directory: ${attachDirFull}`);
      
      // Download each attachment
      for (const item of attachments) {
        const title = item.title || "";
        const sanitizedTitle = sanitizeFilename(title);
        
        // Build URL carefully to avoid double slashes
        let serverUrl;
        if (item.download) {
          // Combine baseUrl and download path, then clean up any double slashes
          serverUrl = `${baseUrl}${item.download}`.replace(/([^:])\/\//g, '$1/');
        } else {
          serverUrl = `${baseUrl}/download/attachments/${pageId}/${encodeURIComponent(title)}`.replace(/([^:])\/\//g, '$1/');
        }
        
        if (item.download) {
          try {
            console.log(`  Downloading: ${title} from ${serverUrl}`);
            const { base64, size, contentType } = await downloadAttachmentBinary(page, serverUrl);
            
            // Validate download
            if (!base64 || base64.length === 0) {
              throw new Error(`Empty response received (base64 length: ${base64?.length || 0})`);
            }
            
            console.log(`  Downloaded ${size} bytes (base64 length: ${base64.length})`);
            
            let ext = path.extname(sanitizedTitle) || "";
            if (!ext) {
              const ct = (contentType || "").toLowerCase();
              if (ct.includes("png")) ext = ".png";
              else if (ct.includes("jpeg") || ct.includes("jpg")) ext = ".jpg";
              else if (ct.includes("gif")) ext = ".gif";
              else if (ct.includes("webp")) ext = ".webp";
              else if (ct.includes("svg")) ext = ".svg";
              else if (ct.includes("pdf")) ext = ".pdf";
              else if (ct.includes("bmp")) ext = ".bmp";
              else ext = ".bin";
            }
            const baseFile = sanitizedTitle.match(/\.\w+$/) ? sanitizedTitle : sanitizedTitle + ext;
            const localFullPath = path.join(attachDirFull, baseFile);
            
            // Convert base64 to buffer
            const buf = Buffer.from(base64, "base64");
            
            // Validate buffer
            if (buf.length === 0) {
              throw new Error(`Buffer conversion failed - resulted in 0 bytes (base64 length was ${base64.length})`);
            }
            
            console.log(`  Writing ${buf.length} bytes to ${baseFile}`);
            fs.writeFileSync(localFullPath, buf);
            
            // Verify file was written
            const stats = fs.statSync(localFullPath);
            if (stats.size === 0) {
              throw new Error(`File was written but has 0 bytes`);
            }
            
            // Store relative path for XML reference update
            const relPath = path.join(baseName, baseFile).replace(/\\/g, "/");
            attachmentMap[title] = relPath;
            
            console.log(`  ✓ Successfully saved: ${title} (${stats.size} bytes)`);
          } catch (err) {
            console.error(`  ✗ Failed to download attachment ${title}: ${err.message}`);
            console.error(`    URL: ${serverUrl}`);
          }
        }
      }
      
      // Update XML with local attachment references
      if (Object.keys(attachmentMap).length > 0) {
        finalXml = updateXmlAttachmentReferences(xml, attachmentMap);
        console.log(`Updated ${Object.keys(attachmentMap).length} attachment reference(s) in XML`);
      }
    }
    
    const xmlRelPath = path.join(parentRelPath, `${baseName}.xml`);
    const xmlFullPath = path.resolve(destination, xmlRelPath);
    fs.mkdirSync(path.dirname(xmlFullPath), { recursive: true });
    fs.writeFileSync(xmlFullPath, finalXml, "utf-8");
    console.log(`Saved XML: ${xmlFullPath}`);
  }

  // Convert to MD and download assets if requested
  if (format === "md" || format === "both") {
    const { markdown: initialMd, refs } = await convertXmlToMarkdown(page, xml);

    const assetsDirRel = path.join(parentRelPath, `${baseName}_assets`);
    const assetsDirFull = path.resolve(destination, assetsDirRel);
    fs.mkdirSync(assetsDirFull, { recursive: true });

    // Determine which attachments are actually referenced inline
    const usedOriginalNames = new Set(
      (refs || [])
        .filter((r) => r.type === "attachment" && r.name)
        .map((r) => r.name)
    );
    const usedSanitizedNames = new Set(
      Array.from(usedOriginalNames).map((n) => sanitizeFilename(n))
    );
    const usedEncodedNames = new Set(
      Array.from(usedOriginalNames).map((n) => encodeURIComponent(n))
    );

    // Build attachment list from server
    let attachments = [];
    try {
      attachments = await fetchAttachments(page, pageId);
    } catch (err) {
      console.warn(`Could not fetch attachments: ${err.message}`);
    }

    // Download only attachments that are referenced inline in the page
    const downloaded = [];
    for (const item of attachments) {
      const title = item.title || "";
      const sanitizedTitle = sanitizeFilename(title);
      const titleEncoded = encodeURIComponent(title);

      // Filter: only process attachments that are referenced (by original, sanitized or encoded name)
      const isUsed =
        usedOriginalNames.has(title) ||
        usedSanitizedNames.has(sanitizedTitle) ||
        usedEncodedNames.has(titleEncoded);
      if (!isUsed) {
        continue;
      }

      let localRelPath = null;
      const serverUrl = item.download
        ? `${baseUrl}${item.download}`
        : `${baseUrl}/download/attachments/${pageId}/${encodeURIComponent(title)}`;

      if (item.download) {
        try {
          const { base64, contentType } = await downloadAttachmentBinary(page, serverUrl);
          let ext = path.extname(sanitizedTitle) || "";
          if (!ext) {
            const ct = (contentType || "").toLowerCase();
            if (ct.includes("png")) ext = ".png";
            else if (ct.includes("jpeg") || ct.includes("jpg")) ext = ".jpg";
            else if (ct.includes("gif")) ext = ".gif";
            else if (ct.includes("webp")) ext = ".webp";
            else if (ct.includes("svg")) ext = ".svg";
            else if (ct.includes("pdf")) ext = ".pdf";
            else if (ct.includes("bmp")) ext = ".bmp";
            else ext = ".bin";
          }
          const baseFile =
            sanitizedTitle.match(/\.\w+$/) ? sanitizedTitle : sanitizedTitle + ext;
          const localFullPath = path.join(assetsDirFull, baseFile);
          const buf = Buffer.from(base64, "base64");
          fs.writeFileSync(localFullPath, buf);
          localRelPath = "./" + path.join(assetsDirRel, baseFile).replace(/\\/g, "/");
          console.log(`Downloaded attachment: ${title} -> ${localFullPath}`);
        } catch (err) {
          console.warn(`Failed to download ${title}: ${err.message}`);
        }
      }

      downloaded.push({
        title,
        sanitizedTitle,
        localRelPath,
        serverUrl,
        contentType: (item.contentType || "").toLowerCase(),
      });
    }

    // Prepare replacements for ATTACH:// placeholders based on refs
    const replacements = [];
    const uniqueNames = Array.from(
      new Set(
        (refs || [])
          .filter((r) => r.type === "attachment" && r.name)
          .map((r) => r.name)
      )
    );

    for (const originalName of uniqueNames) {
      const sanitizedName = sanitizeFilename(originalName);
      const match =
        downloaded.find((d) => d.title === originalName) ||
        downloaded.find((d) => d.sanitizedTitle === sanitizedName);

      const serverUrl =
        (match && match.serverUrl) ||
        `${baseUrl}/download/attachments/${pageId}/${encodeURIComponent(originalName)}`;

      const localRelPath = match ? match.localRelPath : null;

      replacements.push({
        originalName,
        sanitizedName,
        localRelPath,
        serverUrl,
        success: !!localRelPath,
      });
    }

    let finalMd = replaceAttachPlaceholders(initialMd, replacements);
    // Prepend page title as H1 heading
    finalMd = `# ${data.title}\n\n` + finalMd;

    // Fallback: if there are attachments but no inline refs, append a gallery
    if (uniqueNames.length === 0 && downloaded.length > 0) {
      let gallery = "\n\n## Attachments\n\n";
      const isImage = (d) => {
        const ext = (d.sanitizedTitle.match(/\.\w+$/) || [""])[0].toLowerCase();
        return (
          d.contentType.includes("image/") ||
          [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(ext)
        );
      };
      for (const d of downloaded) {
        const href = d.localRelPath || d.serverUrl || "";
        if (!href) continue;
        if (isImage(d)) {
          gallery += `![${d.title}](${href})\n\n`;
        } else {
          gallery += `- [${d.title}](${href})\n`;
        }
      }
      finalMd += gallery;
    }

    const mdRelPath = path.join(parentRelPath, `${baseName}.md`);
    const mdFullPath = path.resolve(destination, mdRelPath);
    fs.mkdirSync(path.dirname(mdFullPath), { recursive: true });
    fs.writeFileSync(mdFullPath, finalMd, "utf-8");
    console.log(`Saved MD: ${mdFullPath}`);
  }

  const manifestNode = {
    id: pageId,
    title: data.title,
    url: currentUrl,
    // Keep manifest filepath pointing to XML to remain compatible with upload-atlassian.js
    filepath: path.join(parentRelPath, `${baseName}.xml`),
    children: [],
  };

  if (recursive) {
    const children = await fetchChildren(pageId, baseUrl, page);
    if (children.length > 0) {
      // Create sibling directory to store children: "<ID>_5_words"
      const childDirRel = path.join(parentRelPath, baseName);
      const childDirFull = path.resolve(destination, childDirRel);
      fs.mkdirSync(childDirFull, { recursive: true });

      for (const child of children) {
        const childNode = await downloadPageInternal(
          child.id,
          baseUrl,
          true,
          destination,
          childDirRel,
          page,
          format
        );
        manifestNode.children.push(childNode);
      }
    }
  }

  return manifestNode;
}

async function downloadPage(
  pageId,
  baseUrl,
  recursive,
  destination,
  manifest = null,
  parentRelPath = "",
  format = "xml"
) {
  console.log(`Using profile: ${PROFILE_DIR}`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
  });
  const page = await context.newPage();
  
  // Forward browser console logs to Node console
  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') {
      console.error(`[Browser Console] ${text}`);
    } else if (type === 'warn') {
      console.warn(`[Browser Console] ${text}`);
    } else if (text.includes('[Browser]')) {
      // Only show our custom debug logs
      console.log(text);
    }
  });

  try {
    const node = await downloadPageInternal(
      pageId,
      baseUrl,
      recursive,
      destination,
      parentRelPath,
      page,
      format
    );
    return node;
  } finally {
    await context.close();
  }
}

// ------------------------------
// Main
// ------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.help || argv.length === 0) {
    printHelp();
    process.exit(0);
  }

  if (opts.ask) {
    opts.base_url = await prompt("Base URL: ");
    opts.page_id = await prompt("Page ID: ");
    const rec = await prompt("Recursive? (true/false, default true): ");
    if (rec.toLowerCase() === "false") opts.recursive = false;
    const dest = await prompt(`Destination? (default: ${process.cwd()}): `);
    if (dest.trim() !== "") opts.destination = dest.trim();
    const fmt = await prompt("Format (xml|md|both, default xml): ");
    if (fmt.trim()) {
      const f = fmt.trim().toLowerCase();
      if (["xml", "md", "both"].includes(f)) opts.format = f;
    }
  }

  // Validate unknown parameters before proceeding
  if (opts.unknown && opts.unknown.length > 0) {
    console.error("Unknown parameter(s): " + opts.unknown.join(", "));
    printHelp();
    process.exit(1);
  }

  if (!opts.page_id || !opts.base_url) {
    console.error("Missing required parameters: page_id and base_url are mandatory.");
    printHelp();
    process.exit(1);
  }

  try {
    const manifest = await downloadPage(
      opts.page_id,
      opts.base_url,
      opts.recursive,
      opts.destination,
      null,
      "",
      opts.format
    );
    // Write tree.json manifest after download if recursion enabled
    if (opts.recursive) {
      const manifestPath = path.join(opts.destination, "tree.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
      console.log(`Page hierarchy saved as ${manifestPath}`);
    }
  } catch (err) {
    console.error(`Exception: ${err.message}`);
    printHelp();
    process.exit(2);
  }
}

main();
