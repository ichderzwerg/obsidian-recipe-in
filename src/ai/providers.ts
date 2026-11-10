import { requestUrl } from "obsidian";

/**
 * One transport for every AI backend we support.
 *
 * Two wire formats cover everything people asked for:
 *  - "gemini":  Google's native Generative Language API. Required for the new
 *               AQ.-prefixed AI Studio keys, which the OpenAI-compatible route
 *               rejects with 401 ACCESS_TOKEN_TYPE_UNSUPPORTED.
 *  - "openai":  any OpenAI-compatible /chat/completions endpoint — OpenRouter,
 *               Ollama (http://localhost:11434/v1), LM Studio, llama.cpp,
 *               vLLM, Groq, Mistral, opencode zen, ...
 */
export type AIProvider = "gemini" | "openai";

export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  /** OpenAI-compatible base URL, with or without a trailing slash. Ignored for Gemini. */
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** Gemini only: allow internal reasoning (slower, tighter format). Default on. */
  thinking?: boolean;
  /** Tried once if the main model answers 429/5xx after its retries. */
  fallbackModel?: string;
}

export interface AIRequest {
  system: string;
  text: string;
  /** Base64 data URLs ("data:image/png;base64,..."), one per page. */
  images?: string[];
  /** Override the default 0.2 — paraphrasing needs more freedom. */
  temperature?: number;
}

export const DEFAULT_OPENAI_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_GEMINI_BASE =
  "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

/** Appended on the retry after a RECITATION stop. */
export const PARAPHRASE_HINT = `

WICHTIG — zweiter Versuch: Der vorherige Versuch wurde als zu wörtliche Wiedergabe
abgelehnt. Formuliere alle Sätze jetzt in eigenen Worten um. Übernimm keine längeren
wörtlichen Passagen aus der Vorlage, keine zusammenhängenden Sätze, keine Überschriften
daraus. Zutaten, Mengen, Einheiten und die Reihenfolge der Schritte bleiben exakt gleich.`;
/**
 * Used when the main Gemini model is overloaded or rate-limited. The `-latest`
 * alias tracks whatever lite model is currently serving, which is far less
 * likely to be the one that just answered 503.
 */
export const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-flash-lite-latest";
export const DEFAULT_OPENAI_MODEL = "google/gemini-3.5-flash-lite";

function trimBase(url: string, fallback: string): string {
  const value = (url || "").trim() || fallback;
  return value.replace(/\/+$/, "");
}

class AIHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable cause, e.g. "recitation" — drives the retry strategy. */
    readonly kind?: "recitation" | "safety" | "max_tokens" | "empty",
    /** Server-suggested wait before retrying, when the API sends one. */
    readonly retryDelayMs?: number,
  ) {
    super(message);
    this.name = "AIHttpError";
  }
}

function errorMessage(status: number, detail?: string): string {
  if (status === 401 || status === 403) {
    return "Der API-Schlüssel wurde abgelehnt. Prüfe Anbieter, Schlüssel und Modell in den Einstellungen.";
  }
  if (status === 429) {
    return "Rate-Limit erreicht. Bitte kurz warten und erneut versuchen.";
  }
  if (status === 404) {
    return "Modell oder Endpunkt nicht gefunden. Prüfe Modell-ID und Basis-URL.";
  }
  if (status >= 500) {
    return "Der KI-Dienst meldet einen Fehler. Bitte gleich noch einmal versuchen.";
  }
  return detail?.trim() || `KI-Anfrage fehlgeschlagen (HTTP ${status}).`;
}

/** "data:image/jpeg;base64,AAAA" -> { mimeType, data } */
function splitDataUrl(url: string): { mimeType: string; data: string } {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (!match) {
    throw new Error("Bild konnte nicht gelesen werden (kein Base64-Data-URL).");
  }
  return { mimeType: match[1], data: match[2] };
}

interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

