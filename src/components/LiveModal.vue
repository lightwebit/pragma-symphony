<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useSessionStore } from '../stores/session'
import { useProjectStore } from '../stores/projects'
import {
  LIVE_DEFAULT_TIMEOUT_SECS,
  LS_LIVE_TIMEOUT_PREFIX,
  LS_LIVE_UNBOUNDED_PREFIX,
} from '../PRAGMA_CONSTANTS'

// Popup of the Live button — on-demand build/start of the project command,
// with an output panel. Much simpler than E2eModal: a single command, no
// runner catalogue, no classification — the outcome is the exit code, not a judgement.
//
// unbounded/one-shot (long-running vs stops-by-itself) is not deduced from the
// stack in v1: the user declares it, as a later phase.

const props = defineProps<{ open: boolean; workingDir: string }>()
const emit = defineEmits<{ close: [] }>()

const session = useSessionStore()
const projects = useProjectStore()

const command = ref('')
const unbounded = ref(false)
const timeoutSecs = ref(LIVE_DEFAULT_TIMEOUT_SECS)
const savedNotice = ref<string | null>(null)
const runError = ref<string | null>(null)
const outputEl = ref<HTMLElement | null>(null)

const project = computed(() => projects.currentProject)
const configured = computed(() => !!project.value?.liveCommand)
const hasWorkingDir = computed(() => !!props.workingDir.trim())

const timeoutKey = computed(() => `${LS_LIVE_TIMEOUT_PREFIX}${project.value?.id ?? ''}`)
const unboundedKey = computed(() => `${LS_LIVE_UNBOUNDED_PREFIX}${project.value?.id ?? ''}`)

function notify(msg: string) {
  savedNotice.value = msg
  setTimeout(() => { savedNotice.value = null }, 2400)
}

watch(() => props.open, (open) => {
  if (!open) return
  runError.value = null
  command.value = project.value?.liveCommand ?? ''

  const storedTimeout = localStorage.getItem(timeoutKey.value)
  timeoutSecs.value = storedTimeout ? Number(storedTimeout) : LIVE_DEFAULT_TIMEOUT_SECS
  unbounded.value = localStorage.getItem(unboundedKey.value) === '1'
})

watch(timeoutSecs, (v) => {
  if (project.value) localStorage.setItem(timeoutKey.value, String(v))
})
watch(unbounded, (v) => {
  if (project.value) localStorage.setItem(unboundedKey.value, v ? '1' : '0')
})

// Follows the last line as it arrives: it is the whole value of the panel, if it scrolls
// away by itself it stops being useful halfway through a build.
watch(() => session.liveOutputLines.length, () => {
  nextTick(() => {
    if (outputEl.value) outputEl.value.scrollTop = outputEl.value.scrollHeight
  })
})

async function saveConfig() {
  if (!project.value) return
  await projects.updateLiveCommand(project.value.id, command.value.trim() || null)
  notify('Configuration saved')
}

const canRun = computed(
  () => configured.value && hasWorkingDir.value && !session.liveRunning,
)

