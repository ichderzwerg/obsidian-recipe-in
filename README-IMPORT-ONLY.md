# Recipe In — import-only fork of Recipe Vault

This is a fork of [taylorsdugger/obsidian-recipe-vault](https://github.com/taylorsdugger/obsidian-recipe-vault)
(MIT) reduced to one job: **get a recipe into an Obsidian vault as a German Cooklang
`.md` note** — from a URL, a photo, or a selection.

Upstream 1.4.1 is the base. The gallery, cook mode, shopping list, nutrition and
Ask-AI features are still in the bundle but their commands and settings are removed.

## What this fork changes

| Area | Upstream | Here |
|---|---|---|
| Output | Markdown bullets, or a `.cook` file with English glue ("Gather … and …") | `.md` with `recipe: true`, `categories: [[Recipes]]`, `ingredients: [[…]]`, Cooklang body in prose |
| AI transport | OpenRouter only (`Authorization: Bearer`) | `gemini` (native API, required for `AQ.` keys) **or** any OpenAI-compatible endpoint |
| Photo prompt | "transcribe, return JSON" | reads the page **and** writes the finished note in a target language |
| Review step | fields (name / ingredients / steps) | the finished note in an editable textarea |
| Note detection | stamps `cssclasses: recipe-note` on import | not stamped, so Cooklang Editor keeps rendering the note |
| Commands | 16 | 2: *Rezept aus URL importieren*, *Rezept aus Foto importieren* |

Source of the changes:

- `src/ai/providers.ts` — both wire formats, error mapping, timeouts
- `src/ai/prompt.ts` — the single import prompt (language, date, source URL)
- `src/modal-import-note.ts` — source → review → save dialog
- `src/main.ts` — `openImportModal`, `importNoteFromUrl`, `importNoteFromImages`,
  `saveImportedNote`, `stripNonImportCommands`
- `src/settings.ts` — provider / key / base URL / model / target language

## Build

```bash
npm ci
npm run build      # main.js, manifest.json, styles.css
```

Build is clean on Node 26 (`tsc` passes; eslint reports 12 warnings inherited from upstream).

## Install

```
<vault>/.obsidian/plugins/recipe-in/
  main.js  manifest.json  styles.css
```

Enable it in *Settings → Community plugins*. Plugin id is `recipe-in`, so it can sit
next to the upstream `recipe-vault` without collisions.

## Settings

*Settings → Recipe In*

- **KI-Anbieter** — `Google Gemini (AI Studio)` or `OpenAI-kompatibel`
- **API-Schlüssel** — Gemini `AQ.`/`AIza…`, an OpenRouter key, or blank for local Ollama
- **Basis-URL** — OpenAI-compatible only; blank = `https://openrouter.ai/api/v1`,
  Ollama = `http://localhost:11434/v1`
- **Modell** — blank = `gemini-3.6-flash` (Gemini) / `google/gemini-3.5-flash-lite` (OpenAI)
- **Zielsprache** — language of the finished note (default `Deutsch`)
- **Denkzeit (Gemini)** — on = model reasons first (slower, tighter Cooklang);
  off ≈ twice as fast, slightly looser format
- **AI request timeout (ms)** — per attempt, default 90 000
- **Recipe save folder** — where notes land (`Recipes` by default)

## Resilience

- Each attempt gets its own timeout, so a retry never eats the previous budget.
- 429/5xx are retried twice with backoff, then one fallback model is tried
  (`gemini-3.1-flash-lite`), turning "overloaded, try later" into a slow success.
- Photos are downscaled to 1600 px / JPEG 0.85 in the dialog before upload — a 4 MB
  phone picture becomes a few hundred KB, which also cuts token cost.

## Known limits

- Ingredient names are not canonicalised against existing `[[…]]` notes yet
  (`Kartoffel` vs `Kartoffeln`), so the graph can gain near-duplicates.
- A source that states times only as prose ("40 Minuten einkochen") may lose the timer.
- Gemini free tier is fine for personal use but sends the photo to Google; the free
  tier's data may be used to improve their products.
- Upstream rewrites `to-cooklang.ts` and the modals regularly; keep this diff small
  and rebase deliberately rather than merging blindly.
