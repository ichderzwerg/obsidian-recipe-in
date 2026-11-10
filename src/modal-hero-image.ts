import { App, Modal, Notice, Setting } from "obsidian";

/**
 * "Add a hero picture?" — offered right after an import, while the photos are
 * still in memory.
 *
 * A magazine page is mostly not the dish: the whole page makes a poor hero, a
 * crop of it makes a good one. So the default action is cropping the page the
 * import came from, with a plain upload as the fallback.
 */

export interface HeroSource {
  /** Base64 data URL of the page (or the site's own lead image). */
  dataUrl: string;
  /** Shown on the thumbnail, e.g. "Seite 2" or "Website". */
  label: string;
}

export interface HeroImageOptions {
  noteName: string;
  sources: HeroSource[];
  /** Set when the note already has a hero file, so we can ask before replacing. */
  existingPath?: string;
  /** Persist the crop and link it from the note. */
  save: (blob: Blob) => Promise<void>;
}

type Corner = "nw" | "ne" | "sw" | "se";
type DragMode = "move" | Corner;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ASPECTS: Array<{ id: string; label: string; value: number | null }> = [
  { id: "free", label: "Frei", value: null },
  { id: "4:3", label: "4:3", value: 4 / 3 },
  { id: "3:2", label: "3:2", value: 3 / 2 },
  { id: "1:1", label: "1:1", value: 1 },
  { id: "16:9", label: "16:9", value: 16 / 9 },
];

const MIN_OUTPUT_EDGE = 200; // px in the source image
const MIN_DISPLAY_EDGE = 40; // px on screen, so it stays grabbable
const MAX_OUTPUT_EDGE = 1600;

function readImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("Bild konnte nicht geladen werden."));
    image.src = src;
  });
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
 * Yes/no that resolves either way: the confirm button resolves true, closing
 * the dialog any other way (Escape, click outside) resolves false.
 */
class AskModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly question: string,
    private readonly confirmText: string,
    private readonly resolve: (value: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Titelbild ersetzen?");
    this.contentEl.createEl("p", { text: this.question });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Abbrechen").onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText(this.confirmText)
          .setCta()
          .onClick(() => {
            this.answered = true;
            this.resolve(true);
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.resolve(false);
  }
}

/** Ask before an import overwrites an existing hero file. */
export function confirmReplaceHero(app: App, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    new AskModal(
      app,
      `Zu diesem Rezept gibt es schon ein Titelbild (${path}). Ersetzen?`,
      "Ersetzen",
      resolve,
    ).open();
  });
}

export class HeroImageModal extends Modal {
  private index = 0;
  private images: HTMLImageElement[] = [];
  private aspect: number | null = null;
  private rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private busy = false;
  private error = "";
  /** False until the image has laid out and a selection exists. */
  private ready = false;

  private stageEl: HTMLElement | null = null;
  private confirmBtn: HTMLButtonElement | null = null;
  private imgEl: HTMLImageElement | null = null;
  private rectEl: HTMLElement | null = null;

