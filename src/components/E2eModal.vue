<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { invoke } from '../platform'
import { useSessionStore } from '../stores/session'
import { useProjectStore } from '../stores/projects'
import { useSettingsStore, type Profile } from '../stores/settings'
import { E2E_DEFAULT_TIMEOUT_SECS, LS_E2E_TIMEOUT_PREFIX } from '../PRAGMA_CONSTANTS'

// Popup of the E2E button. Three tabs and not a linear wizard: the
// configuration is revisited over time, and forcing people through a procedure
// to change a command would just be friction.
//
// The three actions stay deliberately distinct:
//   Runner  — one-off discovery, proposes the runner and the command;
//   Spec    — the scenarios in natural language, saved in .autoTest/SPEC.md;
//   Run     — running the command, informational outcomes (never a gate).
// "Generate" and "run" are not the same button: generating costs tokens and is done
// rarely, running is cheap and done often.

const props = defineProps<{ open: boolean; profile: Profile | null; workingDir: string }>()
const emit = defineEmits<{ close: []; generate: [prompt: string] }>()

const session = useSessionStore()
const projects = useProjectStore()
const settings = useSettingsStore()

async function toggleEnabled() {
  settings.settings.e2eEnabled = !settings.settings.e2eEnabled
  await settings.save()
}

type Tab = 'runner' | 'spec' | 'run'
const tab = ref<Tab>('runner')

interface RunnerEntry {
  id: string
  name: string
  stack: string
  confidence: string
  note: string
}

const catalog = ref<RunnerEntry[]>([])

function confidenceLabel(confidence: string): string {
  if (confidence === 'standard') return 'Standard'
  if (confidence === 'avoid') return 'Avoid'
  return 'Suggestion'
}

const runnerId = ref('')
const command = ref('')
const precondition = ref('')
const spec = ref('')

const discovering = ref(false)
const discoveryError = ref<string | null>(null)
const discoveryRationale = ref<string | null>(null)
const detectedStack = ref<string | null>(null)
const savedNotice = ref<string | null>(null)
const preconditionAck = ref(false)

const project = computed(() => projects.currentProject)
const configured = computed(() => !!project.value?.e2eCommand)
const selectedRunner = computed(() => catalog.value.find(r => r.id === runnerId.value) ?? null)
const runnerName = computed(() => selectedRunner.value?.name ?? runnerId.value ?? 'the chosen runner')
const hasWorkingDir = computed(() => !!props.workingDir.trim())

const timeoutSecs = ref(E2E_DEFAULT_TIMEOUT_SECS)

// The timeout is a local per-project preference: a 20-minute suite is
// legitimate, but not worth a schema column. localStorage is plenty.
const timeoutKey = computed(() => `${LS_E2E_TIMEOUT_PREFIX}${project.value?.id ?? ''}`)

function notify(msg: string) {
  savedNotice.value = msg
  setTimeout(() => { savedNotice.value = null }, 2400)
}

watch(() => props.open, async (open) => {
  if (!open) return
  discoveryError.value = null
  preconditionAck.value = false

  if (catalog.value.length === 0) {
    catalog.value = await invoke<RunnerEntry[]>('e2e_runner_catalog')
  }

  const p = project.value
  runnerId.value = p?.e2eRunner ?? ''
  command.value = p?.e2eCommand ?? ''
  precondition.value = p?.e2ePrecondition ?? ''

  const stored = localStorage.getItem(timeoutKey.value)
  timeoutSecs.value = stored ? Number(stored) : E2E_DEFAULT_TIMEOUT_SECS

  if (hasWorkingDir.value) {
    spec.value = await invoke<string>('read_e2e_spec', { workingDir: props.workingDir })
  }

  // Already configured: you land straight on the run, which is the everyday use.
  tab.value = configured.value ? 'run' : 'runner'
})

watch(timeoutSecs, (v) => {
  if (project.value) localStorage.setItem(timeoutKey.value, String(v))
})

async function runDiscovery() {
  if (!props.profile || !hasWorkingDir.value) return
  discovering.value = true
  discoveryError.value = null
  try {
    const d = await invoke<{
      runnerId: string
      command: string
      precondition: string | null
      rationale: string | null
      detectedStack: string | null
    }>('discover_e2e_runner', {
      binary: props.profile.binary,
      configDir: props.profile.configDir ?? null,
      workingDir: props.workingDir,
    })
    runnerId.value = d.runnerId
    command.value = d.command
    precondition.value = d.precondition ?? ''
    discoveryRationale.value = d.rationale
    detectedStack.value = d.detectedStack
  } catch (e: any) {
    discoveryError.value = String(e)
  } finally {
    discovering.value = false
  }
}

