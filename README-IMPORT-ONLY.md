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

- **KI-Anbieter** — one click sets base URL and model: `Google Gemini (AI Studio)`,
  `Groq`, `OpenCode Go`, `OpenRouter`, `Mistral`, `Ollama`, or another
  OpenAI-compatible provider
- **API-Schlüssel (`<provider>`)** — **one field per provider**, and only the field
  of the selected provider is shown. Switching providers can no longer overwrite a
  key you typed for another one. A key stored by an older version moves to the
  provider that was selected at the time. Blank for local Ollama.
- **Basis-URL** — OpenAI-compatible only; blank = `https://openrouter.ai/api/v1`,
  Ollama = `http://localhost:11434/v1`, OpenCode Go = `https://opencode.ai/zen/go/v1`
- **Modell** — blank = the endpoint's default (`gemini-3.6-flash`, Groq →
  `qwen/qwen3.8-27b`, OpenCode Go → `deepseek-v4.1-flash`, OpenRouter →
  `google/gemini-3.5-flash-lite`, Ollama → `qwen3-vl:8b`)
- **Zielsprache** — language of the finished note (default `Deutsch`)
- **Denkzeit (Gemini)** — on = model reasons first (slower, tighter Cooklang);
  off ≈ twice as fast, slightly looser format
- **AI request timeout (ms)** — per attempt, default 90 000
- **Recipe save folder** — where notes land (`Recipes` by default)
- **Angelegtes Rezept öffnen** — on (default): the new note opens right after
  saving, with the title-picture dialog on top of it. Off: the note is only filed.

### OpenCode Go

The Go subscription lane (`https://opencode.ai/zen/go/v1`, bearer auth,
`/chat/completions`) works with the plain OpenAI transport. Two things are
Go-specific:

- Requests carry `x-opencode-session` (a per-import id), which the relay uses for
  routing and prompt caching.
- Only models that serve **chat/completions with image input** can read photos:
  `deepseek-v4.1-flash` (default), `glm-5.3-flash`, `mimo-v2.6-flash`/`-pro`,
  `kimi-k3*`, `hy4`, `minimax-m3.1-flash`, `longcat-2.5-free`. `gemini-4-argon`
  and the Qwen3.8 models speak Google/Anthropic wire formats and are **not**
  reachable through this transport. `GET https://opencode.ai/zen/go/v1/models`
  is public and lists every model with its modalities and endpoint. Go is a paid
  subscription (€10/month) — imports spend that quota.

## Resilience

- Each attempt gets its own timeout, so a retry never eats the previous budget.
- 429/5xx are retried twice with backoff, then one fallback model is tried
  (`gemini-flash-lite-latest`), turning "overloaded, try later" into a slow success.
- Photos are downscaled to 1600 px / JPEG 0.85 in the dialog before upload — a 4 MB
  phone picture becomes a few hundred KB, which also cuts token cost.
- Photo picking goes through one helper (`src/utils/file-picker.ts`) that appends
  the `<input type="file">` to the document instead of leaving it detached. A
  detached input can lose its `change` listener on iOS while the native picker is
  up — the first pick then did nothing and the second one worked. A change event
  that arrives without a file now says so (`Keine Datei erhalten …`) rather than
  silently re-rendering.

## Hero picture

After a successful import, a second dialog offers the title picture:

- **Photo imports** crop from the pages that were just uploaded — at native
  resolution, not from the downscaled copy sent to the model.
- **URL imports** start from the page's own lead image (`og:image`, because
  JSON-LD usually only carries an `#primaryimage` reference).
- Drag the frame, resize from a corner, pick an aspect (4:3 default, 3:2, 1:1,
  16:9, free) or "Ganzes Bild". `Anderes Bild…` swaps in a file, `Überspringen` skips.
- Result: `<Note>.jpg` next to the note (max 1600 px, JPEG 0.9) plus
  `image: "[[<Note>.jpg]]"` in the front matter. The canvas round-trip bakes EXIF
  rotation, so the PDF export stays upright.
- Existing hero → asks before replacing. Fewer than 200 px on either side → refused.

## Known limits

- Ingredient names are not canonicalised against existing `[[…]]` notes yet
  (`Kartoffel` vs `Kartoffeln`), so the graph can gain near-duplicates.
- A source that states times only as prose ("40 Minuten einkochen") may lose the timer.
- Gemini free tier is fine for personal use but sends the photo to Google; the free
  tier's data may be used to improve their products.
- Upstream rewrites `to-cooklang.ts` and the modals regularly; keep this diff small
  and rebase deliberately rather than merging blindly.
