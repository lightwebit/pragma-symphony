// The single point that talks to the host environment. This is the desktop version (Tauri);
// `platform.web.ts` is its twin for the noema.tools page and takes its place in
// `vite build --mode web` (see vite.config.ts). The rest of the frontend always imports from here,
// never directly from '@tauri-apps/*' or SignalR.

import type { WebLinkState } from './remote/viewer'

export { invoke } from '@tauri-apps/api/core'
export { listen } from '@tauri-apps/api/event'
export { getCurrentWindow, ProgressBarStatus } from '@tauri-apps/api/window'
export { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'

/** true only in the build that runs in a browser, connected to a Pragma on the PC through the relay. */
export const IS_WEB: boolean = false

/** State of the connection to the relay. On the desktop there is nothing to connect to: always «live». */
export const webLink: WebLinkState = {
  status: 'live', hostOnline: true, commandsEnabled: true, closedReason: null, error: null, pinPrompt: false,
}

/** On the web: the answer to the command PIN request. On the desktop it is never asked. */
export function providePin(_pin: string | null): void {}

/** On the web: to call when everything must be re-read from the PC (reconnection, lost events). */
export function onWebResync(_cb: () => Promise<void> | void): () => void {
  return () => {}
}
