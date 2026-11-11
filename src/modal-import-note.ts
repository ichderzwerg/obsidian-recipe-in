import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { pickImageFiles } from "./utils/file-picker";

/**
 * One import dialog for both sources: a URL or one or more photos.
 *
 * Flow: source → (AI) → the finished note in an editable textarea → save.
 * The textarea is the review step: nothing reaches the vault unseen.
 */

export type ImportMode = "url" | "photo";

export interface NoteDraft {
  note: string;
  /** Hero picture the import already knows about (site lead image). */
  sourceImageUrl?: string;
}

export interface ImportModalOptions {
  mode: ImportMode;
  /** Pre-filled URL (e.g. from a selection in the editor). */
  presetUrl?: string;
  /** Scrape a URL and turn it into a note. */
  fromUrl?: (url: string) => Promise<NoteDraft>;
  /** Turn photos (base64 data URLs) into a note. */
  fromImages?: (images: string[]) => Promise<NoteDraft>;
  /** Write the reviewed note into the vault; returns the created file. */
  save: (draft: NoteDraft, title: string) => Promise<TFile | void>;
  /** Called after a successful save — the moment to offer a hero picture. */
  afterSave?: (
    file: TFile,
    originals: Blob[],
    draft: NoteDraft,
  ) => void | Promise<void>;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(reader.error ?? new Error("Bild konnte nicht gelesen werden."));
    reader.readAsDataURL(file);
  });
}

/**
 * Shrink a photo before it leaves the device: a 4 MB phone picture is slow to
 * upload and costs tokens for no extra legibility. 1600 px on the long edge is
 * still well above what a vision model needs for a cookbook page.
 */
async function downscale(
  src: string,
  maxEdge = 1600,
  quality = 0.85,
): Promise<string> {
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("decode failed"));
      image.src = src;
    });
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
    if (scale > 0.95) return src;

    const canvas = activeDocument.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return src;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return src;
  }
}

/**
 * Cheap sanity check on the generated note, shown above the textarea.
 *
 * The failure modes that matter on a phone are exactly the ones you cannot
 * easily fix there: ingredients without amounts, and steps that came back as a
 * numbered list instead of prose. Both mean the model ignored the format, so
 * the count is worth more than a silent save.
 */
function noteWarnings(note: string): string[] {
  const warnings: string[] = [];
  const body =
    note
      .split(/\n---\n/)
      .slice(1)
      .join("\n---\n") || note;

  const empty = (body.match(/@[^@{}\n]+?\{\}/g) || []).length;
  const withAmount = (body.match(/@[^@{}\n]+?\{[^}]+\}/g) || []).length;
  if (empty >= 2 && empty >= Math.max(2, withAmount)) {
    warnings.push(
      `${empty} Zutaten ohne Menge — steht im Original eine Menge, gehört sie in die Klammern`,
    );
  }

  const numbered = body
    .split("\n")
    .filter((line) => /^\s*\d+[.)]\s+/.test(line)).length;
  if (numbered >= 2) {
    warnings.push(`${numbered} nummerierte Zeilen statt Fließtext`);
  }

  if (!/^=\s+.+\s+=$/m.test(body)) {
    warnings.push("keine Abschnitte (= Name =) gefunden");
  }

  return warnings;
}

