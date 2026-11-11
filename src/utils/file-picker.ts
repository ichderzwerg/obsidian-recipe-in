import { Notice } from "obsidian";

/**
 * Where the last picker's element is parked. Only one can be open at a time,
 * so a single slot is enough — and it keeps an abandoned element (picker
 * dismissed with neither event firing) from piling up.
 */
let pending: HTMLInputElement | null = null;

export interface PickImageOptions {
  /** Allow picking several pages at once. */
  multiple?: boolean;
}

/**
 * Open the OS file picker for images and resolve with what was chosen — an
 * empty array when the user cancelled.
 *
 * The element is appended to the document on purpose. A detached
 * `<input type="file">` that only a local variable points at is the classic
 * "the first pick does nothing, the second one works" bug on iOS: while the
 * native picker is up, the WebView can collect the element or lose its
 * listener, so `change` never arrives and the dialog re-renders unchanged.
 * Keeping the element in the DOM and a reference in this module removes both.
 *
 * No `capture` attribute, deliberately: on mobile it forces the camera and
 * makes the OS ignore `multiple` and the photo library. The native picker
 * still offers "Take Photo" on its own.
 */
export async function pickImageFiles(
  options: PickImageOptions = {},
): Promise<File[]> {
  pending?.remove();
  const doc = activeDocument;
  const input = doc.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  if (options.multiple) input.multiple = true;

  // Off-screen instead of `display: none`: some WebKit builds treat a hidden
  // file input as not user-visible and swallow the programmatic click.
  Object.assign(input.style, {
    position: "fixed",
    top: "0",
    left: "-10000px",
    width: "1px",
    height: "1px",
    opacity: "0",
  } satisfies Partial<CSSStyleDeclaration>);
  doc.body.appendChild(input);
  pending = input;

  return new Promise<File[]>((resolve) => {
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      if (pending === input) pending = null;
      resolve(files);
    };

    input.addEventListener(
      "change",
      () => {
        const files = Array.from(input.files ?? []);
        // A change event carrying no file means the hand-off failed, not that
        // the user declined — say it instead of re-rendering the same screen.
        if (!files.length) {
          new Notice("Keine Datei erhalten — bitte noch einmal wählen.", 6000);
        }
        finish(files);
      },
      { once: true },
    );

    // Fired when the sheet is dismissed without a selection (Safari 16+).
    input.addEventListener("cancel", () => finish([]), { once: true });

    input.click();
  });
}
