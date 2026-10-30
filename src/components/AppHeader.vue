<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSessionStore } from '../stores/session'
import { useSettingsStore } from '../stores/settings'
import { useProjectStore } from '../stores/projects'
import { useTodoStore } from '../stores/todos'
import { useRemoteStore } from '../stores/remote'
import { canCommand, showDesktopOnly } from '../webCaps'
import { e2eButtonState } from '../e2eState'
import { liveButtonState } from '../liveState'
import { pipelineButtonState } from '../pipelineState'
import type { PipelineStep } from '../stores/session'

const props = defineProps<{
  // Steps of the current project's pipeline — they only tell whether the
  // button is off or ready, App.vue loads them on project change.
  pipelineSteps: PipelineStep[]
}>()

const emit = defineEmits<{
  newSession: []
  exportJson: []
  exportMd: []
  openUsage: []
  openTodo: []
  openE2e: []
  openLive: []
  openPipeline: []
  openHelp: []
  openSettings: []
}>()

const focusMode = defineModel<boolean>('focusMode', { default: true })

const session = useSessionStore()
const settings = useSettingsStore()
const projects = useProjectStore()
const todos = useTodoStore()
const remote = useRemoteStore()

// — Share to web —
// Appears only if the feature is on and configured in settings. Pressing «share»
// opens sharing and copies the link; while it is on the green button closes it.
const linkCopied = ref(false)

async function copyLink() {
  if (!remote.link) return
  try {
    await navigator.clipboard.writeText(remote.link)
    linkCopied.value = true
    setTimeout(() => { linkCopied.value = false }, 1500)
  } catch {
    // The link stays readable in the button's title: nothing to do if the clipboard is denied.
  }
}

async function startSharing() {
  if (await remote.start()) await copyLink()
}

const shareTitle = computed(() => {
  switch (remote.status) {
    case 'connecting':   return 'Connecting to the relay…'
    case 'reconnecting': return 'Connection lost — retrying. The link stays valid for 2 minutes without this PC.'
    case 'on':
      return `Sharing to the web — ${remote.viewerCount} watching. Click to stop; the link stops working immediately.`
    case 'error':        return remote.error ?? 'Sharing failed'
    default:             return 'Share Pragma to the web: creates a link anyone can open while this is on'
  }
})

// — To-do (the user's checklist, per project) —
// The count on the button is the only thing visible without opening: it shows the open
// items, not the total, because what is left to do is what matters. Neutral and
// not alarming — it is a list of notes, not an error to resolve.
const todoTitle = computed(() => {
  if (!projects.currentProjectId) return 'To-do: select a project first'
  if (todos.openCount === 0) return 'To-do: nothing open — click to add'
  return `To-do: ${todos.openCount} open — click to open the list`
})

// — E2E —
// The button tells the state at a glance: off = not configured, green =
// ready, amber = last run red. Amber and not red because a failed E2E
// blocks nothing — flagging it as a blocking error would be a lie.
const e2eState = computed(() =>
  settings.settings.e2eEnabled || session.e2eRunning
    ? e2eButtonState(projects.currentProject?.e2eCommand, session.e2eRunning, session.pragmaE2e)
    : 'off',
)

const e2eTitle = computed(() => {
  if (!projects.currentProjectId) return 'E2E: select a project first'
  if (!settings.settings.e2eEnabled) return 'E2E: disabled — click to open and re-enable'
  switch (e2eState.value) {
    case 'running': return 'E2E: run in progress — click to open'
    case 'off':     return 'E2E: not configured — click to set it up'
    case 'failed':  return 'E2E: last run failed (informational, never blocks)'
    default:        return 'E2E: configured — click to run'
  }
})

// — Live (on-demand build/start button) —
const liveState = computed(() =>
  liveButtonState(projects.currentProject?.liveCommand, session.liveRunning, session.pragmaLive),
)

const liveTitle = computed(() => {
  if (!projects.currentProjectId) return 'Live: select a project first'
  switch (liveState.value) {
    case 'running': return 'Live: running — click to open'
    case 'off':     return 'Live: not configured — click to set it up'
    case 'failed':  return 'Live: last run did not exit clean — click to inspect'
    default:        return 'Live: configured — click to run'
  }
})

