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
}

export interface AIRequest {
  system: string;
  text: string;
  /** Base64 data URLs ("data:image/png;base64,..."), one per page. */
  images?: string[];
}

export const DEFAULT_OPENAI_BASE = "https://openrouter.ai/api/v1";
export const DEFAULT_GEMINI_BASE =
  "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
export const DEFAULT_OPENAI_MODEL = "google/gemini-3.5-flash-lite";

function trimBase(url: string, fallback: string): string {
  const value = (url || "").trim() || fallback;
  return value.replace(/\/+$/, "");
}

class AIHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
      max_tokens: 8000,
      temperature: 0.2,
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
    throw new Error("Der Anbieter hat eine leere Antwort geliefert.");
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
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
    }),
    throw: false,
  });

  const payload = response.json as
    | {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          finishReason?: string;
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

  const candidate = payload?.candidates?.[0];
  const content = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");
  if (!content.trim()) {
    throw new Error("Gemini hat eine leere Antwort geliefert.");
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new Error(
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

  const timeout = new Promise<never>((_resolve, reject) => {
    window.setTimeout(
      () => reject(new Error("Zeitüberschreitung bei der KI-Anfrage.")),
      Math.max(cfg.timeoutMs, 5000),
    );
  });

  const call = cfg.provider === "gemini" ? callGemini : callOpenAI;

  // Transient overload (503) and rate limits are common on the free tiers;
  // retry twice with a short backoff before surfacing the error.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await Promise.race([call(cfg, req), timeout]);
    } catch (error) {
      lastError = error;
      const status = error instanceof AIHttpError ? error.status : 0;
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt === 2) break;
      await new Promise((resolve) =>
        window.setTimeout(resolve, 3000 * (attempt + 1)),
      );
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
