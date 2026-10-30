<script setup lang="ts">
import { ref, computed } from 'vue'
import { useSessionStore } from '../stores/session'
import { canCommand } from '../webCaps'
import type { PragmaPlan, PragmaStepComplete, PragmaPhase, SessionModel } from '../stores/session'

interface Profile {
  label: string
  binary: string
  configDir?: string | null
}

const props = defineProps<{
  data: PragmaPlan
  completedSteps: PragmaStepComplete[]
  phase: PragmaPhase | null
  profile: Profile | null
  collapsed: boolean
  workingDir?: string
}>()
defineEmits<{ toggle: [] }>()

const store = useSessionStore()
const modifyText = ref('')
const showModify = ref(false)
const suggestionDismissed = ref(false)
const errorMsg = ref<string | null>(null)
let errorTimer: ReturnType<typeof setTimeout> | null = null

function showError(msg: string) {
  errorMsg.value = msg
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = setTimeout(() => { errorMsg.value = null }, 4000)
}

const showModelSuggestion = computed(() =>
  !props.collapsed
  && !suggestionDismissed.value
  && store.sessionModel === 'sonnet'
  && props.data.steps.length > 5
  && props.phase === 'awaiting_approval'
)

function pickModel(model: SessionModel) {
  store.sessionModel = model
  suggestionDismissed.value = true
}

const copied = ref(false)
async function copyAll() {
  const text = props.data.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
  await navigator.clipboard.writeText(text)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1200)
}

function isCompleted(stepIndex: number) {
  return props.completedSteps.some(s => s.step === stepIndex + 1)
}

function completedResult(stepIndex: number) {
  return props.completedSteps.find(s => s.step === stepIndex + 1)?.result ?? null
}

function approve() {
  if (!props.profile) {
    showError('No profile selected — open Settings and choose a profile.')
    return
  }
  store.sendControl('APPROVED', props.profile.binary, props.profile.configDir ?? undefined, props.workingDir)
}

function submitModify() {
  if (!props.profile) {
    showError('No profile selected — open Settings and choose a profile.')
    return
  }
  if (!modifyText.value.trim()) return
  store.sendModifyPlan(modifyText.value.trim(), props.profile.binary, props.profile.configDir ?? undefined, props.workingDir)
  modifyText.value = ''
  showModify.value = false
}
</script>

<template>
  <div class="pragma-card plan-card">
    <div class="card-header" @click.self="$emit('toggle')">
      <button class="chevron-btn" :class="{ open: !collapsed }" @click="$emit('toggle')">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2L7 5L3 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="card-label" @click="$emit('toggle')">PLAN</span>
      <button class="copy-btn" :class="{ copied }" :title="copied ? 'copied' : 'copy'" @click="copyAll">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
          <path d="M3 11V3a1 1 0 0 1 1-1h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <div class="card-collapse" :class="{ 'is-collapsed': collapsed }">
      <div class="card-inner">
        <div v-if="showModelSuggestion && canCommand" class="model-banner">
          <span class="model-banner-text">⚡ Complex task ({{ data.steps.length }} steps) — a stronger model may give better results</span>
          <div v-if="phase === 'awaiting_approval'" class="model-banner-note">
            Model change applies to new sessions only — approving will continue with the current model.
          </div>
          <div class="model-banner-actions">
            <button
              class="model-btn-switch"
              title="Opus — strong on architecture and refactoring"
              @click="pickModel('opus')"
            >Switch to Opus</button>
            <button
              class="model-btn-switch is-fable"
              title="Fable — the most capable model; slower and roughly twice the cost of Opus"
              @click="pickModel('fable')"
            >Switch to Fable</button>
            <button class="model-btn-dismiss" @click="suggestionDismissed = true">Dismiss</button>
          </div>
        </div>

        <ol class="steps-list">
          <li
            v-for="(step, i) in data.steps"
            :key="i"
            class="step-item"
            :class="{ completed: isCompleted(i) }"
          >
            <span class="step-num">{{ i + 1 }}</span>
            <span class="step-text">{{ step }}</span>
            <span v-if="isCompleted(i)" class="step-done" title="completed">✓</span>
            <div v-if="completedResult(i)" class="step-result">{{ completedResult(i) }}</div>
          </li>
        </ol>

        <Transition name="plan-error">
          <div v-if="errorMsg" class="plan-error-msg">⚠ {{ errorMsg }}</div>
        </Transition>

        <div v-if="phase === 'awaiting_approval' && canCommand" class="approval-controls">
          <button class="ctrl-btn ctrl-ok" :disabled="store.running" @click="approve">Approve</button>
          <button class="ctrl-btn ctrl-modify" :disabled="store.running" @click="showModify = !showModify">Modify</button>
          <span v-if="store.running" class="approval-waiting">
            <span class="approval-spinner" />
            Waiting for Claude to finish…
          </span>
        </div>

        <div v-if="showModify && canCommand" class="modify-form">
          <textarea
            v-model="modifyText"
            class="modify-input"
            placeholder="Plan modification instructions…"
            rows="3"
            :disabled="store.running"
          />
          <button class="ctrl-btn ctrl-ok" :disabled="store.running || !modifyText.trim()" @click="submitModify">Send</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pragma-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-left: 3px solid #c9a84c;
  border-radius: 6px;
  overflow: hidden;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  background: rgba(201, 168, 76, 0.08);
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}
.card-header:hover { background: rgba(201, 168, 76, 0.14); }