async function doRun() {
  if (!project.value || !hasWorkingDir.value) return
  runError.value = null
  try {
    await session.runLive(
      project.value.id,
      props.workingDir,
      unbounded.value,
      unbounded.value ? undefined : timeoutSecs.value,
    )
  } catch (e) {
    runError.value = String(e)
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="emit('close')">
      <div class="live-modal" data-testid="live-modal">
        <div class="live-header">
          <span class="live-title">LIVE</span>
          <span class="live-subtitle">run &amp; watch · not part of VERIFY/REVIEW</span>
          <button class="live-close" data-testid="live-close" @click="emit('close')">×</button>
        </div>

        <div v-if="!hasWorkingDir" class="live-warn">
          No working directory set — Live needs one to run the command.
        </div>

        <div class="live-body">
          <label class="live-label">Command</label>
          <input
            v-model="command"
            class="live-input"
            data-testid="live-command-input"
            placeholder="npm run tauri dev"
          />

          <div class="live-row">
            <label class="live-check">
              <input type="checkbox" v-model="unbounded" />
              Long-running (dev server) — no timeout, stop it manually
            </label>
          </div>

          <div v-if="!unbounded" class="live-row">
            <label class="live-label inline">Timeout</label>
            <input v-model.number="timeoutSecs" type="number" min="10" step="10" class="live-number" />
            <span class="live-optional">seconds</span>
          </div>

          <div class="live-actions">
            <button class="live-primary" data-testid="live-save-config" :disabled="!project" @click="saveConfig">Save configuration</button>
          </div>

          <div v-if="session.liveRunning" class="live-warn soft">
            A session may also be writing files in this directory — output can reflect
            half-finished code.
          </div>

          <div v-if="runError" class="live-error">{{ runError }}</div>

          <div class="live-actions">
            <button v-if="session.liveRunning" class="live-ghost" @click="session.stopLive()">Stop</button>
            <button class="live-primary" data-testid="live-run" :disabled="!canRun" @click="doRun">
              {{ session.liveRunning ? 'Running…' : 'Run' }}
            </button>
          </div>

          <div
            v-if="session.liveOutputLines.length || session.liveRunning"
            ref="outputEl"
            class="live-output"
            data-testid="live-output"
          >
            <div
              v-for="(l, i) in session.liveOutputLines"
              :key="i"
              class="live-output-line"
              :class="{ 'is-stderr': l.stderr }"
            >{{ l.line }}</div>
          </div>

          <div v-if="session.pragmaLive && !session.liveRunning" class="live-result" data-testid="live-result" :class="{
            passed: !session.pragmaLive.timedOut && !session.pragmaLive.cancelled && session.pragmaLive.exitCode === 0,
            failed: session.pragmaLive.timedOut || session.pragmaLive.cancelled || session.pragmaLive.exitCode !== 0,
          }">
            <template v-if="session.pragmaLive.timedOut">⚠ Timed out</template>
            <template v-else-if="session.pragmaLive.cancelled">⏹ Stopped</template>
            <template v-else-if="session.pragmaLive.exitCode === 0">✓ Exit 0</template>
            <template v-else>✗ Exit {{ session.pragmaLive.exitCode ?? '?' }}</template>
            <span class="live-optional">{{ formatDuration(session.pragmaLive.durationMs) }}</span>
          </div>
        </div>

        <div v-if="savedNotice" class="live-notice">{{ savedNotice }}</div>
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

.live-modal {
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

.live-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}
.live-title {
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--text-primary);
}
.live-subtitle {
  flex: 1;
  font-size: 0.68rem;
  color: var(--text-secondary);
}
.live-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 1.2rem;
  line-height: 1;
  cursor: pointer;
}
.live-close:hover { color: var(--text-primary); }

.live-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.live-label {
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  text-transform: uppercase;
}
.live-label.inline { text-transform: none; letter-spacing: 0; }
.live-optional {
  font-size: 0.66rem;
  font-weight: 400;
  color: var(--text-secondary);
  text-transform: none;
  letter-spacing: 0;
}

.live-input, .live-number {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  color: var(--text-primary);
  font-size: 0.78rem;
  padding: 6px 8px;
  font-family: inherit;
  width: 100%;
}
.live-number { width: 90px; }

.live-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.live-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.74rem;
  color: var(--text-secondary);
  cursor: pointer;
}

.live-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}

.live-primary, .live-ghost {
  border-radius: 5px;
  font-size: 0.74rem;
  padding: 6px 12px;
  cursor: pointer;
  border: 1px solid var(--border-color);
}
.live-primary {
  background: rgba(126, 200, 160, 0.12);
  border-color: #7ec8a0;
  color: #7ec8a0;
}
.live-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.live-ghost {
  background: none;
  color: var(--text-secondary);
}
.live-ghost:hover { color: var(--text-primary); }

.live-warn {
  margin: 10px 16px 0;
  padding: 7px 10px;
  border-radius: 5px;
  font-size: 0.72rem;
  line-height: 1.45;
  color: #c98a30;
  background: rgba(201, 138, 48, 0.1);
  border: 1px solid rgba(201, 138, 48, 0.35);
}
.live-warn.soft { margin: 0; }

.live-error {
  font-size: 0.72rem;
  color: #e05252;
  line-height: 1.45;
}

.live-output {
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px 10px;
  min-height: 120px;
  max-height: 280px;
  overflow-y: auto;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.72rem;
  line-height: 1.5;
}
.live-output-line { color: var(--text-primary); white-space: pre-wrap; word-break: break-all; }
.live-output-line.is-stderr { color: #d08770; }

.live-result {
  border: 1px solid var(--border-color);
  border-radius: 5px;
  padding: 8px 10px;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 0.78rem;
  font-weight: 600;
}
.live-result.passed { color: #4caf50; }
.live-result.failed { color: #d08770; }

.live-notice {
  padding: 7px 16px;
  border-top: 1px solid var(--border-color);
  font-size: 0.7rem;
  color: #7ec8a0;
}
</style>