async function saveConfig() {
  if (!project.value) return
  await projects.updateE2eConfig(
    project.value.id,
    command.value.trim() || null,
    precondition.value.trim() || null,
    runnerId.value.trim() || null,
  )
  notify('Configuration saved')
}

async function saveSpec() {
  if (!hasWorkingDir.value) return
  const path = await invoke<string>('save_e2e_spec', {
    workingDir: props.workingDir,
    text: spec.value,
  })
  notify(`Saved to ${path}`)
}

/// It generates nothing here: it prepares the prompt (and archives it in .autoTest/prompts/),
/// then hands it to App.vue which opens it in the composer. Writing an E2E suite is
/// development work — it should be seen scrolling by and corrected on the fly, not done blind.
async function prepareGeneration() {
  if (!hasWorkingDir.value) return
  await saveConfig()
  const result = await invoke<{ prompt: string; promptFile: string; specFile: string }>(
    'prepare_e2e_generation',
    {
      workingDir: props.workingDir,
      runnerName: runnerName.value,
      spec: spec.value,
      precondition: precondition.value.trim() || null,
      command: command.value.trim(),
    },
  )
  emit('generate', result.prompt)
  emit('close')
}

async function doRun() {
  if (!project.value || !props.profile || !hasWorkingDir.value) return
  await session.runE2e(
    project.value.id,
    props.workingDir,
    props.profile.binary,
    props.profile.configDir ?? undefined,
    timeoutSecs.value,
  )
}

const needsPreconditionAck = computed(
  () => !!precondition.value.trim() && !preconditionAck.value,
)

