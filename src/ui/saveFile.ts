/** Where a file the user asked to save will be written. */
export interface SaveTarget {
  /** File name the user chose (or the suggested one, on the download fallback). */
  name: string;
  write(blob: Blob): Promise<void>;
}

type SavePickerWindow = {
  showSaveFilePicker?: (opts: object) => Promise<FileSystemFileHandle>;
};

/** CSV text from rows of fields (quoted where needed, CRLF line ends), with a leading BOM so Excel
 * reads non-ASCII text (⊕, α, φ) as UTF-8. */
export function csvBlob(rows: string[][]): Blob {
  const field = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const text = rows.map(r => r.map(field).join(',')).join('\r\n') + '\r\n';
  return new Blob([String.fromCharCode(0xfeff), text], { type: 'text/csv' });
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Asks the user where to save, via the native Save As dialog (Chromium's File
 * System Access API); browsers without it fall back to a plain download.
 * Call it synchronously from the click handler, before any slow work: the
 * dialog only opens while the click's user activation is still live.
 * Resolves to null if the user cancels.
 */
export async function pickSaveTarget(
  suggestedName: string,
  description: string,
  mime: string,
  ext: string,
): Promise<SaveTarget | null> {
  const fsWindow = window as unknown as SavePickerWindow;
  if (!fsWindow.showSaveFilePicker) {
    return {
      name: suggestedName,
      async write(blob) {
        downloadBlob(suggestedName, blob);
      },
    };
  }
  let handle: FileSystemFileHandle;
  try {
    handle = await fsWindow.showSaveFilePicker({
      suggestedName,
      types: [{ description, accept: { [mime]: [ext] } }],
    });
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') return null;
    throw err;
  }
  return {
    name: handle.name,
    async write(blob) {
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    },
  };
}
