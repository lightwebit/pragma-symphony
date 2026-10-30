import { computed, watch } from 'vue'
import { getCurrentWindow, ProgressBarStatus, isPermissionGranted, requestPermission, sendNotification } from '../platform'
import { useSessionStore } from '../stores/session'
import { useSettingsStore } from '../stores/settings'
import ringUrl from '../assets/ring.mp3'

// A single Audio element reused for every ring: avoids piling up
// instances if several sessions end close together.
const ringAudio = new Audio(ringUrl)

function playRing() {
  ringAudio.currentTime = 0
  void ringAudio.play().catch(() => {})
}

// System notification at the end of a session and window title: two different ways
// of saying the same thing to someone who has the app in the background.
// The permission is asked at the first useful notification, never at boot.
export function useSessionNotifications() {
  const session = useSessionStore()
  const settings = useSettingsStore()

  // With parallel sessions the notification cannot look only at the focused session:
  // the one that finishes in the background is exactly the case where it is needed.
  const runningIds = computed(() => new Set(session.runningSessions.map(s => s.id!)))

  watch(runningIds, async (now, before) => {
    if (!before) return
    const finished = [...before].filter(id => !now.has(id))
    if (finished.length === 0) return

    if (settings.settings.soundEnabled) playRing()

    if (!settings.settings.notificationsEnabled) return
    let granted = await isPermissionGranted()
    if (!granted) granted = (await requestPermission()) === 'granted'
    if (!granted) return

    for (const id of finished) {
      const s = session.sessions[id]
      const title = s?.title || 'Session complete'
      const body = s?.lastError ? `Error: ${s.lastError}` : 'Session finished.'
      sendNotification({ title: `Pragma Symphony — ${title}`, body })
    }
  })

  watch(
    () => [session.sessionTitle, session.running] as const,
    ([t, running]) => {
      const winTitle = t
        ? (running ? `▶ ${t} — Pragma Symphony` : `${t} — Pragma Symphony`)
        : 'Pragma Symphony'
      getCurrentWindow().setTitle(winTitle)
    },
    { immediate: true },
  )

  // Progress in the taskbar icon: not the flashing of the whole icon (too
  // intrusive, and on Windows it needs focus to switch off by itself), but the system's
  // indeterminate bar — a "still working" sign that does not ask for attention.
  const anyRunning = computed(() => session.runningSessions.length > 0)

  watch(anyRunning, (running) => {
    getCurrentWindow().setProgressBar({
      status: running ? ProgressBarStatus.Indeterminate : ProgressBarStatus.None,
    })
  })
}
