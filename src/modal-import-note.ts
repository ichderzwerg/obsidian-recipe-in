import { App, Modal, Notice, Setting } from "obsidian";

/**
 * One import dialog for both sources: a URL or one or more photos.
 *
 * Flow: source → (AI) → the finished note in an editable textarea → save.
 * The textarea is the review step: nothing reaches the vault unseen.
 */

export type ImportMode = "url" | "photo";

export interface NoteDraft {
  note: string;
  imageBlob?: Blob;
}

export interface ImportModalOptions {
  mode: ImportMode;
  /** Pre-filled URL (e.g. from a selection in the editor). */
  presetUrl?: string;
  /** Scrape a URL and turn it into a note. */
  fromUrl?: (url: string) => Promise<NoteDraft>;
  /** Turn photos (base64 data URLs) into a note. */
  fromImages?: (images: string[]) => Promise<NoteDraft>;
  /** Write the reviewed note into the vault. */
  save: (draft: NoteDraft, title: string) => Promise<void>;
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

function titleFromNote(note: string, fallback: string): string {
  const match = /^---[\s\S]*?^title:\s*(.+)$/m.exec(note);
  return (match?.[1] ?? fallback).trim().replace(/^["']|["']$/g, "");
}

export class ImportNoteModal extends Modal {
  private step: 1 | 2 = 1;
  private url = "";
  private images: string[] = [];
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
    const input = createEl("input", {
      attr: { type: "file", accept: "image/*", multiple: "" },
    });
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      void (async () => {
        for (const file of files) {
          this.images.push(await readFileAsDataUrl(file));
        }
        this.render();
      })();
    });
    input.click();
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
          await this.opts.save(
            { note: draft.note, imageBlob: draft.imageBlob },
            this.title.trim() || "Rezept",
          );
          new Notice(`Gespeichert: ${this.title.trim() || "Rezept"}`);
          this.close();
        } catch (err) {
          this.error = err instanceof Error ? err.message : String(err);
          this.busy = false;
          this.render();
        }
      })();
    });
  }
}
