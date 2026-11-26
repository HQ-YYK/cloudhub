// Minimal types for the File System Access API (Chromium only). The DOM lib
// shipped with TypeScript does not include these; browsers that support the
// API implement them natively.
interface FileSystemWritableFileStream extends WritableStream {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

interface FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>
}

interface ShowSaveFilePickerOptions {
  suggestedName?: string
}

interface Window {
  showSaveFilePicker?: (options?: ShowSaveFilePickerOptions) => Promise<FileSystemFileHandle>
}
