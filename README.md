# sbb-atlassian-connect

Automatisiertes Herunterladen, Aktualisieren und Klonen von Confluence-Seiten über die Browser-Session des angemeldeten Benutzers (Playwright/Chromium). Dieses Toolkit besteht aus zwei Node.js-Skripten: [sbb-atlassian-connect/download-atlassian.js](sbb-atlassian-connect/download-atlassian.js) und [sbb-atlassian-connect/upload-atlassian.js](sbb-atlassian-connect/upload-atlassian.js).

Beim Start öffnet das Skript einen Chromium-Browser mit persistentem Profil. Nach der ersten Anmeldung in Confluence bleibt die Session im Profil bestehen. Technisch erfolgt dies über [chromium.launchPersistentContext()](sbb-atlassian-connect/download-atlassian.js:211) bzw. [chromium.launchPersistentContext()](sbb-atlassian-connect/upload-atlassian.js:140).

## Voraussetzungen

- Node.js 18+ und npm
- Internetzugang auf die Confluence-Instanz (z. B. https://confluence.sbb.ch)
- Installation der Abhängigkeiten:

```bash
npm install
npx playwright install chromium
```

Das Browserprofil wird im temporären OS-Verzeichnis unter „chromium-playwright-profile“ abgelegt und beim nächsten Lauf wiederverwendet.

## Download: Seiten und Bäume aus Confluence exportieren

Skript: [sbb-atlassian-connect/download-atlassian.js](sbb-atlassian-connect/download-atlassian.js)

Aufruf (empfohlen):

```bash
node sbb-atlassian-connect/download-atlassian.js <base_url> <page_id> [--recursive=true|false] [--destination=./output] [--ask]
```

Parameter:

- `<base_url>` Basis-URL der Confluence-Site (z. B. https://confluence.sbb.ch)
- `<page_id>` Seiten-ID, die exportiert werden soll

Optionen:

- `--ask`, `-a` Interaktiver Modus: fragt alle Parameter ab
- `--recursive`, `-r true`/`false` Ob Kindseiten rekursiv geladen werden (Standard: true)
- `--destination`, `-d` Zielverzeichnis für XML-Dateien (Standard: aktuelles Verzeichnis)
- `--help`, `-h` Hilfe anzeigen

Beispiele:

```bash
node sbb-atlassian-connect/download-atlassian.js https://confluence.sbb.ch 3273443858 --recursive=false --destination=./output
node sbb-atlassian-connect/download-atlassian.js --ask
```

Ergebnisstruktur:

- Für jede Seite wird die Confluence-„storage“-Repräsentation als XML gespeichert: `page_<ID>_<bis_zu_5_Begriffe>.xml`
- Bei rekursivem Export wird für jeden Knoten zusätzlich ein Ordner mit dem gleichen Basenamen angelegt, der die Kindseiten enthält
- Eine Manifestdatei `tree.json` beschreibt die komplette Seitenhierarchie inkl. Dateipfade

Technische Details:

- Die Inhalte werden im Browserkontext mit fetch gegen `/rest/api/content/...` gelesen
- Nach Navigation auf die Zielseite wird durch eine Wartebedingung die korrekte Seite erkannt (Timeout 60s)

## Upload: Inhalte aktualisieren oder als neuen Baum klonen

Skript: [sbb-atlassian-connect/upload-atlassian.js](sbb-atlassian-connect/upload-atlassian.js)

Grundaufruf:

```bash
node sbb-atlassian-connect/upload-atlassian.js --base_url <base_url> [weitere Optionen]
```

Modi:

- update (Standard) Aktualisiert bestehende Seiten
- clone Erstellt eine Kopie eines Baumes unter einer Zielseite

Gemeinsame Optionen:

- `--ask`,` -a` Interaktiver Modus
- `--dry-run` Keine Änderungen, nur geplante Aktionen ausgeben
- `--help`, `-h` Hilfe anzeigen

Update-Modus:

- `--manifest`,` -f` Pfad zur Manifestdatei tree.json (Standard: `./output/tree.json`)
- `--source`, `-s` Verzeichnis der XML-Dateien (Standard: Ordner der Manifestdatei)
- `--page_id`, `-p` Aktualisiert nur eine einzelne Seite und erwartet bei `--source` den Pfad zur konkreten XML-Datei

Beispiele Update:

```bash
# gesamten Baum laut Manifest aktualisieren
node sbb-atlassian-connect/upload-atlassian.js -b https://confluence.sbb.ch --mode=update -f ./output/tree.json -s ./output

# einzelne Seite aktualisieren (XML-Datei angeben)
node sbb-atlassian-connect/upload-atlassian.js -b https://confluence.sbb.ch --page_id=2393644957 -s ./output/page_1336019187_How-to_OpenShift/page_2393644957_High_Availability_Ingress_Traffic_Routing.xml
```

Ergebnisse Update:

- Pro Lauf wird eine `upload-summary.json` erzeugt (bei Einzel-Update im aktuellen Verzeichnis, sonst neben dem Manifest)

Clone-Modus:

- `--root_id`, `-r` ID der Zielseite, unter der der neue Baum angelegt wird (Pflicht)
- --manifest, `-f` Pfad zur Manifestdatei tree.json (Standard: `./output/tree.json`)
- `--source`, `-s` Verzeichnis der XML-Dateien (Standard: Ordner der Manifestdatei)
- `--suffix <suffix>` für doppelte Titel (Standard: `Clone`) – wird nur verwendet, wenn der Titel bereits existiert

Beispiel Clone:

```bash
node sbb-atlassian-connect/upload-atlassian.js -b https://confluence.sbb.ch --mode=clone --root_id=123456789 -f ./output/tree.json -s ./output --suffix=Clone
```

Ergebnisse Clone:

- `upload-summary.json` Liste der erstellten Seiten
- `upload-map.json` Zuordnung Alt-ID → Neu-ID
- `new-tree.json` Manifest des neu erzeugten Baumes (oberste Ebene ist die neu erstellte Wurzel unterhalb von `--root_id`)

## Hinweise zur Authentisierung und Laufzeit

- Die REST-Aufrufe erfolgen relativ (`/rest/api/content/...`) innerhalb der angemeldeten Browser-Session
- Beim ersten Lauf im geöffneten Chromium anmelden; danach bleibt die Session im persistenten Profil erhalten
- Standard-Timeouts für das Finden/Laden einer Seite betragen 60s

## Fehlerbehebung

- 401/403: Session abgelaufen oder fehlende Berechtigungen – Browserfenster offen lassen und neu anmelden
- 404: Seite existiert nicht oder ist nicht sichtbar – ID prüfen
- Duplikate beim Clone: Das Skript hängt ein Suffix an oder nummeriert weiter, bis ein eindeutiger Titel gefunden ist
- Proxy/VPN: Sicherstellen, dass Confluence erreichbar ist

## Bekannte Besonderheiten

- Die Hilfeausgabe im Download-Skript zeigt „download-page.js“ – der korrekte Dateiname ist [sbb-atlassian-connect/download-atlassian.js](sbb-atlassian-connect/download-atlassian.js). Ausserdem ist die empfohlene Positionsreihenfolge <base_url> <page_id>.

## Entwicklung

- Abhängigkeiten und Skripte sind in [sbb-atlassian-connect/package.json](sbb-atlassian-connect/package.json) definiert
- Das Browserprofil wird in einem OS-Temp-Ordner wiederverwendet, sodass lokale Logins erhalten bleiben
