/**
 * Ambient declarations for the parts of the File System Access API that are
 * not yet in TypeScript's DOM lib (Chromium-only, feature-detected at runtime).
 * This file has no imports/exports so the declarations merge into the globals.
 */

type WellKnownDirectory =
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'music'
  | 'pictures'
  | 'videos'

interface Window {
  showDirectoryPicker?(options?: {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?: WellKnownDirectory | FileSystemHandle
  }): Promise<FileSystemDirectoryHandle>
  showSaveFilePicker?(options?: {
    id?: string
    suggestedName?: string
    startIn?: WellKnownDirectory | FileSystemHandle
  }): Promise<FileSystemFileHandle>
}

interface FileSystemHandle {
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
}
