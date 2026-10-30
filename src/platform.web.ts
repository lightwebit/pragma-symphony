// The web twin of `platform.ts`: the same interface, but `invoke` and `listen` go through the
// noema.tools relay instead of Tauri. In `vite build --mode web` this file takes the place of
// `platform.ts` (alias in vite.config.ts), so nothing from Tauri enters the web bundle.
// The link token sits in the URL fragment: `https://noema.tools/pragma-symphony/live#t=<token>`.

import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr'
import type { InvokeArgs } from '@tauri-apps/api/core'
import type { Event as TauriEvent, EventCallback, UnlistenFn } from '@tauri-apps/api/event'
import type { Options as NotificationOptions } from '@tauri-apps/plugin-notification'
import type * as Desktop from './platform'
import { createViewer } from './remote/viewer'

const HUB_PATH = '/hubs/pragma-live'

const TOKEN_KEY = 'pragma-live-token'

/** The link token. Read from the fragment, then removed from the address bar: it does not stay
 *  in a screenshot, a synced tab or an address copied by mistake. For F5 it is
 *  kept in `sessionStorage`, which lives as long as the tab. A newly pasted link always wins. */
function tokenFromUrl(): string | null {
  const m = /(?:^|[#&])t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash)
  if (m) {
    try { sessionStorage.setItem(TOKEN_KEY, m[1]) } catch { /* storage denied: stays in memory only */ }
    history.replaceState(null, '', location.pathname + location.search)
    return m[1]
  }
  try {
    const saved = sessionStorage.getItem(TOKEN_KEY)
    return saved && /^[A-Za-z0-9_-]{43}$/.test(saved) ? saved : null
  } catch {
    return null
  }
}

const viewer = createViewer({
  token: tokenFromUrl(),
  createHub: () =>
    new HubConnectionBuilder()
      .withUrl(HUB_PATH)
      // Retries forever, with a growing pause up to 30 s: a phone that goes to standby comes back.
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (c) =>
          c.previousRetryCount === 0 ? 0 : Math.min(30_000, 2_000 * 2 ** (c.previousRetryCount - 1)),
      })
      .configureLogging(LogLevel.Warning)
      .build(),
})
void viewer.start()

// A new link pasted in the same tab changes only the fragment: the browser does not reload the
// page and it would stay attached to the old token. The token is read once, so we reload.
window.addEventListener('hashchange', () => location.reload())

export const IS_WEB: boolean = true
export const webLink = viewer.state
export const onWebResync = viewer.onResync
export const providePin = viewer.providePin

export function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  return viewer.invoke<T>(cmd, args)
}

export function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  return viewer.listen<T>(event, (e) => handler({ event, id: 0, payload: e.payload } as TauriEvent<T>))
}

// — Window: on the web it is the browser tab —

export const ProgressBarStatus = {
  None: 'none',
  Normal: 'normal',
  Indeterminate: 'indeterminate',
  Paused: 'paused',
  Error: 'error',
} as const

export function getCurrentWindow() {
  return {
    async setTitle(title: string) { document.title = title },
    // The browser has no taskbar progress bar: nothing to do.
    async setProgressBar(_state?: { status?: string; progress?: number }) {},
  }
}

// — Notifications: the browser's Notification API —

export async function isPermissionGranted(): Promise<boolean> {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

type Permission = 'granted' | 'denied' | 'default'

export async function requestPermission(): Promise<Permission> {
  if (typeof Notification === 'undefined') return 'denied'
  return await Notification.requestPermission()
}

export function sendNotification(options: NotificationOptions | string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  if (typeof options === 'string') new Notification(options)
  else new Notification(options.title, { body: options.body })
}

// Compile-time check: the web version offers everything the rest of the app takes from
// `platform.ts`. If something is missing or changes here, the build stops instead of breaking in the browser.
type Surface = Omit<
  Pick<typeof Desktop,
    'invoke' | 'listen' | 'isPermissionGranted' | 'requestPermission' | 'sendNotification'
    | 'webLink' | 'onWebResync' | 'IS_WEB' | 'providePin'>,
  never
>
export const __surface: Surface = {
  invoke, listen, isPermissionGranted, requestPermission, sendNotification, webLink, onWebResync, IS_WEB,
  providePin,
}
const __window: Pick<ReturnType<typeof Desktop.getCurrentWindow>, 'setTitle'> = getCurrentWindow()
void __window
