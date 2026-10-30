<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { invoke } from '../platform'
import { useSessionStore, type PipelineStep } from '../stores/session'
import { useProjectStore } from '../stores/projects'
import type { Profile } from '../stores/settings'

// Popup of the local pipeline: an ordered sequence of commands run locally
// before commit/push.
//
// The steps are edited as a list and saved in one go — the order is part of the
// data, and a CRUD per step would force reconciling positions after every reorder.
//
// A `verify` step has no command of its own: it uses the project's test command
// going through the VERIFY phase, hence through the baseline of pre-existing
// failures. That is what makes the pipeline usable on a repo that already has
// known reds.

const props = defineProps<{ open: boolean; profile: Profile | null; workingDir: string }>()
const emit = defineEmits<{ close: [] }>()

const session = useSessionStore()
const projects = useProjectStore()

const steps = ref<PipelineStep[]>([])
// Until the saved steps have arrived, editing the list is a race: the
// load would overwrite it, and a Save would save a partial list.
const loading = ref(false)
const savedNotice = ref<string | null>(null)
const runError = ref<string | null>(null)
const openStep = ref<number | null>(null)
const outputRefs = ref<Record<number, HTMLElement | null>>({})

// Passive detection of an existing remote CI — file reads only, no API.
// Purely informational: it does not change what the local pipeline does, it only
// lets people know the repo already has one.
const remoteCi = ref<{ githubActions: boolean; azurePipelines: boolean } | null>(null)
const remoteCiLabel = computed(() => {
  if (!remoteCi.value) return null
  const found: string[] = []
  if (remoteCi.value.githubActions) found.push('GitHub Actions')
  if (remoteCi.value.azurePipelines) found.push('Azure Pipelines')
  return found.length ? found.join(' + ') : null
})

const project = computed(() => projects.currentProject)
const hasWorkingDir = computed(() => !!props.workingDir.trim())
const hasEnabledStep = computed(() => steps.value.some(s => s.enabled))

function notify(msg: string) {
  savedNotice.value = msg
  setTimeout(() => { savedNotice.value = null }, 2400)
}

watch(() => props.open, async (open) => {
  if (!open) return
  runError.value = null
  openStep.value = null
  if (project.value) {
    steps.value = []
    loading.value = true
    try {
      steps.value = await invoke<PipelineStep[]>('get_pipeline_steps', { projectId: project.value.id })
    } finally {
      loading.value = false
    }
  }
  remoteCi.value = hasWorkingDir.value
    ? await invoke<{ githubActions: boolean; azurePipelines: boolean }>(
        'detect_remote_ci',
        { workingDir: props.workingDir },
      )
    : null
})

// Follows the running step: without it, on a long pipeline you lose track of
// which command is running right when you need to know.
watch(() => session.pipelineStepIdx, (idx) => {
  if (idx !== null) openStep.value = idx
})

watch(() => session.pipelineOutput, () => {
  nextTick(() => {
    const idx = openStep.value
    if (idx === null) return
    const el = outputRefs.value[idx]
    if (el) el.scrollTop = el.scrollHeight
  })
}, { deep: true })

function newStep(): PipelineStep {
  return {
    id: crypto.randomUUID(),
    label: '',
    command: '',
    kind: 'command',
    enabled: true,
  }
}

function addStep() { steps.value.push(newStep()) }
function removeStep(i: number) { steps.value.splice(i, 1) }
function moveStep(i: number, delta: number) {
  const j = i + delta
  if (j < 0 || j >= steps.value.length) return
  const [s] = steps.value.splice(i, 1)
  steps.value.splice(j, 0, s)
}

/// Proposal for the project's stack — hard-wired on the Rust side. Outside the catalogue it
/// proposes nothing: the steps are written by hand, no invented default.
async function loadTemplate() {
  const tpl = await invoke<{ label: string; command: string; kind: string }[] | null>(
    'pipeline_template_for_stack',
    { stack: project.value?.projectStack ?? null },
  )
  if (!tpl || tpl.length === 0) {
    notify('No template for this stack — add steps manually')
    return
  }
  steps.value = tpl.map(t => ({ ...newStep(), label: t.label, command: t.command, kind: t.kind }))
  notify('Template loaded — review and save')
}

async function saveSteps() {
  if (!project.value) return
  await invoke('save_pipeline_steps', {
    projectId: project.value.id,
    steps: steps.value.filter(s => s.label.trim() || s.command.trim() || s.kind === 'verify'),
  })
  notify('Pipeline saved')
}

const canRun = computed(
  () => !!project.value && hasWorkingDir.value && !!props.profile
    && hasEnabledStep.value && !session.pipelineRunning && !loading.value,
)

async function doRun() {
  if (!project.value || !props.profile || !hasWorkingDir.value) return
  runError.value = null
  // Saves before running: the pipeline runs on what is in the DB, and running
  // something different from what is on screen would be a lie.
  await saveSteps()
  try {
    await session.runPipeline(
      project.value.id,
      props.workingDir,
      props.profile.binary,
      props.profile.configDir ?? undefined,
    )
  } catch (e) {
    runError.value = String(e)
  }
}