// — Local pipeline —
const pipelineState = computed(() =>
  pipelineButtonState(props.pipelineSteps, session.pipelineRunning, session.pipelineOutcome),
)

const pipelineTitle = computed(() => {
  if (!projects.currentProjectId) return 'Pipeline: select a project first'
  switch (pipelineState.value) {
    case 'running': return 'Pipeline: running — click to open'
    case 'off':     return 'Pipeline: no enabled steps — click to set it up'
    case 'failed':  return 'Pipeline: last run failed — click to inspect'
    default:        return 'Pipeline: ready — click to run'
  }
})
</script>

<template>
  <header class="header">
    <div class="header-top">
      <span class="logo" data-testid="app-logo">pragma</span>
      <!-- Never disabled: it is the button that opens a parallel session,
           so it must work exactly while another one is running.
           The one in progress is not interrupted, it stays in the list on the left. -->
      <button v-if="canCommand" class="new-btn" data-testid="btn-new-session" title="New session" @click="emit('newSession')">+</button>
      <input v-model="session.sessionTitle" class="title-input" data-testid="session-title-input" placeholder="session title…" :disabled="session.running" :readonly="!canCommand" />
      <div class="header-actions">
        <button v-if="showDesktopOnly && session.sessionId && !session.running" class="action-btn export-btn" title="Export JSON to ~/.pragma/exports/" @click="emit('exportJson')">↓ JSON</button>
        <button v-if="showDesktopOnly && session.sessionId && !session.running" class="action-btn export-btn" title="Export Markdown to ~/.pragma/exports/" @click="emit('exportMd')">↓ MD</button>
        <button class="action-btn" :class="{ 'focus-active': focusMode }" :title="focusMode ? 'Show all atoms' : 'Show signal only'" @click="focusMode = !focusMode">{{ focusMode ? 'focus' : 'raw' }}</button>
        <button v-if="showDesktopOnly" class="action-btn" data-testid="btn-usage" title="Usage stats" @click="emit('openUsage')">usage</button>
        <button
          class="action-btn"
          data-testid="btn-todo"
          :class="{ 'todo-open': todos.openCount > 0 }"
          :disabled="!projects.currentProjectId"
          :title="todoTitle"
          @click="emit('openTodo')"
        >todo<span v-if="todos.openCount > 0" class="todo-badge">{{ todos.openCount }}</span></button>
        <!-- E2E, Live and CI launch processes on the PC and belong to no session: desktop only. -->
        <template v-if="showDesktopOnly">
        <button
          class="action-btn"
          data-testid="btn-e2e"
          :class="{
            'e2e-ready': e2eState === 'ready',
            'e2e-failed': e2eState === 'failed',
            'e2e-running': e2eState === 'running',
          }"
          :disabled="!projects.currentProjectId"
          :title="e2eTitle"
          @click="emit('openE2e')"
        >E2E</button>
        <button
          class="action-btn"
          data-testid="btn-live"
          :class="{
            'live-ready': liveState === 'ready',
            'live-failed': liveState === 'failed',
            'live-running': liveState === 'running',
          }"
          :disabled="!projects.currentProjectId"
          :title="liveTitle"
          @click="emit('openLive')"
        >Live</button>
        <button
          class="action-btn"
          data-testid="btn-pipeline"
          :class="{
            'live-ready': pipelineState === 'ready',
            'live-failed': pipelineState === 'failed',
            'live-running': pipelineState === 'running',
          }"
          :disabled="!projects.currentProjectId"
          :title="pipelineTitle"
          @click="emit('openPipeline')"
        >CI</button>
        </template>
        <template v-if="showDesktopOnly && (remote.canShare || remote.sharing)">
          <button
            v-if="!remote.sharing"
            class="action-btn"
            :class="{ 'share-error': remote.status === 'error' }"
            data-testid="btn-share"
            :title="shareTitle"
            @click="startSharing"
          >share</button>
          <template v-else>
            <button
              class="action-btn"
              :class="remote.status === 'on' ? 'share-on' : 'share-wait'"
              data-testid="btn-share-stop"
              :disabled="remote.status === 'connecting'"
              :title="shareTitle"
              @click="remote.stop()"
            >{{ remote.status === 'on' ? '● sharing' : remote.status === 'connecting' ? 'connecting…' : 'reconnecting…' }}<span v-if="remote.status === 'on' && remote.viewerCount > 0" class="todo-badge">{{ remote.viewerCount }}</span></button>
            <button
              v-if="remote.status === 'on'"
              class="action-btn"
              data-testid="btn-share-copy"
              :title="remote.link"
              @click="copyLink"
            >{{ linkCopied ? 'copied' : 'copy link' }}</button>
          </template>
          <!-- Commands from the web, when on, are always visible, not only in settings. -->
          <span
            v-if="remote.sharing && remote.commandsEnabled"
            class="share-cmd"
            data-testid="share-commands-on"
            title="Commands from the web are on: with the PIN, the page can start, approve, answer and stop sessions on this PC."
          >+ commands</span>
          <span v-if="remote.status === 'error' && remote.error" class="share-error-text" data-testid="share-error" :title="remote.error">{{ remote.error }}</span>
        </template>
        <button v-if="showDesktopOnly" class="action-btn" data-testid="btn-help" title="Guide" @click="emit('openHelp')">?</button>
        <button v-if="showDesktopOnly" class="settings-btn" data-testid="btn-settings" title="Settings" @click="emit('openSettings')">⚙</button>
      </div>
    </div>
  </header>