const canRun = computed(
  () => settings.settings.e2eEnabled && configured.value && hasWorkingDir.value && !!props.profile
    && !session.e2eRunning && !needsPreconditionAck.value,
)

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="emit('close')">
      <div class="e2e-modal" data-testid="e2e-modal">
        <div class="e2e-header">
          <span class="e2e-title">E2E</span>
          <span class="e2e-subtitle">on-demand · never a gate</span>
          <label class="e2e-enable-toggle" data-testid="e2e-enable-toggle">
            <input type="checkbox" :checked="settings.settings.e2eEnabled" @change="toggleEnabled" />
            <span>Enabled</span>
          </label>
          <button class="e2e-close" data-testid="e2e-close" @click="emit('close')">×</button>
        </div>

        <div class="e2e-tabs">
          <button :class="{ active: tab === 'runner' }" @click="tab = 'runner'">Runner</button>
          <button :class="{ active: tab === 'spec' }" @click="tab = 'spec'">Spec</button>
          <button :class="{ active: tab === 'run' }" :disabled="!configured" @click="tab = 'run'">Run</button>
        </div>

        <div v-if="!settings.settings.e2eEnabled" class="e2e-warn soft" data-testid="e2e-disabled-warn">
          E2E is disabled — configuration is kept, but generating or running is off until you
          re-enable it above.
        </div>

        <div v-if="!hasWorkingDir" class="e2e-warn">
          No working directory set — E2E needs one to find the project and write
          <code>.autoTest/</code>.
        </div>

        <div class="e2e-body">
          <!-- ---------------------------------------------------------- Runner -->
          <template v-if="tab === 'runner'">
            <div class="e2e-row">
              <button class="e2e-primary" :disabled="discovering || !hasWorkingDir || !profile" @click="runDiscovery">
                {{ discovering ? 'Inspecting project…' : 'Detect stack & propose runner' }}
              </button>
              <span v-if="detectedStack" class="e2e-detected">detected: {{ detectedStack }}</span>
            </div>
            <div v-if="discoveryError" class="e2e-error">{{ discoveryError }}</div>
            <div v-if="discoveryRationale" class="e2e-rationale">{{ discoveryRationale }}</div>

            <label class="e2e-label">Runner</label>
            <div class="e2e-runner-list">
              <label
                v-for="r in catalog"
                :key="r.id"
                class="e2e-runner"
                :class="{ selected: runnerId === r.id }"
              >
                <input type="radio" :value="r.id" v-model="runnerId" />
                <span class="e2e-runner-main">
                  <span class="e2e-runner-name">{{ r.name }}</span>
                  <span class="e2e-conf" :class="r.confidence">{{ confidenceLabel(r.confidence) }}</span>
                </span>
                <span class="e2e-runner-stack">{{ r.stack }}</span>
                <span v-if="r.note" class="e2e-runner-note">{{ r.note }}</span>
              </label>
            </div>
            <p class="e2e-hint">
              <strong>Standard</strong> is validated by direct experience and safe to default to.
              <strong>Suggestion</strong> is a reasonable recommendation we have never validated in
              the field — you decide. <strong>Avoid</strong> was tried and does not work; its note
              says what to use instead.
            </p>

            <label class="e2e-label">Run command</label>
            <input v-model="command" class="e2e-input" placeholder="npx playwright test" />

            <label class="e2e-label">Precondition <span class="e2e-optional">(shown before every run)</span></label>
            <input v-model="precondition" class="e2e-input" placeholder="dev server on localhost:5173" />

            <div class="e2e-actions">
              <button class="e2e-primary" :disabled="!project" @click="saveConfig">Save configuration</button>
            </div>
          </template>

          <!-- ------------------------------------------------------------ Spec -->
          <template v-else-if="tab === 'spec'">
            <label class="e2e-label">
              Scenarios in plain language — saved to <code>.autoTest/SPEC.md</code>
            </label>
            <textarea
              v-model="spec"
              class="e2e-textarea"
              placeholder="Open Settings, change the export dir, verify the toast appears.&#10;Create a project without a working dir and check the empty state."
            />
            <p class="e2e-hint">
              Generation writes the suite under <code>.autoTest/scripts/</code> and the prompt used
              under <code>.autoTest/prompts/</code>. It runs as a normal Pragma session, so you see
              it work and can correct it mid-flight.
            </p>
            <div class="e2e-actions">
              <button class="e2e-ghost" :disabled="!hasWorkingDir" @click="saveSpec">Save spec</button>
              <button
                class="e2e-primary"
                :disabled="!settings.settings.e2eEnabled || !hasWorkingDir || !command.trim() || session.running"
                :title="!settings.settings.e2eEnabled ? 'E2E is disabled' : session.running ? 'A session is already running' : ''"
                @click="prepareGeneration"
              >
                Generate scripts →
              </button>
            </div>
          </template>

          <!-- ------------------------------------------------------------- Run -->
          <template v-else>
            <div class="e2e-cmd-row">
              <span class="e2e-label inline">Command</span>
              <code class="e2e-cmd">{{ command || '—' }}</code>
            </div>

            <div v-if="precondition.trim()" class="e2e-precondition">
              <div class="e2e-precondition-text">⚠ Requires: {{ precondition }}</div>
              <label class="e2e-ack">
                <input type="checkbox" v-model="preconditionAck" />
                It's ready — Pragma does not start it for you.
              </label>
            </div>

            <div v-if="session.running" class="e2e-warn soft">
              A session is currently writing files in this directory — results may reflect
              half-finished code.
            </div>

            <div class="e2e-row">
              <label class="e2e-label inline">Timeout</label>
              <input v-model.number="timeoutSecs" type="number" min="30" step="30" class="e2e-number" />
              <span class="e2e-optional">seconds</span>
            </div>

            <div class="e2e-actions">
              <button v-if="session.e2eRunning" class="e2e-ghost" @click="session.stopE2e()">Stop</button>
              <button class="e2e-primary" :disabled="!canRun" @click="doRun">
                {{ session.e2eRunning ? 'Running…' : 'Run E2E' }}
              </button>
            </div>

            <div v-if="session.pragmaE2e" class="e2e-result" :class="{
              passed: session.pragmaE2e.passed && !session.pragmaE2e.undetermined,
              failed: !session.pragmaE2e.passed && !session.pragmaE2e.undetermined,
              undetermined: session.pragmaE2e.undetermined,
            }">
              <div class="e2e-result-head">
                <template v-if="session.pragmaE2e.timedOut">⚠ Timed out</template>
                <template v-else-if="session.pragmaE2e.undetermined">⚠ Undetermined</template>
                <template v-else-if="session.pragmaE2e.passed">✓ Passed</template>
                <template v-else>✗ {{ session.pragmaE2e.failedScenarios.length }} failing scenario(s)</template>
                <span class="e2e-optional">{{ formatDuration(session.pragmaE2e.durationMs) }}</span>
              </div>
              <ul v-if="session.pragmaE2e.failedScenarios.length" class="e2e-failures">
                <li v-for="s in session.pragmaE2e.failedScenarios" :key="s">{{ s }}</li>
              </ul>
              <div v-if="session.pragmaE2e.runFile" class="e2e-optional">
                archived to {{ session.pragmaE2e.runFile }}
              </div>
            </div>
          </template>
        </div>

        <div v-if="savedNotice" class="e2e-notice">{{ savedNotice }}</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 800;
  background: rgba(20, 22, 28, 0.72);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.e2e-modal {
  width: min(640px, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
}

.e2e-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}
.e2e-title {
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--text-primary);
}
.e2e-subtitle {
  flex: 1;
  font-size: 0.68rem;
  color: var(--text-secondary);
}
.e2e-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 1.2rem;
  line-height: 1;
  cursor: pointer;
}
.e2e-close:hover { color: var(--text-primary); }

.e2e-enable-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.7rem;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}

