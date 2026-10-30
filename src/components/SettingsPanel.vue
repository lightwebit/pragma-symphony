<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { invoke } from '../platform'
import { useSettingsStore, type Profile } from '../stores/settings'
import { DEFAULT_HUB_URL } from '../remote/bridge'
import { hashPin, isValidPin, PIN_MIN_DIGITS } from '../remote/pin'

const emit = defineEmits<{ close: [] }>()
const store = useSettingsStore()

const saving = ref(false)
const detecting = ref(false)

// Local copy for editing (does not modify the store until saved)
const profiles = ref<Profile[]>(
  store.settings.profiles.map(p => ({ ...p }))
)
const notificationsEnabled = ref(store.settings.notificationsEnabled ?? false)
const soundEnabled = ref(store.settings.soundEnabled ?? true)
const diffAlwaysOpen = ref(store.settings.diffAlwaysOpen ?? false)
const sessionBranchEnabled = ref(store.settings.sessionBranchEnabled ?? false)
const reviewEnabled = ref(store.settings.reviewEnabled ?? true)
const defaultIdx = ref(store.settings.defaultProfileIndex ?? 0)
const exportDir = ref(store.settings.exportDir ?? '')
const remoteEnabled = ref(store.settings.remote?.enabled ?? false)
const remoteHubUrl = ref(store.settings.remote?.hubUrl ?? DEFAULT_HUB_URL)
const remoteSecret = ref(store.settings.remote?.hostSecret ?? '')
// Commands from the web: the plain PIN lives only in the field until it is saved; after that only the hash remains.
const remoteCommands = ref(store.settings.remote?.commandsEnabled ?? false)
const pinIsSet = !!store.settings.remote?.commandPinHash
const newPin = ref('')
// The sharing privacy notice appears only the first time sharing is switched on; once
// saved as on, it does not come back.
const shareNoticeSeen = store.settings.remote?.shareNoticeSeen ?? false
const PRIVACY_URL = 'https://noema.tools/pragma-symphony/privacy'
function openPrivacy() {
  invoke('open_url', { url: PRIVACY_URL }).catch(console.error)
}

function addProfile() {
  profiles.value.push({ label: '', binary: '', configDir: null, language: 'English' })
}

function removeProfile(i: number) {
  profiles.value.splice(i, 1)
  outputStyleWarnings.value = {}
  Promise.all(profiles.value.map((_, j) => checkOutputStyle(j)))
}

async function autodetect(i: number) {
  detecting.value = true
  const path = await store.detectClaude()
  if (path) profiles.value[i].binary = path
  detecting.value = false
}

async function browseExportDir() {
  const picked = await invoke<string | null>('pick_directory')
  if (picked) exportDir.value = picked
}

const saveError = ref<string | null>(null)

const trustedDirs = ref<string[]>([])

// Non-blocking warning per profile if the CLI has an outputStyle different from the default —
// the pragma protocol has never been verified against styles other than the default.
const outputStyleWarnings = ref<Record<number, string | null>>({})