async function callOpenAI(cfg: AIConfig, req: AIRequest): Promise<string> {
  const base = trimBase(cfg.baseUrl, DEFAULT_OPENAI_BASE);
  const userContent: string | OpenAIContentPart[] = req.images?.length
    ? [
        { type: "text", text: req.text },
        ...req.images.map(
          (url): OpenAIContentPart => ({
            type: "image_url",
            image_url: { url },
          }),
        ),
      ]
    : req.text;

  const response = await requestUrl({
    url: `${base}/chat/completions`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: userContent },
      ],
      // Recipes are long; without a cap the JSON/text can be cut mid-way.
      max_tokens: 16000,
      temperature: req.temperature ?? 0.2,
    }),
    throw: false,
  });

  const payload = response.json as
    | {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
        error?: { message?: string };
      }
    | undefined;

  if (response.status < 200 || response.status >= 300) {
    throw new AIHttpError(
      response.status,
      errorMessage(response.status, payload?.error?.message),
    );
  }

  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (!content?.trim()) {
    console.warn(
      "recipe-in: leere Antwort",
      JSON.stringify(payload).slice(0, 600),
    );
    throw new AIHttpError(
      599,
      "Der Anbieter hat eine leere Antwort geliefert.",
    );
  }
  if (choice?.finish_reason === "length") {
    throw new Error(
      "Die Antwort war zu lang für das Modell. Nimm ein Modell mit größerem Ausgabelimit oder weniger Fotos.",
    );
  }
  return content;
}

async function callGemini(cfg: AIConfig, req: AIRequest): Promise<string> {
  const base = trimBase("", DEFAULT_GEMINI_BASE);
  const parts: Array<Record<string, unknown>> = [{ text: req.text }];
  for (const url of req.images ?? []) {
    const { mimeType, data } = splitDataUrl(url);
    parts.push({ inline_data: { mime_type: mimeType, data } });
  }

  const response = await requestUrl({
    url: `${base}/models/${encodeURIComponent(cfg.model)}:generateContent`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": cfg.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: req.temperature ?? 0.2,
        maxOutputTokens: 32768,
        ...(cfg.thinking === false
          ? { thinkingConfig: { thinkingBudget: 0 } }
          : {}),
      },
    }),
    throw: false,
  });

  const payload = response.json as
    | {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string; thought?: boolean }> };
          finishReason?: string;
        }>;
        promptFeedback?: { blockReason?: string };
        usageMetadata?: {
          candidatesTokenCount?: number;
          thoughtsTokenCount?: number;
          promptTokenCount?: number;
        };
        error?: {
          message?: string;
          details?: Array<{ retryDelay?: string }>;
        };
      }
    | undefined;

  if (response.status < 200 || response.status >= 300) {
    const delay = (payload?.error?.details ?? [])
      .map((detail) => /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay ?? ""))
      .find((match) => match !== null);
    throw new AIHttpError(
      response.status,
      errorMessage(response.status, payload?.error?.message),
      undefined,
      delay ? Math.round(parseFloat(delay[1]) * 1000) : undefined,
    );
  }

  const blocked = payload?.promptFeedback?.blockReason;
  if (blocked) {
    throw new AIHttpError(
      400,
      `Gemini hat die Anfrage blockiert (${blocked}). Bei Fotos oft ein zu großer oder unleserlicher Ausschnitt.`,
    );
  }

  const candidate = payload?.candidates?.[0];
  const finish = candidate?.finishReason ?? "";
  const content = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("");

  if (!content.trim()) {
    const usage = payload?.usageMetadata ?? {};
    const detail =
      `finishReason=${finish || "?"}, ` +
      `out=${usage.candidatesTokenCount ?? 0}, ` +
      `thoughts=${usage.thoughtsTokenCount ?? 0}, ` +
      `in=${usage.promptTokenCount ?? 0}`;

    // 599 = transient: worth one retry and the fallback model.
    if (finish === "MAX_TOKENS") {
      throw new AIHttpError(
        599,
        `Das Ausgabelimit war erreicht, bevor die Notiz fertig war (${detail}). Nimm weniger Fotos auf einmal.`,
        "max_tokens",
      );
    }
    if (finish === "RECITATION") {
      // The model reproduced the source too literally. Retried once below
      // with a paraphrase instruction — that almost always gets through.
      console.warn(
        "recipe-in: recitation",
        JSON.stringify(payload).slice(0, 400),
      );
      throw new AIHttpError(
        400,
        `Gemini hat die Antwort als zu wörtliche Wiedergabe gestoppt (${detail}).`,
        "recitation",
      );
    }
    if (finish === "SAFETY") {
      throw new AIHttpError(
        400,
        `Gemini hat die Antwort aus Sicherheitsgründen gestoppt (${detail}).`,
        "safety",
      );
    }
    console.warn(
      "recipe-in: leere Gemini-Antwort",
      JSON.stringify(payload).slice(0, 600),
    );
    throw new AIHttpError(
      599,
      `Gemini hat eine leere Antwort geliefert (${detail}).`,
      "empty",
    );
  }

  if (finish === "MAX_TOKENS") {
    throw new AIHttpError(
      599,
      "Die Antwort war zu lang für das Modell. Nimm weniger Fotos auf einmal.",
    );
  }
  return content;
}