.chevron-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
  line-height: 0;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  transition: color 0.12s, transform 0.2s ease;
  transform: rotate(0deg);
}
.chevron-btn.open { transform: rotate(90deg); }
.chevron-btn:hover { color: var(--text-primary); }

.card-label { flex: 1; }

.card-label {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #c9a84c;
  opacity: 0.9;
}

.copy-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px;
  line-height: 0;
  border-radius: 3px;
  transition: color 0.12s;
  display: flex;
  align-items: center;
}
.copy-btn:hover { color: var(--text-primary); }
.copy-btn.copied { color: #4caf50; }

.card-collapse {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s ease;
  overflow: hidden;
}
.card-collapse.is-collapsed {
  grid-template-rows: 0fr;
}
.card-collapse > .card-inner {
  overflow: hidden;
  min-height: 0;
}

.steps-list {
  list-style: none;
  padding: 6px 10px;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.step-item {
  display: flex;
  gap: 6px;
  align-items: baseline;
  flex-wrap: wrap;
  font-size: 0.8rem;
  color: var(--text-primary);
  line-height: 1.4;
  padding: 3px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}

.step-item:last-child {
  border-bottom: none;
}

.step-item.completed {
  opacity: 0.5;
}

.step-num {
  color: #c9a84c;
  font-weight: 600;
  font-size: 0.75rem;
  min-width: 14px;
  flex-shrink: 0;
}

.step-text {
  flex: 1;
}

.step-done {
  color: #4caf50;
  font-size: 0.75rem;
  flex-shrink: 0;
}

.step-result {
  width: 100%;
  padding: 2px 0 2px 20px;
  font-size: 0.75rem;
  color: var(--text-secondary);
  white-space: pre-wrap;
}

.plan-error-msg {
  padding: 5px 10px;
  font-size: 0.75rem;
  color: #e57373;
  background: rgba(229, 115, 115, 0.08);
  border-top: 1px solid rgba(229, 115, 115, 0.2);
}

.plan-error-enter-active, .plan-error-leave-active { transition: opacity 0.2s; }
.plan-error-enter-from, .plan-error-leave-to { opacity: 0; }

.approval-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--border-color);
}

.approval-waiting {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 0.73rem;
  color: var(--text-secondary);
  margin-left: 4px;
}

.approval-spinner {
  display: inline-block;
  width: 9px;
  height: 9px;
  border: 1.5px solid var(--text-secondary);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.ctrl-btn {
  padding: 4px 12px;
  border-radius: 5px;
  border: none;
  font-family: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.12s;
}
.ctrl-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.ctrl-ok    { background: #4caf50; color: #fff; }
.ctrl-ok:hover:not(:disabled) { opacity: 0.85; }
.ctrl-modify { background: var(--bg-secondary); color: var(--text-secondary); border: 1px solid var(--border-color); }
.ctrl-modify:hover { color: var(--text-primary); }

.modify-form {
  padding: 8px 10px;
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.modify-input {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.8rem;
  padding: 6px 8px;
  resize: vertical;
  outline: none;
}
.modify-input:focus { border-color: var(--color-atom-code); }

.model-banner {
  padding: 8px 10px;
  border-top: 1px solid var(--border-color);
  background: rgba(160, 125, 224, 0.07);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.model-banner-text {
  font-size: 0.78rem;
  color: #a07de0;
  line-height: 1.4;
}

.model-banner-note {
  font-size: 0.72rem;
  color: var(--text-secondary);
  line-height: 1.4;
  font-style: italic;
}

.model-banner-actions {
  display: flex;
  gap: 6px;
}

.model-btn-switch {
  padding: 3px 10px;
  background: rgba(160, 125, 224, 0.2);
  border: 1px solid rgba(160, 125, 224, 0.4);
  border-radius: 4px;
  color: #a07de0;
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s;
}
.model-btn-switch:hover { background: rgba(160, 125, 224, 0.32); }

.model-btn-switch.is-fable {
  background: rgba(224, 158, 90, 0.18);
  border-color: rgba(224, 158, 90, 0.4);
  color: #e09e5a;
}
.model-btn-switch.is-fable:hover { background: rgba(224, 158, 90, 0.3); }

.model-btn-dismiss {
  padding: 3px 10px;
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  transition: color 0.12s;
}
.model-btn-dismiss:hover { color: var(--text-primary); }
</style>