function titleFromNote(note: string, fallback: string): string {
  const match = /^---[\s\S]*?^title:\s*(.+)$/m.exec(note);
  return (match?.[1] ?? fallback).trim().replace(/^["']|["']$/g, "");
}

export class ImportNoteModal extends Modal {
  private step: 1 | 2 = 1;
  private url = "";
  private images: string[] = [];
  /** The untouched files, kept for cropping a hero picture at native size. */
  private originals: Blob[] = [];
  private draft: NoteDraft | null = null;
  private title = "";
  private busy = false;
  private error = "";

  constructor(
    app: App,
    private opts: ImportModalOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("recipe-import-modal");
    this.url = this.opts.presetUrl ?? "";
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (this.step === 1) this.renderSource();
    else this.renderReview();
  }

  /* ------------------------------ step 1 ------------------------------ */

  private renderSource(): void {
    const { contentEl } = this;
    if (this.opts.mode === "url") {
      contentEl.createEl("h3", { text: "Rezept aus URL importieren" });
      contentEl.createEl("p", {
        cls: "setting-item-description",
        text: "Link zu einem Rezept einfügen. Die Seite wird ausgelesen und in eine Notiz umgewandelt.",
      });
      new Setting(contentEl).setName("URL").addText((text) => {
        text
          .setPlaceholder("https://…")
          .setValue(this.url)
          .onChange((value) => (this.url = value.trim()));
        text.inputEl.addClass("recipe-vault-input-full");
        text.inputEl.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter") void this.runUrl();
        });
        window.setTimeout(() => text.inputEl.focus(), 50);
      });
    } else {
      contentEl.createEl("h3", { text: "Rezept aus Foto" });
      contentEl.createEl("p", {
        cls: "setting-item-description",
        text: "Foto(s) einer Kochbuchseite oder Rezeptkarte wählen. Mehrere Bilder gelten als Seiten eines Rezepts.",
      });
      new Setting(contentEl)
        .setName("Bilder")
        .setDesc(
          this.images.length
            ? `${this.images.length} Bild(er) gewählt`
            : "Noch kein Bild gewählt",
        )
        .addButton((btn) =>
          btn
            .setButtonText(this.images.length ? "Weitere…" : "Bilder wählen…")
            .setCta()
            .onClick(() => void this.pickImages()),
        );

      if (this.images.length) {
        const grid = contentEl.createDiv({ cls: "photo-recipe-thumbs" });
        this.images.forEach((src, index) => {
          const cell = grid.createDiv({ cls: "photo-recipe-thumb" });
          cell.createEl("img", { attr: { src, alt: `Seite ${index + 1}` } });
          const remove = cell.createEl("button", { text: "×" });
          remove.addEventListener("click", () => {
            this.images.splice(index, 1);
            this.render();
          });
        });
      }
    }

    if (this.error) {
      contentEl.createEl("p", { cls: "recipe-import-error", text: this.error });
    }

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const run = actions.createEl("button", {
      text: this.busy
        ? "Läuft…"
        : this.opts.mode === "url"
          ? "Importieren"
          : "Rezept lesen",
      cls: "mod-cta",
    });
    run.disabled = this.busy;
    run.addEventListener("click", () => {
      if (this.opts.mode === "url") void this.runUrl();
      else void this.runImages();
    });
  }

  private async pickImages(): Promise<void> {
    const files = await pickImageFiles({ multiple: true });
    for (const file of files) {
      const raw = await readFileAsDataUrl(file);
      this.originals.push(file);
      this.images.push(await downscale(raw));
    }
    if (files.length) {
      const kb = Math.round(this.images[this.images.length - 1].length / 1024);
      new Notice(`${files.length} Bild(er) vorbereitet (~${kb} KB übertragen)`);
      this.render();
    }
  }

  /* ------------------------------ run ------------------------------ */

  private async runUrl(): Promise<void> {
    if (this.busy) return;
    if (!this.url.trim()) {
      this.error = "Bitte eine URL einfügen.";
      this.render();
      return;
    }
    if (!this.opts.fromUrl) return;

    this.busy = true;
    this.error = "";
    this.render();
    const notice = new Notice("Rezept wird geladen…", 0);
    try {
      this.draft = await this.opts.fromUrl(this.url.trim());
      this.title = titleFromNote(this.draft.note, "Rezept");
      this.step = 2;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
      notice.hide();
      this.render();
    }
  }

  private async runImages(): Promise<void> {
    if (this.busy) return;
    if (!this.images.length) {
      this.error = "Bitte zuerst mindestens ein Bild wählen.";
      this.render();
      return;
    }
    if (!this.opts.fromImages) return;

    this.busy = true;
    this.error = "";
    this.render();
    const notice = new Notice("Rezept wird aus dem Foto gelesen…", 0);
    try {
      this.draft = await this.opts.fromImages(this.images);
      this.title = titleFromNote(this.draft.note, "Rezept");
      this.step = 2;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
      notice.hide();
      this.render();
    }
  }

  /* ------------------------------ step 2 ------------------------------ */

  private renderReview(): void {
    const { contentEl } = this;
    const draft = this.draft;
    if (!draft) return;

    contentEl.createEl("h3", { text: "Prüfen und speichern" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Alles unten ist die fertige Notiz. Vor dem Speichern bearbeitbar.",
    });

    new Setting(contentEl).setName("Dateiname").addText((text) => {
      text.setValue(this.title).onChange((value) => (this.title = value));
      text.inputEl.addClass("recipe-vault-input-full");
    });

    const warnings = noteWarnings(draft.note);
    if (warnings.length) {
      const box = contentEl.createDiv({ cls: "recipe-import-warning" });
      box.createEl("strong", {
        text: "Das sieht nach einem Formatfehler aus:",
      });
      const list = box.createEl("ul");
      for (const warning of warnings) list.createEl("li", { text: warning });
      box.createEl("p", {
        text: "Meist heißt das: das Modell war zu schwach für die Seite. Nochmal versuchen, oder in den Einstellungen ein anderes Modell wählen.",
      });
    }

    const area = contentEl.createEl("textarea", {
      cls: "recipe-import-note-input",
    });
    area.value = draft.note;
    area.rows = 22;
    area.addEventListener("input", () => (draft.note = area.value));

    if (this.error) {
      contentEl.createEl("p", { cls: "recipe-import-error", text: this.error });
    }

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const back = actions.createEl("button", { text: "Zurück" });
    back.addEventListener("click", () => {
      this.step = 1;
      this.error = "";
      this.render();
    });

    const save = actions.createEl("button", {
      text: this.busy ? "Speichert…" : "In den Vault speichern",
      cls: "mod-cta",
    });
    save.disabled = this.busy;
    save.addEventListener("click", () => {
      void (async () => {
        this.busy = true;
        this.error = "";
        this.render();
        try {
          const saved = await this.opts.save(
            draft,
            this.title.trim() || "Rezept",
          );
          new Notice(`Gespeichert: ${this.title.trim() || "Rezept"}`);
          this.close();
          if (saved && this.opts.afterSave) {
            const afterSave = this.opts.afterSave;
            const originals = this.originals;
            window.setTimeout(() => {
              void afterSave(saved, originals, draft);
            }, 80);
          }
        } catch (err) {
          this.error = err instanceof Error ? err.message : String(err);
          this.busy = false;
          this.render();
        }
      })();
    });
  }
}