async function checkOutputStyle(i: number) {
  outputStyleWarnings.value[i] = await invoke<string | null>('check_output_style', {
    configDir: profiles.value[i]?.configDir || null,
  })
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(async () => {
  trustedDirs.value = await invoke<string[]>('get_trusted_dirs')
  await Promise.all(profiles.value.map((_, i) => checkOutputStyle(i)))
  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
})

async function removeTrustedDir(dir: string) {
  await invoke('remove_trusted_dir', { dir })
  trustedDirs.value = trustedDirs.value.filter(d => d !== dir)
}

async function saveAndClose() {
  saveError.value = null
  const pin = newPin.value.trim()
  if (pin && !isValidPin(pin)) {
    saveError.value = `The PIN must be ${PIN_MIN_DIGITS} to 12 digits.`
    return
  }
  if (remoteCommands.value && !pin && !pinIsSet) {
    saveError.value = 'Set a PIN before allowing commands from the web.'
    return
  }
  saving.value = true
  store.settings.profiles = profiles.value.map(p => ({ ...p }))
  store.settings.notificationsEnabled = notificationsEnabled.value
  store.settings.soundEnabled = soundEnabled.value
  store.settings.diffAlwaysOpen = diffAlwaysOpen.value
  store.settings.sessionBranchEnabled = sessionBranchEnabled.value
  store.settings.reviewEnabled = reviewEnabled.value
  store.settings.defaultProfileIndex = defaultIdx.value
  store.settings.exportDir = exportDir.value.trim() || null
  store.settings.remote = {
    enabled: remoteEnabled.value,
    hubUrl: remoteHubUrl.value.trim() || DEFAULT_HUB_URL,
    hostSecret: remoteSecret.value.trim(),
    commandsEnabled: remoteCommands.value,
    commandPinHash: pin ? await hashPin(pin) : (store.settings.remote?.commandPinHash ?? ''),
    shareNoticeSeen: shareNoticeSeen || remoteEnabled.value,
  }
  try {
    await store.save()
    saving.value = false
    emit('close')
  } catch (e) {
    saving.value = false
    saveError.value = `Save failed: ${String(e)}`
    console.error('[pragma] settings save:', e)
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="panel" data-testid="settings-panel">
      <div class="panel-header">
        <span>Settings</span>
        <button class="close-btn" data-testid="settings-close" @click="emit('close')">✕</button>
      </div>

      <div class="panel-body">
      <div class="section">
        <div class="section-title">Claude Profiles</div>

        <div
          v-for="(p, i) in profiles"
          :key="i"
          class="profile-card"
        >
          <!-- Main row -->
          <div class="profile-main-row">
            <button
              class="default-btn"
              :class="{ 'is-default': defaultIdx === i }"
              :title="defaultIdx === i ? 'Default profile' : 'Set as default'"
              @click="defaultIdx = i"
            >{{ defaultIdx === i ? '★' : '☆' }}</button>
            <input
              v-model="p.label"
              class="input label-input"
              placeholder="label"
            />
            <input
              v-model="p.binary"
              class="input binary-input"
              placeholder="claude binary path"
            />
            <button
              class="detect-btn"
              :disabled="detecting"
              title="Auto-detect"
              @click="autodetect(i)"
            >⌕</button>
            <button class="remove-btn" title="Remove" @click="removeProfile(i)">✕</button>
          </div>

          <!-- Config dir -->
          <div class="profile-sub-row">
            <input
              v-model="p.configDir"
              class="input config-input"
              placeholder="CLAUDE_CONFIG_DIR (optional)"
              @blur="checkOutputStyle(i)"
            />
          </div>
          <div v-if="outputStyleWarnings[i]" class="profile-sub-row output-style-warning">
            ⚠ output style "{{ outputStyleWarnings[i] }}" is active for this profile — the Pragma
            protocol markers are only verified against the default style; cards may not render.
          </div>

          <!-- Language -->
          <div class="profile-sub-row">
            <input
              v-model="p.language"
              class="input lang-input"
              placeholder="Language (e.g. English, Italiano, Français…)"
            />
          </div>

          <div class="profile-sub-row">
            <span class="prompt-hint">System prompt: <code>~/.pragma/prompts/{{ p.label.toLowerCase().replace(/\s+/g, '_') || 'label' }}.txt</code></span>
          </div>
        </div>

        <button class="add-btn" @click="addProfile">+ add profile</button>
      </div>

      <div class="section notif-section">
        <div class="section-title">Notifications</div>
        <label class="toggle-row">
          <input type="checkbox" v-model="notificationsEnabled" class="toggle-checkbox" />
          <span class="toggle-label">Notify when session ends</span>
        </label>
        <label class="toggle-row">
          <input type="checkbox" v-model="soundEnabled" class="toggle-checkbox" />
          <span class="toggle-label">Play sound when session ends</span>
        </label>
      </div>

      <div class="section">
        <div class="section-title">Stream</div>
        <label class="toggle-row">
          <input type="checkbox" v-model="diffAlwaysOpen" class="toggle-checkbox" />
          <span class="toggle-label">Always expand diff atoms</span>
        </label>
      </div>

      <div class="section">
        <div class="section-title">Git and review</div>
        <label class="toggle-row">
          <input type="checkbox" v-model="reviewEnabled" class="toggle-checkbox" data-testid="review-enabled" />
          <span class="toggle-label">Review each finished session with a separate Claude session (costs one review per session)</span>
        </label>
        <label class="toggle-row">
          <input type="checkbox" v-model="sessionBranchEnabled" class="toggle-checkbox" />
          <span class="toggle-label">Create a session branch (pragma/&lt;session-id&gt;) on versioned working directories</span>
        </label>
      </div>

      <div class="section">
        <div class="section-title">Web sharing</div>
        <label class="toggle-row">
          <input type="checkbox" v-model="remoteEnabled" class="toggle-checkbox" data-testid="remote-enabled" />
          <span class="toggle-label">Share sessions to web (adds a “share” button to the header)</span>
        </label>
        <div v-if="remoteEnabled && !shareNoticeSeen" class="share-notice" data-testid="share-privacy-notice">
          While sharing is on, everything Pragma shows — projects, sessions, prompts, output, file paths — passes
          through the noema.tools relay to reach the browser that opens your link. Nothing is stored there; the
          link dies when you stop sharing.
          <a class="share-notice-link" data-testid="share-privacy-link" @click.prevent="openPrivacy">Privacy policy</a>
        </div>
        <template v-if="remoteEnabled">
          <div class="export-row" style="margin-top:8px">
            <input
              v-model="remoteHubUrl"
              class="input export-input"
              data-testid="remote-hub-url"
              :placeholder="DEFAULT_HUB_URL"
            />
          </div>
          <div class="export-row" style="margin-top:6px">
            <input
              v-model="remoteSecret"
              type="password"
              autocomplete="off"
              class="input export-input"
              data-testid="remote-secret"
              placeholder="Access key (on request, see the README)"
            />
          </div>
          <div class="export-hint">
            Off until you press <code>share</code> in the header. While sharing, anyone who has the link can watch
            everything in this Pragma — projects, sessions, the live stream. The link dies when you stop sharing or
            close Pragma, and nothing is stored on the server. The access key is personal and available on request (see the README); it is kept in plain text in
            <code>settings.json</code>.
          </div>
          <label class="toggle-row" style="margin-top:10px">
            <input type="checkbox" v-model="remoteCommands" class="toggle-checkbox" data-testid="remote-commands" />
            <span class="toggle-label">Allow commands from the web (start, approve, answer, stop) — asks for a PIN</span>
          </label>
          <div v-if="remoteCommands" class="export-row" style="margin-top:6px">
            <input
              v-model="newPin"
              type="password"
              inputmode="numeric"
              autocomplete="off"
              maxlength="12"
              class="input export-input"
              data-testid="remote-pin"
              :placeholder="pinIsSet ? 'PIN set — type a new one to change it' : `PIN (${PIN_MIN_DIGITS}+ digits)`"
            />
          </div>
          <div v-if="remoteCommands" class="export-hint">
            Sessions started from the web run on this PC with your Claude account, in the project's working directory,
            without asking for permissions. The web page asks for the PIN once; after 5 wrong PINs commands stay locked
            until you share again. Only a hash of the PIN is saved.
          </div>
        </template>
      </div>

      <div class="section export-section">
        <div class="section-title">Export Directory</div>
        <div class="export-row">
          <input
            v-model="exportDir"
            class="input export-input"
            placeholder="Leave empty to use ~/Downloads"
          />
          <button class="browse-btn" title="Browse" @click="browseExportDir">…</button>
        </div>
        <div class="export-hint">Default: <code>~/Downloads</code> (OS-specific). Each project exports into its own subfolder here.</div>
      </div>

      <div class="section">
        <div class="section-title">Trusted Directories</div>
        <div class="export-hint" style="margin-bottom:8px">Directories auto-trusted on first use. Remove to forget.</div>
        <div v-if="trustedDirs.length === 0" class="export-hint" style="color:var(--text-muted)">None yet.</div>
        <div v-for="dir in trustedDirs" :key="dir" class="trusted-dir-row">
          <span class="trusted-dir-path">{{ dir }}</span>
          <button class="remove-trust-btn" title="Remove" @click="removeTrustedDir(dir)">✕</button>
        </div>
      </div>
      </div><!-- /panel-body -->

      <div v-if="saveError" class="save-error">⚠ {{ saveError }}</div>
      <div class="footer">
        <button class="cancel-btn" @click="emit('close')">Cancel</button>
        <button
          class="save-btn"
          data-testid="settings-save"
          :disabled="saving"
          @click="saveAndClose"
        >
          {{ saving ? '…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>

</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.panel {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  width: 640px;
  max-width: 95vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-color);
  font-weight: 600;
  font-size: 0.95rem;
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.9rem;
  padding: 2px 4px;
}
.close-btn:hover { color: var(--text-primary); }

.panel-body {
  flex: 1;
  overflow-y: auto;
}

.section {
  padding: 16px 18px;
}

.section-title {
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.profile-card {
  border: 1px solid var(--border-color);
  border-radius: 7px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: var(--bg-card);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.profile-main-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.profile-sub-row {
  display: flex;
  gap: 6px;
}

.prompt-toggle-row {
  margin-top: 2px;
}

.prompt-area-row {
  display: flex;
}

.input {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 5px 8px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.82rem;
  outline: none;
}
.input:focus { border-color: var(--color-atom-code); }

.label-input  { width: 110px; flex-shrink: 0; }
.binary-input { flex: 1; min-width: 0; font-family: monospace; font-size: 0.78rem; }
.config-input { flex: 1; min-width: 0; font-family: monospace; font-size: 0.78rem; }
.lang-input   { flex: 1; min-width: 0; }

.prompt-hint {
  font-size: 0.72rem;
  color: var(--text-secondary);
  opacity: 0.65;
}

.output-style-warning {
  font-size: 0.72rem;
  color: var(--color-action-modify);
}
.prompt-hint code {
  font-family: monospace;
  font-size: 0.72rem;
  opacity: 0.9;
}

.detect-btn {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 5px 8px;
  font-size: 0.9rem;
  flex-shrink: 0;
}
.detect-btn:hover:not(:disabled) { color: var(--text-primary); }
.detect-btn:disabled { opacity: 0.4; }

.default-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.95rem;
  padding: 2px 4px;
  flex-shrink: 0;
  line-height: 1;
  transition: color 0.12s;
}
.default-btn:hover { color: #e5a338; }
.default-btn.is-default { color: #e5a338; }

.remove-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px 6px;
  font-size: 0.82rem;
  flex-shrink: 0;
}
.remove-btn:hover { color: #e06c75; }

.add-btn {
  background: none;
  border: 1px dashed var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 5px 12px;
  font-size: 0.80rem;
  width: 100%;
  margin-top: 4px;
  transition: border-color 0.15s, color 0.15s;
}
.add-btn:hover {
  border-color: var(--color-atom-code);
  color: var(--color-atom-code);
}

.notif-section {
  border-top: 1px solid var(--border-color);
  padding-top: 14px;
}

.export-section {
  border-top: 1px solid var(--border-color);
  padding-top: 14px;
}

.export-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.export-input {
  flex: 1;
  min-width: 0;
  font-family: monospace;
  font-size: 0.78rem;
}

.browse-btn {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 5px 10px;
  font-size: 0.85rem;
  flex-shrink: 0;
}
.browse-btn:hover { color: var(--text-primary); }

.share-notice {
  margin-top: 8px;
  padding: 8px 10px;
  font-size: 0.75rem;
  line-height: 1.45;
  color: var(--text-primary);
  background: rgba(201, 138, 48, 0.1);
  border: 1px solid rgba(201, 138, 48, 0.45);
  border-radius: 6px;
}
.share-notice-link { color: var(--color-atom-code); cursor: pointer; margin-left: 4px; white-space: nowrap; }

.export-hint {
  margin-top: 5px;
  font-size: 0.72rem;
  color: var(--text-secondary);
  opacity: 0.65;
}
.export-hint code {
  font-family: monospace;
  font-size: 0.72rem;
}

.toggle-row {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.toggle-checkbox {
  width: 15px;
  height: 15px;
  cursor: pointer;
  accent-color: var(--color-atom-code);
}

.toggle-label {
  font-size: 0.85rem;
  color: var(--text-primary);
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border-color);
}

.cancel-btn {
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  padding: 6px 16px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.85rem;
}

.save-btn {
  background: var(--color-atom-code);
  border: none;
  border-radius: 6px;
  color: #fff;
  padding: 6px 20px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  min-width: 70px;
}
.save-btn:disabled { opacity: 0.6; }

.save-error {
  padding: 6px 12px;
  color: var(--error-color, #e05c5c);
  font-size: 0.8rem;
  border-top: 1px solid var(--border-color);
}

.trusted-dir-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border-bottom: 1px solid var(--border-color);
}
.trusted-dir-path {
  flex: 1;
  font-size: 0.78rem;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.remove-trust-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 2px 4px;
  line-height: 1;
}
.remove-trust-btn:hover { color: var(--error-color, #e05c5c); }
</style>

