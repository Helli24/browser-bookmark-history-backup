# Chrome Backup – Lesezeichen & Verlauf

Chrome-Extension (Manifest V3), die einmal täglich Lesezeichen und Browserverlauf
in einen frei wählbaren Ordner schreibt – und nebenbei die Frage beantwortet,
die der Chrome-Verlauf nicht beantworten kann:

> „Wann war ich das erste Mal auf `github.com/xyz`?"

Chrome wirft Besuchsdaten nach etwa 90 Tagen weg. Der **Seiten-Index** dieser
Extension wächst dagegen dauerhaft weiter – eine Zeile pro URL mit Erstbesuch,
letztem Besuch und Anzahl der Aufrufe.

## Installation

1. `chrome://extensions` öffnen
2. Oben rechts **Entwicklermodus** einschalten
3. **Entpackte Erweiterung laden** → den Ordner `extension/` auswählen
4. Auf das Icon klicken → **Einstellungen** → **Ordner auswählen…**

Der Ordner darf überall liegen, auch auf einer zweiten Partition, z. B.
`D:\Chrome Backup`. Chrome fragt einmal nach der Freigabe.

## Was im Zielordner entsteht

```
D:\Chrome Backup\
├── Lesezeichen\
│   ├── lesezeichen-2026-09-13.json     vollständiger Baum, gut vergleichbar
│   └── lesezeichen-2026-09-13.html     Netscape-Format, in Chrome importierbar
├── Verlauf\
│   └── verlauf-2026-09-13.txt          Uhrzeit, Titel und URL jedes Aufrufs
└── Index\
    ├── seiten-index.csv                kumulativ, öffnet sich in Excel
    └── seiten-index.jsonl              kumulativ, maschinenlesbar
```

Die Tagesdateien unterliegen der eingestellten Aufbewahrungsfrist (Standard 365
Tage, `0` heißt: nie löschen). Der Index wird nie gelöscht.

## Suche

Im Popup und ausführlicher in den Einstellungen. Gesucht wird über die **komplette
URL samt Pfad** sowie den Seitentitel. Schema und `www.` sind egal:

| Eingabe | findet u. a. |
|---|---|
| `github.com/anthropics` | `https://github.com/anthropics/claude-code` |
| `/pull/` | jede Pull-Request-Seite, die je offen war |
| `jira` | Treffer im Host, im Pfad oder im Titel |

Sortiert wird nach ältestem Erstbesuch – das ist meistens die gesuchte Antwort.

## Die eine Einschränkung

Chrome vergisst die Ordnerfreigabe nach einem **Neustart des Browsers**. Der
Zeitplan kann dann nicht ungefragt auf die Platte schreiben.

Es geht dabei nichts verloren: Die fertige Sicherung wandert in eine Warteschlange,
das Icon bekommt ein `!`, und beim nächsten Klick wird alles nachgeholt. Läuft dein
Chrome tagelang durch, merkst du davon nie etwas.

Wer das ganz loswerden will, braucht einen Native-Messaging-Host – ein kleines
lokales Skript, das Chrome beim Sichern startet. Das ist bewusst *nicht* Teil
dieses Projekts, weil es Setup auf jedem Rechner erfordert.

## Wiederherstellung

**Lesezeichen:** `chrome://bookmarks` → Menü ⋮ → *Lesezeichen importieren* → die
`.html` aus `Lesezeichen\` wählen.

**Index nach einer Neuinstallation:** Einstellungen → *Index aus dem Backup-Ordner
einlesen*. Liest `Index\seiten-index.jsonl` zurück, der Erstbesuch bleibt erhalten.

## Aufbau

| Datei | Zweck |
|---|---|
| `sw.js` | Service Worker: Zeitplan, Nachholen verpasster Läufe, Nachrichten |
| `lib/collect.js` | Chrome-APIs auslesen, Dateiformate erzeugen |
| `lib/db.js` | IndexedDB: Ordner-Handle und Seiten-Index |
| `lib/run.js` | Ablauf: bauen, schreiben, aufräumen, Warteschlange |
| `lib/ui.js` | Gemeinsames für Popup und Optionen |
| `options.*` | Einstellungen, Suche, Wartung |
| `popup.*` | Status, schnelle Suche, sofort sichern |

Berechtigungen: `bookmarks`, `history`, `storage`, `alarms`, `unlimitedStorage`.
Kein Netzwerkzugriff – die Extension redet mit keinem Server, alle Daten bleiben
auf dem Rechner.

## Bekannte Grenzen

- Der Index kann rückwirkend nur erfassen, was Chrome beim ersten Lauf noch hat
  (~90 Tage). Ab dann lückenlos.
- Nur der **lokale** Verlauf. Synchronisierte Verläufe anderer Geräte sind für
  Extensions nicht zugänglich.
- Inkognito-Sitzungen tauchen nicht auf.
- Bei jedem Lauf wird der komplette Index neu geschrieben. Bei sehr großen
  Indizes (>200.000 Seiten) sind das einige zehn MB pro Tag.