</template>

<style scoped>
.header {
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.header-top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px 4px;
}

.logo {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--color-atom-code);
  letter-spacing: 0.12em;
  flex-shrink: 0;
}

.new-btn {
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 5px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 1rem;
  font-weight: 300;
  padding: 0 7px;
  line-height: 1.6;
  flex-shrink: 0;
  transition: color 0.15s, border-color 0.15s;
}
.new-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--text-secondary); }
.new-btn:disabled { opacity: 0.3; cursor: not-allowed; }

.title-input {
  flex: 1;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border-color);
  border-radius: 0;
  padding: 2px 4px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.92rem;
  font-weight: 500;
  outline: none;
  transition: border-color 0.15s;
}
.title-input:focus { border-color: var(--color-atom-code); }
.title-input:disabled { opacity: 0.4; }
.title-input[readonly] { border-bottom-color: transparent; }
.title-input::placeholder { color: var(--text-secondary); opacity: 0.5; }

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.action-btn {
  padding: 4px 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 0.78rem;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.action-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--text-secondary); }
.action-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.focus-active { color: var(--color-atom-code); border-color: var(--color-atom-code); background: rgba(106, 176, 245, 0.08); }
.todo-open { color: var(--color-atom-code); border-color: var(--color-atom-code); background: rgba(106, 176, 245, 0.08); }
.todo-badge { margin-left: 5px; font-weight: 700; font-family: monospace; }

.e2e-ready   { color: #7ec8a0; border-color: #7ec8a0; background: rgba(126, 200, 160, 0.08); }
/* Amber, not red: a failed E2E is informational and does not block the cycle. */
.e2e-failed  { color: #d08770; border-color: #d08770; background: rgba(208, 135, 112, 0.1); }
.e2e-running { color: #c98a30; border-color: #c98a30; background: rgba(201, 138, 48, 0.1); }

.live-ready   { color: #7ec8a0; border-color: #7ec8a0; background: rgba(126, 200, 160, 0.08); }
.live-failed  { color: #d08770; border-color: #d08770; background: rgba(208, 135, 112, 0.1); }
.live-running { color: #c98a30; border-color: #c98a30; background: rgba(201, 138, 48, 0.1); }

.export-btn { color: var(--color-atom-config); }

.share-on   { color: #7ec8a0; border-color: #7ec8a0; background: rgba(126, 200, 160, 0.08); }
.share-wait { color: #c98a30; border-color: #c98a30; background: rgba(201, 138, 48, 0.1); }
.share-cmd { font-size: 0.72rem; color: #c98a30; white-space: nowrap; }
.share-error { color: #d08770; border-color: #d08770; background: rgba(208, 135, 112, 0.1); }
.share-error-text {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  color: #d08770;
}

.settings-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 1rem;
  padding: 2px 4px;
  transition: color 0.15s;
}
.settings-btn:hover { color: var(--text-primary); }

/* Web on a narrow screen: more room for the title, which is what says what you are looking at. */
@media (max-width: 899px) {
  html.web .header-top { padding: 8px 10px 6px; gap: 8px; }
  html.web .title-input { min-width: 0; }
}
</style>
