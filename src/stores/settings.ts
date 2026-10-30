import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '../platform'

export interface Profile {
  label: string
  binary: string
  configDir: string | null
  language: string | null
}

export interface Settings {
  profiles: Profile[]
  dbPath: string | null
  notificationsEnabled: boolean
  soundEnabled: boolean
  defaultProfileIndex: number
  exportDir: string | null
  diffAlwaysOpen: boolean
  lastWorkingDir: string | null
  sessionBranchEnabled: boolean
  reviewEnabled: boolean
  e2eEnabled: boolean
  /** Sharing on the web. Off by default; the access key is kept in plain text in settings.json. */
  remote: RemoteSettings
}

export interface RemoteSettings {
  enabled: boolean
  hubUrl: string
  hostSecret: string
  /** «Allow commands from web». Only counts with a PIN set. */
  commandsEnabled: boolean
  /** `salt:sha256(salt+PIN)`, or empty: the plain PIN is not saved. */
  commandPinHash: string
  /** The sharing privacy notice has already been shown once. */
  shareNoticeSeen: boolean
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>({ profiles: [], dbPath: null, notificationsEnabled: false, soundEnabled: true, defaultProfileIndex: 0, exportDir: null, diffAlwaysOpen: false, lastWorkingDir: null, sessionBranchEnabled: false, reviewEnabled: true, e2eEnabled: true, remote: { enabled: false, hubUrl: 'https://noema.tools/hubs/pragma-live', hostSecret: '', commandsEnabled: false, commandPinHash: '', shareNoticeSeen: false } })
  const loaded = ref(false)
  const savedAt = ref(0)

  async function load() {
    try {
      settings.value = await invoke<Settings>('get_settings')
      loaded.value = true
    } catch (e) {
      console.error('get_settings:', e)
    }
  }

  async function save() {
    await invoke('save_settings_cmd', { settings: settings.value })
    savedAt.value++
  }

  async function detectClaude(): Promise<string | null> {
    return invoke<string | null>('detect_claude')
  }

  function addProfile(profile: Profile) {
    settings.value.profiles.push(profile)
  }

  function removeProfile(index: number) {
    settings.value.profiles.splice(index, 1)
  }

  function updateProfile(index: number, profile: Profile) {
    settings.value.profiles[index] = profile
  }

  return {
    settings,
    loaded,
    savedAt,
    load,
    save,
    detectClaude,
    addProfile,
    removeProfile,
    updateProfile,
  }
})