  constructor(
    app: App,
    private opts: HeroImageOptions,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("hero-crop-modal");
    this.images = await Promise.all(
      this.opts.sources.map((source) => readImage(source.dataUrl)),
    );
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /* ------------------------------- render ------------------------------- */

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h3", { text: "Titelbild hinzufügen?" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `Für „${this.opts.noteName}“. Ziehe den Rahmen auf das Foto des Gerichts — oder überspringe diesen Schritt.`,
    });

    if (this.opts.sources.length > 1) {
      const strip = contentEl.createDiv({ cls: "hero-crop-pages" });
      this.opts.sources.forEach((source, index) => {
        const thumb = strip.createEl("button", {
          cls: index === this.index ? "is-active" : "",
        });
        thumb.createEl("img", {
          attr: { src: source.dataUrl, alt: source.label },
        });
        thumb.createEl("span", { text: source.label });
        thumb.addEventListener("click", () => {
          this.index = index;
          this.ready = false;
          this.render();
        });
      });
    }

    const stage = contentEl.createDiv({ cls: "hero-crop-stage" });
    this.stageEl = stage;
    const image = this.images[this.index];
    const img = stage.createEl("img", {
      attr: { src: this.opts.sources[this.index].dataUrl, alt: "" },
    });
    this.imgEl = img;
    // The stage is exactly as large as the rendered image, so the selection
    // rectangle lives in image coordinates and needs no extra offsets.
    img.addClass("hero-crop-image");

    const rectEl = stage.createDiv({ cls: "hero-crop-rect" });
    this.rectEl = rectEl;
    for (const corner of ["nw", "ne", "sw", "se"] as Corner[]) {
      const handle = rectEl.createDiv({ cls: `hero-crop-handle ${corner}` });
      handle.addEventListener("pointerdown", (evt) =>
        this.startDrag(evt, corner),
      );
    }
    rectEl.addEventListener("pointerdown", (evt) =>
      this.startDrag(evt, "move"),
    );

    // Reset the selection to a sensible 4:3 block once the image is laid out.
    const laidOut = () => {
      this.aspect = 4 / 3;
      this.rect = this.defaultRect(img.clientWidth, img.clientHeight, 4 / 3);
      this.ready = true;
      this.paintRect();
      if (this.confirmBtn) {
        this.confirmBtn.disabled = false;
        this.confirmBtn.setText("Ausschnitt übernehmen");
      }
    };
    if (img.complete) window.setTimeout(laidOut, 0);
    else img.addEventListener("load", () => window.setTimeout(laidOut, 0));

    const controls = contentEl.createDiv({ cls: "hero-crop-controls" });
    new Setting(controls)
      .setName("Seitenverhältnis")
      .addDropdown((dropdown) => {
        for (const option of ASPECTS)
          dropdown.addOption(option.id, option.label);
        dropdown.setValue("4:3");
        dropdown.onChange((value) => {
          const found = ASPECTS.find((option) => option.id === value);
          this.aspect = found?.value ?? null;
          if (this.aspect) this.rect = this.clampAspect(this.rect, this.aspect);
          this.paintRect();
        });
      })
      .addButton((button) =>
        button.setButtonText("Ganzes Bild").onClick(() => {
          const width = this.imgEl?.clientWidth ?? 0;
          const height = this.imgEl?.clientHeight ?? 0;
          if (!width || !height) return;
          this.rect = { x: 0, y: 0, w: width, h: height };
          this.paintRect();
        }),
      );

    if (this.error) {
      contentEl.createEl("p", { cls: "recipe-import-error", text: this.error });
    }

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const upload = actions.createEl("button", { text: "Anderes Bild…" });
    upload.addEventListener("click", () => void this.pickOtherImage());

    const skip = actions.createEl("button", { text: "Überspringen" });
    skip.addEventListener("click", () => this.close());

    const confirm = actions.createEl("button", {
      text: this.busy
        ? "Speichert…"
        : this.ready
          ? "Ausschnitt übernehmen"
          : "Bild wird geladen…",
      cls: "mod-cta",
    });
    confirm.disabled = this.busy || !this.ready;
    this.confirmBtn = confirm;
    confirm.addEventListener("click", () => void this.commit());
  }

  /* ------------------------------ geometry ------------------------------ */

  private defaultRect(width: number, height: number, aspect: number): Rect {
    const w = Math.min(width * 0.7, height * aspect);
    const h = w / aspect;
    return { x: (width - w) / 2, y: (height - h) / 2, w, h };
  }

  /** Fit `rect` to `aspect`, keeping it inside bounds and anchored at x/y. */
  private clampAspect(rect: Rect, aspect: number): Rect {
    const width = this.imgEl?.clientWidth ?? 0;
    const height = this.imgEl?.clientHeight ?? 0;
    let w = rect.w;
    let h = w / aspect;
    if (h > height) {
      h = height;
      w = h * aspect;
    }
    if (w > width) {
      w = width;
      h = w / aspect;
    }
    const x = Math.max(0, Math.min(rect.x, width - w));
    const y = Math.max(0, Math.min(rect.y, height - h));
    return { x, y, w, h };
  }

  private paintRect(): void {
    const el = this.rectEl;
    if (!el) return;
    el.style.left = `${this.rect.x}px`;
    el.style.top = `${this.rect.y}px`;
    el.style.width = `${this.rect.w}px`;
    el.style.height = `${this.rect.h}px`;
  }

  private startDrag(evt: PointerEvent, mode: DragMode): void {
    evt.preventDefault();
    evt.stopPropagation();
    const img = this.imgEl;
    if (!img) return;

    const startRect = { ...this.rect };
    const startX = evt.clientX;
    const startY = evt.clientY;
    const width = img.clientWidth;
    const height = img.clientHeight;
    const aspect = this.aspect;

    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;

      if (mode === "move") {
        const x = Math.max(0, Math.min(startRect.x + dx, width - startRect.w));
        const y = Math.max(0, Math.min(startRect.y + dy, height - startRect.h));
        this.rect = { ...startRect, x, y };
        this.paintRect();
        return;
      }

      // Resize from a corner: that corner follows the pointer, the opposite
      // one stays put. Width drives height when an aspect is locked.
      let x = startRect.x;
      let y = startRect.y;
      let w = startRect.w;
      let h = startRect.h;

      if (mode === "se") {
        w = startRect.w + dx;
        h = aspect ? w / aspect : startRect.h + dy;
      } else if (mode === "sw") {
        w = startRect.w - dx;
        h = aspect ? w / aspect : startRect.h + dy;
        x = startRect.x + (startRect.w - w);
      } else if (mode === "ne") {
        w = startRect.w + dx;
        h = aspect ? w / aspect : startRect.h - dy;
        y = startRect.y + (startRect.h - h);
      } else {
        w = startRect.w - dx;
        h = aspect ? w / aspect : startRect.h - dy;
        x = startRect.x + (startRect.w - w);
        y = startRect.y + (startRect.h - h);
      }

      w = Math.max(MIN_DISPLAY_EDGE, w);
      h = Math.max(MIN_DISPLAY_EDGE, h);
      if (aspect) h = w / aspect;

      // Clamp against the image box; the anchor corner moves if needed.
      if (x < 0) {
        w += x;
        x = 0;
        if (aspect) h = w / aspect;
      }
      if (y < 0) {
        h += y;
        y = 0;
        if (aspect) w = h * aspect;
      }
      if (x + w > width) {
        w = width - x;
        if (aspect) h = w / aspect;
      }
      if (y + h > height) {
        h = height - y;
        if (aspect) w = h * aspect;
      }

      this.rect = { x, y, w, h };
      this.paintRect();
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /* -------------------------------- crop -------------------------------- */

  private async cropBlob(): Promise<Blob | null> {
    const img = this.imgEl;
    if (!img || !img.clientWidth) return null;

    const scale = img.naturalWidth / img.clientWidth;
    const sx = Math.round(this.rect.x * scale);
    const sy = Math.round(this.rect.y * scale);
    const sw = Math.round(this.rect.w * scale);
    const sh = Math.round(this.rect.h * scale);

    if (sw < MIN_OUTPUT_EDGE || sh < MIN_OUTPUT_EDGE) {
      this.error = `Der Ausschnitt ist zu klein (${sw}×${sh} px). Mindestens ${MIN_OUTPUT_EDGE} px pro Seite.`;
      this.render();
      return null;
    }

    const out = Math.min(1, MAX_OUTPUT_EDGE / Math.max(sw, sh));
    const canvas = activeDocument.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * out));
    canvas.height = Math.max(1, Math.round(sh * out));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Drawing through a canvas also bakes EXIF rotation into the pixels, which
    // is what keeps the PDF export upright.
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    return new Promise<Blob | null>((resolve) =>
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.9),
    );
  }

  private async commit(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const blob = await this.cropBlob();
      if (!blob) {
        this.busy = false;
        this.render();
        return;
      }
      await this.opts.save(blob);
      new Notice(`Titelbild gespeichert (${Math.round(blob.size / 1024)} KB)`);
      this.close();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.busy = false;
      this.render();
    }
  }

  private async pickOtherImage(): Promise<void> {
    const input = createEl("input", {
      attr: { type: "file", accept: "image/*" },
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void (async () => {
        try {
          const dataUrl = await readFileAsDataUrl(file);
          await readImage(dataUrl);
          this.opts.sources.push({ dataUrl, label: file.name });
          this.images.push(await readImage(dataUrl));
          this.index = this.opts.sources.length - 1;
          this.error = "";
          this.render();
        } catch (error) {
          this.error = error instanceof Error ? error.message : String(error);
          this.render();
        }
      })();
    });
    input.click();
  }
}
