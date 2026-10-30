import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke, listen } from '../platform'

export interface ScheduledSession {
  id: string
  projectId: string
  prompt: string
  runAt: string
  workingDir: string | null
  profileLabel: string | null
  model: string | null
  attachments: string[]
  title: string | null
  stepByStep: boolean
  autoConfirm: boolean
  status: 'pending' | 'queued' | 'fired' | 'cancelled' | 'missed'
  sessionId: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateScheduledOptions {
  projectId: string
  prompt: string
  runAt: string
  workingDir?: string | null
  profileLabel?: string | null
  model?: string | null
  attachments?: string[]
  title?: string | null
  stepByStep?: boolean
  autoConfirm?: boolean
}

/** `in 3h 12m` / `in 2d` / `5m ago` / `now` — pure, no dependency on Vue or on the
 *  backend's timezone (run_at is always RFC3339 UTC, `Date` reads it by itself).
 *  `now` is injectable only for tests: in real use it relies on the default. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const diffSec = Math.round((new Date(iso).getTime() - now.getTime()) / 1000)
  if (Math.abs(diffSec) < 45) return 'now'

  const past = diffSec < 0
  const abs = Math.abs(diffSec)
  let label: string
  if (abs < 3600) {
    label = `${Math.round(abs / 60)}m`
  } else if (abs < 86400) {
    const h = Math.floor(abs / 3600)
    const m = Math.round((abs % 3600) / 60)
    label = m > 0 ? `${h}h ${m}m` : `${h}h`
  } else {
    label = `${Math.round(abs / 86400)}d`
  }
  return past ? `${label} ago` : `in ${label}`
}

export const useScheduledStore = defineStore('scheduled', () => {
  const items = ref<ScheduledSession[]>([])
  let listenersReady = false

  async function refresh(projectId: string) {
    items.value = await invoke<ScheduledSession[]>('list_scheduled_sessions', { projectId })
  }

  async function create(opts: CreateScheduledOptions): Promise<ScheduledSession> {
    const row = await invoke<ScheduledSession>('create_scheduled_session', {
      projectId: opts.projectId,
      prompt: opts.prompt,
      runAt: opts.runAt,
      workingDir: opts.workingDir ?? null,
      profileLabel: opts.profileLabel ?? null,
      model: opts.model ?? null,
      attachments: opts.attachments ?? [],
      title: opts.title ?? null,
      stepByStep: opts.stepByStep ?? false,
      autoConfirm: opts.autoConfirm ?? true,
    })
    items.value = [row, ...items.value]
    return row
  }

  function removeLocal(id: string) {
    items.value = items.value.filter(s => s.id !== id)
  }

  /** No confirmation modal: cancelling a schedule destroys nothing,
   *  unlike deleting a session that has already started. */
  async function cancel(id: string) {
    await invoke('cancel_scheduled_session', { id })
    removeLocal(id)
  }

  async function reschedule(id: string, runAt: string) {
    await invoke('reschedule_scheduled_session', { id, runAt })
    const s = items.value.find(x => x.id === id)
    if (s) { s.runAt = runAt; s.status = 'pending'; s.lastError = null }
  }

  /** Fires right away, without waiting for the tick — "Run now" button of the
   *  missed dialog. It does not touch `items` here: the real outcome arrives via scheduler:fired/failed. */
  async function runNow(id: string) {
    await invoke('run_scheduled_session_now', { id })
  }

  /** Installs the listeners once, for the whole life of the app — same
   *  principle as initGlobalListeners in stores/session.ts. */
  async function initListeners() {
    if (listenersReady) return
    listenersReady = true

    await listen<{ scheduled: ScheduledSession; sessionId: string }>('scheduler:fired', (e) => {
      removeLocal(e.payload.scheduled.id)
    })
    await listen<{ id: string }>('scheduler:queued', (e) => {
      const s = items.value.find(x => x.id === e.payload.id)
      if (s) s.status = 'queued'
    })
    await listen<{ id: string; error: string }>('scheduler:failed', (e) => {
      const s = items.value.find(x => x.id === e.payload.id)
      if (s) { s.status = 'missed'; s.lastError = e.payload.error }
    })
    // Startup sweep: rows that expired while the app was closed. The frontend re-reads
    // the state with `refresh()` at its own start anyway (source of truth) — this
    // event only serves to confirm it when the app is already open.
    await listen<ScheduledSession[]>('scheduler:missed', (e) => {
      for (const row of e.payload) {
        const idx = items.value.findIndex(x => x.id === row.id)
        if (idx >= 0) items.value[idx] = row
        else items.value.push(row)
      }
    })
  }

  return { items, refresh, create, cancel, reschedule, runNow, initListeners }
})