.e2e-tabs {
  display: flex;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-color);
}
.e2e-tabs button {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-size: 0.74rem;
  padding: 8px 12px;
  cursor: pointer;
}
.e2e-tabs button.active {
  color: var(--text-primary);
  border-bottom-color: var(--accent-color, #7ec8a0);
}
.e2e-tabs button:disabled { opacity: 0.4; cursor: not-allowed; }

.e2e-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.e2e-label {
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  text-transform: uppercase;
}
.e2e-label.inline { text-transform: none; letter-spacing: 0; }
.e2e-optional {
  font-size: 0.66rem;
  font-weight: 400;
  color: var(--text-secondary);
  text-transform: none;
  letter-spacing: 0;
}

.e2e-input, .e2e-textarea, .e2e-number {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  color: var(--text-primary);
  font-size: 0.78rem;
  padding: 6px 8px;
  font-family: inherit;
  width: 100%;
}
.e2e-number { width: 90px; }
.e2e-textarea {
  min-height: 160px;
  resize: vertical;
  line-height: 1.5;
}

.e2e-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.e2e-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}

.e2e-primary, .e2e-ghost {
  border-radius: 5px;
  font-size: 0.74rem;
  padding: 6px 12px;
  cursor: pointer;
  border: 1px solid var(--border-color);
}
.e2e-primary {
  background: rgba(126, 200, 160, 0.12);
  border-color: #7ec8a0;
  color: #7ec8a0;
}
.e2e-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.e2e-ghost {
  background: none;
  color: var(--text-secondary);
}
.e2e-ghost:hover { color: var(--text-primary); }

.e2e-runner-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 210px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 5px;
}
.e2e-runner {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 4px 8px;
  padding: 5px 7px;
  border-radius: 4px;
  cursor: pointer;
}
.e2e-runner:hover { background: rgba(255, 255, 255, 0.04); }
.e2e-runner.selected { background: rgba(126, 200, 160, 0.09); }
.e2e-runner-main { display: flex; align-items: center; gap: 7px; }
.e2e-runner-name { font-size: 0.78rem; color: var(--text-primary); }
.e2e-runner-stack { font-size: 0.66rem; color: var(--text-secondary); }
.e2e-runner-note {
  grid-column: 2 / -1;
  font-size: 0.65rem;
  color: var(--text-secondary);
  opacity: 0.8;
}

.e2e-conf {
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid currentColor;
}
.e2e-conf.standard { color: #7ec8a0; }
.e2e-conf.suggestion { color: #c98a30; }
/* Red switched off: it is a documented dead end, not an error in progress. */
.e2e-conf.avoid { color: #b5564a; }

.e2e-hint {
  margin: 2px 0 0;
  font-size: 0.68rem;
  line-height: 1.5;
  color: var(--text-secondary);
}
.e2e-hint code, .e2e-label code {
  font-size: 0.94em;
  background: rgba(0, 0, 0, 0.2);
  padding: 0 3px;
  border-radius: 3px;
}

.e2e-warn {
  margin: 10px 16px 0;
  padding: 7px 10px;
  border-radius: 5px;
  font-size: 0.72rem;
  line-height: 1.45;
  color: #c98a30;
  background: rgba(201, 138, 48, 0.1);
  border: 1px solid rgba(201, 138, 48, 0.35);
}
.e2e-warn.soft { margin: 0; }

.e2e-error {
  font-size: 0.72rem;
  color: #e05252;
  line-height: 1.45;
}
.e2e-rationale {
  font-size: 0.72rem;
  color: var(--text-secondary);
  line-height: 1.45;
  font-style: italic;
}
.e2e-detected { font-size: 0.68rem; color: var(--text-secondary); }

.e2e-cmd-row { display: flex; align-items: center; gap: 8px; }
.e2e-cmd {
  font-size: 0.76rem;
  background: rgba(0, 0, 0, 0.22);
  border-radius: 4px;
  padding: 3px 7px;
  color: var(--text-primary);
  word-break: break-all;
}

.e2e-precondition {
  border: 1px solid rgba(201, 138, 48, 0.35);
  background: rgba(201, 138, 48, 0.08);
  border-radius: 5px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.e2e-precondition-text { font-size: 0.74rem; color: #c98a30; }
.e2e-ack {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.7rem;
  color: var(--text-secondary);
  cursor: pointer;
}

.e2e-result {
  border: 1px solid var(--border-color);
  border-radius: 5px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.e2e-result-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 0.78rem;
  font-weight: 600;
}
.e2e-result.passed .e2e-result-head { color: #4caf50; }
.e2e-result.failed .e2e-result-head { color: #d08770; }
.e2e-result.undetermined .e2e-result-head { color: #c98a30; }
.e2e-failures {
  margin: 0;
  padding-left: 18px;
  font-size: 0.72rem;
  color: var(--text-primary);
}

.e2e-notice {
  padding: 7px 16px;
  border-top: 1px solid var(--border-color);
  font-size: 0.7rem;
  color: #7ec8a0;
}
</style>