function outcomeFor(i: number) {
  return session.pipelineOutcome?.steps[i] ?? null
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
      <div class="pl-modal" data-testid="pipeline-modal">
        <div class="pl-header">
          <span class="pl-title">PIPELINE</span>
          <span class="pl-subtitle">local · fail-fast · before commit</span>
          <button class="pl-close" data-testid="pipeline-close" @click="emit('close')">×</button>
        </div>

        <div v-if="!hasWorkingDir" class="pl-warn">
          No working directory set — the pipeline needs one to run.
        </div>

        <div class="pl-body">
          <div v-if="remoteCiLabel" class="pl-ci-note" data-testid="pipeline-remote-ci-note">
            ℹ Existing CI detected in this repo: {{ remoteCiLabel }}. Informational only — Pragma
            doesn't touch it, this pipeline is a separate local-only sequence.
          </div>

          <div class="pl-toolbar">
            <button class="pl-ghost" data-testid="pipeline-add-step" :disabled="loading" @click="addStep">+ Step</button>
            <button class="pl-ghost" :disabled="loading || !project?.projectStack" @click="loadTemplate">
              Load template for stack
            </button>
            <div class="pl-spacer" />
            <button class="pl-ghost" :disabled="loading || !project" @click="saveSteps">Save</button>
          </div>

          <div v-if="loading" class="pl-empty">Loading steps…</div>
          <div v-else-if="steps.length === 0" class="pl-empty">
            No steps yet. Add one, or load the template for this project's stack.
          </div>

          <div v-for="(s, i) in steps" :key="s.id" class="pl-step" :class="{
            'is-running': session.pipelineRunning && session.pipelineStepIdx === i,
            'is-passed': outcomeFor(i)?.passed,
            'is-failed': outcomeFor(i) && !outcomeFor(i)!.passed && !outcomeFor(i)!.skipped,
            'is-skipped': outcomeFor(i)?.skipped,
          }">
            <div class="pl-step-head">
              <input v-model="s.enabled" type="checkbox" :title="s.enabled ? 'Enabled' : 'Disabled'" />
              <input v-model="s.label" class="pl-input pl-label-input" data-testid="pipeline-step-label" placeholder="Step name" />
              <select v-model="s.kind" class="pl-select">
                <option value="command">command</option>
                <option value="verify">verify</option>
              </select>
              <button class="pl-icon" title="Move up" :disabled="i === 0" @click="moveStep(i, -1)">↑</button>
              <button class="pl-icon" title="Move down" :disabled="i === steps.length - 1" @click="moveStep(i, 1)">↓</button>
              <button class="pl-icon pl-danger" title="Remove" @click="removeStep(i)">✕</button>
            </div>

            <input
              v-if="s.kind !== 'verify'"
              v-model="s.command"
              class="pl-input"
              data-testid="pipeline-step-command"
              placeholder="npm run build"
            />
            <div v-else class="pl-verify-note">
              Uses the project's <strong>test command</strong> through VERIFY — only failures
              that are <em>new</em> versus the baseline block the pipeline.
            </div>

            <div v-if="outcomeFor(i)" class="pl-step-result" data-testid="pipeline-step-result">
              <template v-if="outcomeFor(i)!.skipped">⏭ skipped</template>
              <template v-else-if="outcomeFor(i)!.passed">✓ passed</template>
              <template v-else-if="outcomeFor(i)!.timedOut">⚠ timed out</template>
              <template v-else-if="outcomeFor(i)!.cancelled">⏹ stopped</template>
              <template v-else>✗ exit {{ outcomeFor(i)!.exitCode ?? '?' }}</template>
              <span v-if="!outcomeFor(i)!.skipped" class="pl-optional">
                {{ formatDuration(outcomeFor(i)!.durationMs) }}
              </span>
              <button
                v-if="session.pipelineOutput[i]?.length"
                class="pl-icon"
                @click="openStep = openStep === i ? null : i"
              >{{ openStep === i ? 'hide output' : 'show output' }}</button>
            </div>

            <ul v-if="outcomeFor(i)?.newFailures?.length" class="pl-failures">
              <li v-for="f in outcomeFor(i)!.newFailures" :key="f">{{ f }}</li>
            </ul>

            <div
              v-if="openStep === i && session.pipelineOutput[i]?.length"
              :ref="el => outputRefs[i] = el as HTMLElement"
              class="pl-output"
            >
              <div
                v-for="(l, li) in session.pipelineOutput[i]"
                :key="li"
                class="pl-output-line"
                :class="{ 'is-stderr': l.stderr }"
              >{{ l.line }}</div>
            </div>
          </div>

          <div v-if="runError" class="pl-error">{{ runError }}</div>

          <div class="pl-actions">
            <button v-if="session.pipelineRunning" class="pl-ghost" @click="session.stopPipeline()">Stop</button>
            <button class="pl-primary" data-testid="pipeline-run" :disabled="!canRun" @click="doRun">
              {{ session.pipelineRunning ? 'Running…' : 'Run pipeline' }}
            </button>
          </div>

          <div v-if="session.pipelineOutcome && !session.pipelineRunning" class="pl-result" data-testid="pipeline-result" :class="{
            passed: session.pipelineOutcome.passed,
            failed: !session.pipelineOutcome.passed,
          }">
            <template v-if="session.pipelineOutcome.passed">✓ Pipeline passed</template>
            <template v-else>✗ Pipeline failed{{ session.pipelineOutcome.stoppedEarly ? ' — stopped early' : '' }}</template>
            <span class="pl-optional">{{ formatDuration(session.pipelineOutcome.durationMs) }}</span>
          </div>
        </div>

        <div v-if="savedNotice" class="pl-notice">{{ savedNotice }}</div>
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

