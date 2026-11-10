/**
 * The one prompt used for every import — photo, pasted text, or a scraped page.
 *
 * It asks for the finished note (front matter + Cooklang body) rather than a
 * JSON blob, because the body has to read like a recipe, not like a list: the
 * ingredient markup is woven into the sentences. Everything the vault needs
 * (recipe: true, [[Recipes]], ingredient wikilinks) is part of the contract.
 */

export interface ImportPromptOptions {
  /** Target language for the finished note, e.g. "Deutsch". */
  language: string;
  /** ISO date for created/last. */
  today: string;
  /** Source URL, when importing from the web. */
  sourceUrl?: string;
}

export function buildImportPrompt(opts: ImportPromptOptions): string {
  const source = opts.sourceUrl
    ? `\nDie Quelle ist diese URL — trage sie als url: ein:\n${opts.sourceUrl}\n`
    : "\nDie Quelle ist ein Foto / eine eingescannte Seite. Lass url: leer.\n";

  return `Du bist Rezept-Redakteur für einen Obsidian-Vault. Du bekommst ein Rezept als Bild
oder als Text. Schreibe daraus eine fertige Rezeptnotiz.

ZIELSPRACHE: ${opts.language}. Ist der Inhalt in einer anderen Sprache, übersetze ihn.
Mengen bleiben exakt erhalten (Brüche wie 1/2 schreiben, nicht runden).
${source}
AUSGABE — genau dieses Format, ohne Code-Fences, ohne Kommentar davor oder danach:

---
recipe: true
title: <Name des Gerichts>
categories:
  - "[[Recipes]]"
cuisine:
  - "[[<Küche, z.B. Italienisch>]]"
type:
  - "[[<Kategorie, z.B. Pasta / Hauptgericht / Kuchen>]]"
ingredients:
  - "[[<Zutat>]]"
author:
url:
rating:
servings: <ganze Zahl>
time: <z.B. 45m oder 1h30m>
created: ${opts.today}
last: ${opts.today}
---
= <Abschnitt> =

<Fließtext mit @Zutat{Menge%Einheit}>

= <Abschnitt> =

<weitere Schritte>

> <Notizen, Tipps, Haltbarkeit — oder diese Zeile weglassen>

REGELN
1. Cooklang: @Zutat{Menge%Einheit} im Fließtext, z.B. @Zwiebel{2}, @Butter{125%g},
   @Milch{250%ml}, @Knoblauch{3%Zehen}, @Salz{1%Prise}. Ohne bekannte Menge: @Pfeffer{}.
   Zwischen Menge und Einheit immer ein Prozentzeichen.
2. Nach einer schließenden Klammer IMMER ein Leerzeichen: "@Thymian{1%EL} Blätter",
   nicht "@Thymian{1%EL}blättern".
3. In den Klammern steht NUR Menge und Einheit, niemals ein Komma oder ein Zusatz:
   "@Hähnchen{1%Stück}", nicht "@Hähnchen{1%ganzes, ca. 1,6 kg}". Zusätze gehören in
   den Fließtext dahinter.
3. Jede Zutat aus dem Frontmatter muss im Text mindestens einmal als @Zutat stehen —
   genau einmal mit Menge, weitere Erwähnungen ohne Klammern.
4. ingredients: deutsche Grundform, großgeschrieben, ohne Mengen und Zusätze.
   "2 große Zwiebeln, fein gewürfelt" wird zu [[Zwiebel]]. Keine Duplikate, keine Artikel.
5. Kochgeschirr als #Pfanne{} / #Topf{} / #Ofen{}, Garzeiten als ~{35%min}.
6. Abschnitte mit = Name = (ein Gleichheitszeichen je Seite, Leerzeichen davor und danach).
7. Nichts erfinden: keine Mengen, Zeiten oder Zutaten ergänzen. Unklare Stellen weglassen.
8. servings ist eine ganze Zahl. Fehlt die Angabe, schätze sie aus den Mengen.
9. cuisine/type nur füllen, wenn erkennbar; sonst leere Liste ([]).
10. title ist der reine Gerichtename, ohne Jahr, Blogname oder Werbefloskeln.
11. Keine Überschrift "# ..." im Body — der Dateiname ist der Titel.
12. Gib ausschließlich die Notiz aus. Keine Erklärung, keine Rückfrage.`;
}

/** Prompt used when the source is already structured text (a scraped page). */
export function buildTextImportPrompt(opts: ImportPromptOptions): string {
  return `${buildImportPrompt(opts)}

Die Rezeptdaten unten sind aus der Webseite ausgelesen. Übernimm Zutaten und Schritte
sinngemäß und vollständig; formuliere die Schritte als Fließtext, nicht als Liste.`;
}
