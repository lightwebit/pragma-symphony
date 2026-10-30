import { defineStore } from 'pinia'
import { computed, watch } from 'vue'
import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr'
import { invoke, listen } from '../platform'
import { createBridge, type HubLike } from '../remote/bridge'
import { createStateDiffer, stateKey } from '../remote/statePublisher'
import { createCommandRunner } from '../remote/commands'
import { verifyPin } from '../remote/pin'
import { useSettingsStore } from './settings'
import { useSessionStore } from './session'
import { useProjectStore } from './projects'
import { useTodoStore } from './todos'
import { useScheduledStore } from './scheduled'
import { version } from '../../package.json'

// The relay is reachable only if the user turned on «Share sessions to web» in settings
// AND presses share in the header: without both this store opens no connection.
// The link token lives only in the memory of this process — once Pragma is restarted, the old
// link is dead.

function createRealHub(url: string): HubLike {
  return new HubConnectionBuilder()
    // The relay's CORS policy does not admit credentials.
    .withUrl(url, { withCredentials: false })
    // Retries forever, with a growing pause up to 30 s: the room on the relay stays alive 2 minutes
    // without the PC, and the bridge reopens it with the same token as soon as the network is back.
    .withAutomaticReconnect({
      nextRetryDelayInMilliseconds: (c) =>
        c.previousRetryCount === 0 ? 0 : Math.min(30_000, 2_000 * 2 ** (c.previousRetryCount - 1)),
    })
    .configureLogging(LogLevel.Warning)
    .build()
}

export const useRemoteStore = defineStore('remote', () => {
  const settings = useSettingsStore()
  const session = useSessionStore()
  const projects = useProjectStore()
  const todos = useTodoStore()
  const scheduled = useScheduledStore()

  /** «Allow commands from web» on and a PIN set: without a PIN it is as if off. */
  const commandsEnabled = computed(() => {
    const r = settings.settings.remote
    return !!r && !!r.commandsEnabled && !!r.commandPinHash
  })

  const commandRunner = createCommandRunner({
    session: session as any,
    profiles: () => settings.settings.profiles,
    defaultProfileIndex: () => settings.settings.defaultProfileIndex ?? 0,
    projects: () => projects.projects,
    invoke: (cmd, args) => invoke(cmd, args),
    refreshLists: (projectId) => {
      const pid = projectId ?? projects.currentProjectId
      if (!pid) return
      todos.refresh(pid).catch(() => {})
      scheduled.refresh(pid).catch(() => {})
    },
  })

  // Live state that is not in the atoms (`pragma.snapshot`): the web asks for it when
  // opening a session, and it goes out by itself as `pragma:state` when it changes.
  function snapshot(sessionId: string) {
    const s = session.sessions[sessionId]
    if (!s) return null
    return {
      running: s.running,
      phase: s.pragma.phase,
      turnEnd: s.turnEnd,
      autoConfirm: s.autoConfirm,
      autoConfirmAt: s.autoConfirmAt,
      lastError: s.lastError,
      usage: s.usage,
      cache: s.cache,
    }
  }

  const bridge = createBridge({
    createHub: createRealHub,
    listen,
    invoke,
    appVersion: version,
    snapshot,
    commands: {
      enabled: () => commandsEnabled.value,
      checkPin: (pin) => verifyPin(pin, settings.settings.remote?.commandPinHash ?? ''),
      run: (cmd, args) => commandRunner.run(cmd, args),
    },
  })

  // Switched on or off from settings while sharing: the relay and the viewers know right away.
  watch(commandsEnabled, () => bridge.syncCommands())

  const changedSessions = createStateDiffer()
  watch(
    () => {
      const keys = new Map<string, string>()
      for (const [id, s] of Object.entries(session.sessions)) {
        keys.set(id, stateKey({
          running: s.running, phase: s.pragma.phase, turnEnd: s.turnEnd,
          autoConfirm: s.autoConfirm, autoConfirmAt: s.autoConfirmAt, lastError: s.lastError,
        }))
      }
      return keys
    },
    (keys) => {
      const changed = changedSessions(keys)
      if (bridge.state.status !== 'on') return
      for (const id of changed) bridge.publishState(id, snapshot(id))
    },
  )

  const status = computed(() => bridge.state.status)
  const viewerCount = computed(() => bridge.state.viewerCount)
  const link = computed(() => bridge.state.link)
  const error = computed(() => bridge.state.error)
  const sharing = computed(() => status.value === 'on' || status.value === 'reconnecting' || status.value === 'connecting')

  /** The Share button appears only if the feature is on and configured. */
  const canShare = computed(() => {
    const r = settings.settings.remote
    return !!r && r.enabled && r.hostSecret.trim() !== '' && r.hubUrl.trim() !== ''
  })

  async function start() {
    const r = settings.settings.remote
    if (!canShare.value) return false
    return bridge.start({ hubUrl: r.hubUrl.trim(), hostSecret: r.hostSecret.trim() })
  }

  function stop() {
    return bridge.stop('stopped')
  }

  // Turning the feature off in settings also closes a sharing in progress.
  watch(canShare, (ok) => { if (!ok && sharing.value) void stop() })

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { void bridge.stop('app_closing') })
  }

  return { status, viewerCount, link, error, sharing, canShare, commandsEnabled, start, stop }
})
