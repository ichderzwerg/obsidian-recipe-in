# Recipe In

**An import-only fork of [Recipe Vault](https://github.com/taylorsdugger/obsidian-recipe-vault).**
It does one thing: turn a recipe URL or a photo into a German
[Cooklang](https://cooklang.org/) note in an Obsidian vault.

Upstream Recipe Vault is a full recipe manager — gallery, cook mode, shopping list,
nutrition, Ask AI. This fork keeps only the inbound path and rewrites what it writes for a
Cooklang vault: their commands and settings are stripped from this build (the upstream code
is still bundled), and everything below is what actually remains. For the manager, install
the [original plugin](https://github.com/taylorsdugger/obsidian-recipe-vault).

Both projects are MIT licensed. See [Credits](#credits).

## What it does

- **Import from a URL** — fetches the page, extracts its recipe data, and has an AI model
  rewrite it as a finished note in your target language.
- **Import from a photo** — one or more pages of a cookbook or recipe card, read by a
  vision model, same finished note.
- **Review before saving** — the complete note in an editable textarea, a warning when the
  format looks wrong, and an editable file name.
- **Title picture** — a crop dialog right after an import, and the same dialog later on any
  recipe note (*Titelbild setzen oder ändern*).

## Requirements

- Obsidian **1.7.2** or newer, desktop or mobile.
- An AI provider that accepts images, and an API key for it. The Gemini, Groq, OpenCode Go,
  OpenRouter and Ollama presets are set up for that (Gemini's free tier or a free Groq key is
  enough to start); a custom endpoint has to accept image input on `/chat/completions`.
- For the recipe view (servings scaler, timers, step tracking): the **Cooklang Editor**
  community plugin (`cooklang-obsidian`, by death_au, needs Obsidian 1.8.0+). This plugin
  never renders recipes itself — it writes notes that Cooklang Editor owns.

## Installation

**BRAT** (recommended, works on iOS and Android):

1. Install *BRAT* from Community plugins.
2. *Add Beta Plugin* → `ichderzwerg/obsidian-recipe-in` → *Add Plugin*.
3. Enable **Recipe In (import only)**.

**Manual:** put `main.js`, `manifest.json` and `styles.css` from a release into
`<vault>/.obsidian/plugins/recipe-in/` and enable it. The plugin id is `recipe-in`, so it
can sit next to upstream `recipe-vault` without a collision.

## Usage

### From a URL

Ribbon icon *Rezept importieren*, or command **Rezept aus URL importieren**. If the current
selection is a bare URL it is pre-filled. The page is fetched, sent to the provider, and the
result appears for review.

### From a photo

Command **Rezept aus Foto importieren**. Pick one or more pages — several images are treated
as pages of one recipe, in the order shown. On a phone the native sheet offers camera and
photo library.

- Images are downscaled to 1600 px on the long edge (JPEG 0.85) before upload; the
  full-resolution page stays in memory for the title picture.
- HEIC/HEIF (the iPhone default) is transcoded to JPEG, which vision models accept and the
  vault can store.
- The dialog reports how many KB were actually sent.

### Review and save

The second step is the finished note, editable, with the file name above it. A warning box
appears when the note looks like a transcription instead of a recipe — two or more
ingredients without an amount (`@Mehl{}`), two or more numbered steps, or no `= Section =`
heading. Saving writes one `.md` into the recipe folder and, by default, opens it.

### Title picture

After saving, the crop dialog opens on top of the new note:

- Start from the imported pages (native resolution) or the site's lead image.
- Drag the frame, resize from a corner, pick 4:3 / 3:2 / 1:1 / 16:9 / free or *Ganzes Bild*;
  *Anderes Bild…* takes another file, *Überspringen* skips.
- Writes `<Note>.jpg` beside the note (max 1600 px, JPEG 0.9) and `image: "[[<Note>.jpg]]"`
  in the front matter. Drawing through a canvas bakes EXIF rotation into the pixels, so a PDF
  export stays upright.
- An existing title picture is confirmed before being replaced; a crop under 200 px is
  refused.

Later, the same dialog is behind the command **Titelbild setzen oder ändern** and the file
menu entry of the same name — the "I actually cooked this" path, with no import involved.

## What gets written

One Markdown file per recipe in the recipe folder, plus its title picture:

```markdown
---
recipe: true
title: "Kürbiskerntorte"
categories:
  - "[[Recipes]]"
cuisine:
  - "[[Österreichisch]]"
ingredients:
  - "[[Mehl]]"
  - "[[Kürbiskerne]]"
servings: 12
time: 1h30m
created: 2026-11-11
last: 2026-11-11
image: "[[Kürbiskerntorte.jpg]]"
---

= Teig =

@Mehl{250%g} mit @Butter{125%g} verkneten und ~{30%min} kühlen.
```

- `recipe: true` and `title` are enforced, so the note is recognised as a recipe even when
  the model leaves them out; the title always matches the file name.
- `categories`, `cuisine`, `type` and `ingredients` arrive as `[[wikilinks]]` — only the
  `ingredients` list creates real backlinks in Obsidian's graph.
- The body is Cooklang prose, not bullets: `@Zutat{Menge%Einheit}`, `= Section =`,
  `#Cookware{}`, `~{30%min}`.
- No `cssclasses: recipe-note` is stamped, so Cooklang Editor keeps rendering the note.

## Providers

*KI-Anbieter* picks a preset and sets base URL and model in one click. **Every provider has
its own key field**, and only the selected provider's field is shown — switching providers
cannot overwrite a key typed for another one.

| Preset | Base URL | Default model | Cost / quota |
|---|---|---|---|
| Google Gemini (AI Studio) | native `generateContent` API | `gemini-3.6-flash`, fallback `gemini-flash-lite-latest` | free tier, per-project quota |
| Groq | `https://api.groq.com/openai/v1` | `qwen/qwen3.8-27b` | free: ~1 000 requests/day, fast |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | `deepseek-v4.1-flash` | €10/month subscription |
| OpenRouter | `https://openrouter.ai/api/v1` | `google/gemini-3.5-flash-lite` | 50 requests/day free |
| Mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` | billing required; no free keys since Nov 2026 |
| Ollama | `http://localhost:11434/v1` | `qwen3-vl:8b` | local, no quota |
| Another OpenAI-compatible provider | your URL | blank = OpenRouter's default | depends |

Things worth knowing:

- **Google `AQ.` keys work only on the native Gemini endpoint.** They are rejected with
  `401` on the OpenAI-compatible route, which is why Gemini has its own transport; its *Basis-URL*
  is ignored.
- **Groq** is an inference company, unrelated to xAI's *Grok*.
- **OpenCode Go** is a coding subscription that speaks OpenAI-compatible
  `/chat/completions`; this plugin sends the `x-opencode-session` header its relay uses for
  routing and caching. Only the models with image input on that endpoint can read photos:
  `deepseek-v4.1-flash` (default), `glm-5.3-flash`, `mimo-v2.6-flash`/`-pro`, `kimi-k3*`,
  `hy4`, `minimax-m3.1-flash`, `longcat-2.5-free`. Its `gemini-4-argon` and Qwen3.8 models
  speak the Google/Anthropic wire formats and are not reachable from here.
  `GET https://opencode.ai/zen/go/v1/models` is public and lists every model with its
  modalities and endpoint.
- An empty *Modell* field resolves from the endpoint, not from a global default: blank on a
  Groq URL becomes `qwen/qwen3.8-27b`, not an OpenRouter model id.
- Keys are stored **in plain text** in the vault's plugin data.

## Settings

*Settings → Recipe In.* Only these exist in this build.

**Import**

| Setting | What it does |
|---|---|
| KI-Anbieter | provider preset; sets provider, base URL and model |
| API-Schlüssel (*provider*) | one field per provider, only the selected one visible; a key stored by an older version was moved to the provider that was selected at the time |
| Modell | model id; blank = the endpoint's default |
| Sprache der Rezepte | language the note is written in, even when the source differs (default `Deutsch`) |
| Gründlich nachdenken (Gemini) | Gemini only: let the model reason first — slower, tighter Cooklang. Off is roughly twice as fast |

**Speichern**

| Setting | What it does |
|---|---|
| Speicherordner | folder for new notes; blank = vault root |
| Angelegtes Rezept öffnen | open the note right after saving (default on). Off: it is only filed |

**Erweitert**

| Setting | What it does |
|---|---|
| Basis-URL | OpenAI-compatible endpoints only; blank = OpenRouter; LAN Ollama = `http://<nas-ip>:11434/v1` |
| Zeitlimit pro Versuch | seconds per attempt (15–600, default 90); retries and the fallback model get their own |
| Proxy-Fallback für blockierte Seiten | if the page cannot be fetched directly, retry through `r.jina.ai`, then `api.allorigins.win` |
| HTML-Entities umwandeln | decode `&amp;`-style entities in imported text |
| Debug-Protokoll | verbose logging to the developer console |

## Resilience

- Each attempt has its own timeout, so a retry never races an already-rejected timer.
- `429`/`5xx` are retried twice with backoff, honouring the server's `retryDelay`; then
  Gemini gets one try on `gemini-flash-lite-latest` — an alias, not a pinned id, because a
  pinned lite model is often the one that is busy at that moment.
- An overall watchdog at 4× the attempt limit stops a stalled socket from leaving the dialog
  spinning with no error at all.
- Error texts name the cause (rejected key, quota, missing model, blocked request) and, on
  Gemini, the `finishReason` and token counts — the only diagnostic available on a phone.
- A note that looks like a transcription is flagged in the review step instead of being saved
  silently.
- Photo picking goes through one helper that keeps the file input attached to the document —
  a detached input can lose its change event on iOS, which made the first pick do nothing —
  and reports an empty hand-off instead of ignoring it.

## Known limits

- Ingredient links are not canonicalised against existing notes, so `[[Kartoffel]]` and
  `[[Kartoffeln]]` can both appear.
- Durations that exist only in prose ("etwa 40 Minuten einkochen") sometimes arrive without a
  `~{40%min}` timer.
- OCR-level slips on photos are possible; that is what the review step is for.
- Free tiers may use submitted content to improve their services — Google states this for
  Gemini's free tier. A local Ollama model avoids it.

## Network use and privacy

- The recipe page is fetched directly by Obsidian. With *Proxy-Fallback* on, a failed fetch
  is retried through `r.jina.ai` and `api.allorigins.win`; those services see the URL.
- Page text or the photo goes only to the provider you selected. Nothing else is sent
  anywhere, and there is no telemetry.
- Keys and settings live in `.obsidian/plugins/recipe-in/data.json` in plain text, so they
  travel with the vault whenever the plugin folder is synced.

## Development

```bash
npm ci
npm run build     # tailwind, tsc --noEmit, esbuild -> main.js
npx vitest run    # 500+ tests, no vault needed
```

Where the fork differs from upstream:

- `src/ai/providers.ts` — both wire formats (native Gemini, OpenAI-compatible), retries,
  per-attempt timeouts, fallback model, readable German errors
- `src/ai/prompt.ts` — the single import prompt (target language, date, optional source URL)
- `src/modal-import-note.ts` — source → review → save dialog
- `src/modal-hero-image.ts` — the crop dialog, import path and standalone path
- `src/utils/file-picker.ts` — the one place a file picker is opened
- `src/settings.ts` — presets, per-provider keys, the curated settings tab
- `src/main.ts` — `openImportModal`, `importNoteFromUrl`, `importNoteFromImages`,
  `saveImportedNote`, `writeHeroImage`, `stripNonImportCommands`

## Credits

Forked from [taylorsdugger/obsidian-recipe-vault](https://github.com/taylorsdugger/obsidian-recipe-vault)
at 1.4.1 — MIT, © Taylor Dugger. The import flow, the AI transports, the review step and the
German Cooklang output are this fork's changes. Everything removed, and every feature not
described above, is upstream's work and documented in
[its README](https://github.com/taylorsdugger/obsidian-recipe-vault#readme).

MIT licensed — see [LICENSE](LICENSE).