/** Send one request and return the model's text. Throws with a readable message. */
export async function generateText(
  cfg: AIConfig,
  req: AIRequest,
): Promise<string> {
  if (!cfg.apiKey.trim() && cfg.provider === "gemini") {
    throw new Error(
      "Kein API-Schlüssel gesetzt (Einstellungen → Rezept-Import).",
    );
  }
  if (!cfg.model.trim()) {
    throw new Error("Keine Modell-ID gesetzt (Einstellungen → Rezept-Import).");
  }

  const call = cfg.provider === "gemini" ? callGemini : callOpenAI;
  const limit = Math.max(cfg.timeoutMs, 5000);

  /** One attempt, with its own timer — retries must not eat the budget. */
  const once = (
    config: AIConfig,
    request: AIRequest = req,
  ): Promise<string> => {
    const timeout = new Promise<never>((_resolve, reject) => {
      window.setTimeout(
        () =>
          reject(
            new AIHttpError(
              0,
              `Zeitüberschreitung nach ${Math.round(limit / 1000)} s. ` +
                "Große Fotos brauchen länger — verkleinern oder das Zeitlimit in den Einstellungen erhöhen.",
            ),
          ),
        limit,
      );
    });
    return Promise.race([call(config, request), timeout]);
  };

  // Transient overload (503) and per-minute quotas are normal on the free
  // tiers; retry twice, then fall back to a second model if one is configured.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await once(cfg);
    } catch (error) {
      lastError = error;
      const status = error instanceof AIHttpError ? error.status : 0;
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt === 2) break;
      const suggested =
        error instanceof AIHttpError && error.retryDelayMs
          ? error.retryDelayMs
          : 0;
      const base = status === 429 ? 6000 : 3000;
      await new Promise((resolve) =>
        window.setTimeout(resolve, suggested || base * (attempt + 1)),
      );
    }
  }

  // "Recitation" means the model reproduced the source too closely. Asking it
  // to paraphrase — in its own words, at a higher temperature — usually passes,
  // and the facts (quantities, order) stay the same.
  if (lastError instanceof AIHttpError && lastError.kind === "recitation") {
    try {
      return await once(cfg, {
        ...req,
        system: req.system + PARAPHRASE_HINT,
        temperature: 0.8,
      });
    } catch (error) {
      lastError = error;
    }
  }

  const fallback = (cfg.fallbackModel ?? "").trim();
  if (fallback && fallback !== cfg.model) {
    try {
      return await once(
        { ...cfg, model: fallback },
        lastError instanceof AIHttpError && lastError.kind === "recitation"
          ? { ...req, system: req.system + PARAPHRASE_HINT, temperature: 0.8 }
          : req,
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/** Strip a ```markdown fence the model may have wrapped the note in. */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}