.pl-modal {
  width: min(720px, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
}

.pl-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}
.pl-title { font-size: 0.8rem; font-weight: 700; letter-spacing: 0.12em; color: var(--text-primary); }
.pl-subtitle { flex: 1; font-size: 0.68rem; color: var(--text-secondary); }
.pl-close {
  background: none; border: none; color: var(--text-secondary);
  font-size: 1.2rem; line-height: 1; cursor: pointer;
}
.pl-close:hover { color: var(--text-primary); }

.pl-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pl-ci-note {
  font-size: 0.7rem;
  line-height: 1.45;
  color: var(--text-secondary);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  padding: 6px 9px;
}

.pl-toolbar { display: flex; align-items: center; gap: 8px; }
.pl-spacer { flex: 1; }

.pl-empty {
  font-size: 0.74rem;
  color: var(--text-secondary);
  font-style: italic;
  padding: 12px 0;
}

.pl-step {
  border: 1px solid var(--border-color);
  border-left: 3px solid var(--border-color);
  border-radius: 6px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pl-step.is-running { border-left-color: #c98a30; }
.pl-step.is-passed  { border-left-color: #7ec8a0; }
.pl-step.is-failed  { border-left-color: #d08770; }
.pl-step.is-skipped { opacity: 0.55; }

.pl-step-head { display: flex; align-items: center; gap: 6px; }

.pl-input, .pl-select {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  color: var(--text-primary);
  font-size: 0.78rem;
  padding: 5px 8px;
  font-family: inherit;
  width: 100%;
}
.pl-label-input { flex: 1; }
.pl-select { width: auto; flex-shrink: 0; }

.pl-icon {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.72rem;
  padding: 2px 5px;
  border-radius: 4px;
  flex-shrink: 0;
}
.pl-icon:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-card); }
.pl-icon:disabled { opacity: 0.3; cursor: not-allowed; }
.pl-danger:hover { color: #e05555; }

.pl-verify-note {
  font-size: 0.7rem;
  color: var(--text-secondary);
  line-height: 1.45;
  background: rgba(126, 200, 160, 0.07);
  border-radius: 5px;
  padding: 5px 8px;
}

.pl-step-result {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.74rem;
  font-weight: 600;
  color: var(--text-secondary);
}
.pl-optional { font-size: 0.66rem; font-weight: 400; color: var(--text-secondary); }

.pl-failures {
  margin: 0;
  padding-left: 18px;
  font-size: 0.72rem;
  color: #d08770;
}

.pl-output {
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  padding: 6px 8px;
  max-height: 200px;
  overflow-y: auto;
  font-family: 'SF Mono', Consolas, monospace;
  font-size: 0.7rem;
  line-height: 1.5;
}
.pl-output-line { color: var(--text-primary); white-space: pre-wrap; word-break: break-all; }
.pl-output-line.is-stderr { color: #d08770; }

.pl-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }

.pl-primary, .pl-ghost {
  border-radius: 5px;
  font-size: 0.74rem;
  padding: 6px 12px;
  cursor: pointer;
  border: 1px solid var(--border-color);
}
.pl-primary {
  background: rgba(126, 200, 160, 0.12);
  border-color: #7ec8a0;
  color: #7ec8a0;
}
.pl-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.pl-ghost { background: none; color: var(--text-secondary); }
.pl-ghost:hover:not(:disabled) { color: var(--text-primary); }
.pl-ghost:disabled { opacity: 0.4; cursor: not-allowed; }

.pl-warn {
  margin: 10px 16px 0;
  padding: 7px 10px;
  border-radius: 5px;
  font-size: 0.72rem;
  color: #c98a30;
  background: rgba(201, 138, 48, 0.1);
  border: 1px solid rgba(201, 138, 48, 0.35);
}

.pl-error { font-size: 0.72rem; color: #e05252; line-height: 1.45; }

.pl-result {
  border: 1px solid var(--border-color);
  border-radius: 5px;
  padding: 8px 10px;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 0.78rem;
  font-weight: 600;
}
.pl-result.passed { color: #4caf50; }
.pl-result.failed { color: #d08770; }

.pl-notice {
  padding: 7px 16px;
  border-top: 1px solid var(--border-color);
  font-size: 0.7rem;
  color: #7ec8a0;
}
</style>
