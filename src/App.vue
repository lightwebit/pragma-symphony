<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { listen, invoke, IS_WEB, onWebResync } from './platform'
import { useSessionStore } from './stores/session'
import type { SessionModel, PipelineStep } from './stores/session'
import { useSettingsStore } from './stores/settings'
import { useProjectStore } from './stores/projects'
import { useScheduledStore } from './stores/scheduled'
import { useTodoStore } from './stores/todos'
import { useTheme } from './composables/useTheme'
import { usePanelResize } from './composables/usePanelResize'
import { useAttachments } from './composables/useAttachments'
import { useToasts } from './composables/useToasts'
import { useSessionNotifications } from './composables/useSessionNotifications'
import { useGlobalKeys } from './composables/useGlobalKeys'
import AtomStream from './components/AtomStream.vue'
import SessionPanel from './components/SessionPanel.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import PragmaPanel from './components/PragmaPanel.vue'
import HelpPanel from './components/HelpPanel.vue'
import UsageModal from './components/UsageModal.vue'
import TodoModal from './components/TodoModal.vue'
import ComposerModal from './components/ComposerModal.vue'
import E2eModal from './components/E2eModal.vue'
import LiveModal from './components/LiveModal.vue'
import PipelineModal from './components/PipelineModal.vue'
import AppHeader from './components/AppHeader.vue'
import AppFooter from './components/AppFooter.vue'
import PromptBar from './components/PromptBar.vue'
import WorkdirBar from './components/WorkdirBar.vue'
import ErrorBanner from './components/ErrorBanner.vue'
import CacheExpiredBanner from './components/CacheExpiredBanner.vue'
import { expiredCache } from './cacheExpiry'
import { buildResumePrompt } from './resumeSummary'
import { buildAnswers } from './questions'
import ToastStack from './components/ToastStack.vue'
import DragOverlay from './components/DragOverlay.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import WebLinkGate from './components/WebLinkGate.vue'
import { LS_FOCUS_MODE, LS_WORKING_DIR } from './PRAGMA_CONSTANTS'
import { canCommand, showDesktopOnly } from './webCaps'
import { useMobileLayout } from './composables/useMobileLayout'
import { tabAfterSessionChange, pragmaWantsAttention } from './mobileTabs'
import type { MobileTab } from './mobileTabs'

const session = useSessionStore()
const settings = useSettingsStore()
const projects = useProjectStore()
const scheduled = useScheduledStore()
const todos = useTodoStore()

const sessionPanelRef = ref<InstanceType<typeof SessionPanel> | null>(null)

const { isDark, applyTheme, toggleTheme } = useTheme()
const { leftWidth, rightWidth, startDrag } = usePanelResize()
const {
  exportToast, errorToast,
  showExportToast, showErrorToast,
} = useToasts()

useSessionNotifications()

// — Web on a narrow screen: one panel at a time, chosen from the tabs at the bottom —
const { mobile } = useMobileLayout()
const mobileTab = ref<MobileTab>(session.sessionId ? 'stream' : 'sessions')
watch(() => session.sessionId, (id) => { mobileTab.value = tabAfterSessionChange(mobileTab.value, id) })
const pragmaAttention = computed(() => pragmaWantsAttention(session.pragmaPhase, session.autoConfirmAt))

const focusMode = ref(localStorage.getItem(LS_FOCUS_MODE) !== 'false')
watch(focusMode, v => localStorage.setItem(LS_FOCUS_MODE, String(v)))

// — Attachments & working dir —
const { workingDir, attachments, attachmentExists, pickWorkingDir, attachFile, removeAttachment, handleDroppedPaths } = useAttachments(showErrorToast)

// Generating the E2E scripts is not a blind one-shot: the prepared prompt ends up
// in the composer like any other request, so the session is visible and correctable.
function onE2eGenerate(generatedPrompt: string) {
  prompt.value = generatedPrompt
  composerOpen.value = true
}

// — Cache expired before a resume —
// `now` advances at intervals: expiry is a matter of time passing, not of
// events, and a minute's delay in the warning changes nothing.
const now = ref(Date.now())
const nowTimer = setInterval(() => { now.value = Date.now() }, 30_000)
onUnmounted(() => clearInterval(nowTimer))

const cacheWarning = computed(() =>
  !session.sessionId || session.running ? null : expiredCache(session.sessionCache, now.value),
)
const cacheBannerDismissed = ref(new Set<string>())
// The banner only on sessions paused on the protocol, where a click on Approve/Continue
// starts the resume. For a free prompt on a closed session there is the warning in the composer.
const cacheBanner = computed(() => {
  const id = session.sessionId
  if (!id || !cacheWarning.value || cacheBannerDismissed.value.has(id)) return null
  return session.isActive(id) ? cacheWarning.value : null
})
function dismissCacheBanner() {
  const id = session.sessionId
  if (id) cacheBannerDismissed.value = new Set(cacheBannerDismissed.value).add(id)
}

// The session the new one is about to continue. It is released from the one-session-per-directory
// guard only on send: closing the composer without sending anything must not change its state.
const supersedeId = ref<string | null>(null)
watch(() => session.sessionId, (id) => { if (id) supersedeId.value = null })

function startFreshWithSummary() {
  const id = session.sessionId
  const old = id ? session.sessions[id] : null
  if (!id || !old) return
  const summary = buildResumePrompt(old)
  const typed = prompt.value.trim()
  const title = old.title
  const model = old.model
  session.newSession()
  session.sessionTitle = title ? `${title} (cont.)` : ''
  supersedeId.value = id
  prompt.value = typed ? `${summary}\n\n## New instruction\n${typed}` : summary
  selectedModel.value = model
  composerOpen.value = true
}

// — Modals —
const showSettings = ref(false)
const showUsage = ref(false)
const showTodo = ref(false)
const showE2e = ref(false)
const showLive = ref(false)
const showPipeline = ref(false)
const showHelp = ref(false)
const composerOpen = ref(false)
const confirmNewSession = ref(false)
const dragOver = ref(false)

// — Composer state (shared with ComposerModal via v-model) —
const prompt = ref('')
const selectedModel = ref<SessionModel>('sonnet')
const autoConfirm = ref(true)
// One answer per question, when the model asked more than one.
const answers = ref<string[]>([])

// — Profiles —
const profileIdx = ref(0)
watch(() => settings.loaded, (loaded) => {
  if (loaded) profileIdx.value = settings.settings.defaultProfileIndex ?? 0
}, { immediate: true })
const profiles = computed(() => settings.settings.profiles)
const noProfiles = computed(() => profiles.value.length === 0)

// — Export —
async function doExportJson() {
  const path = await session.exportCurrentSession()
  if (path) showExportToast(path)
}

async function doExportMd() {
  const path = await session.exportCurrentSessionMarkdown(workingDir.value || undefined)
  if (path) showExportToast(path)
}

function onSettingsClose() {
  showSettings.value = false
  settings.load()
}

// — Composer open —
function openComposer() {
  if (!canCommand.value) return
  if (session.running && session.pragmaPhase !== 'awaiting_answers') return
  composerOpen.value = true
}

// — New session confirm —
// The warning only makes sense on the draft (sessionId === null): there the attachments are
// not saved anywhere yet and "+" would really lose them. On a session
// already started the attachments are already persisted — "+" only moves the
// focus to an empty draft, the session left behind stays intact.
function tryNewSession() {
  if (!session.sessionId && attachments.value.length > 0) { confirmNewSession.value = true; return }
  session.newSession()
}

function doConfirmNewSession() {
  confirmNewSession.value = false
  session.newSession()
}

// — Submit (called by ComposerModal @submit) —
async function submit(model: SessionModel, ac: boolean, runAt: string | null) {
  const text = prompt.value.trim()

  if (session.pragmaPhase === 'awaiting_answers') {
    const p = profiles.value[profileIdx.value]
    if (!p) return
    const reply = buildAnswers(answers.value, text)
    if (!Object.keys(reply).length) return
    await session.sendAnswers(reply, p.binary, p.configDir ?? undefined, workingDir.value || undefined)
    prompt.value = ''
    answers.value = []
    composerOpen.value = false
    return
  }
  if (!text) return

  const filesToSave = [...attachments.value]
  let fullPrompt = text
  if (filesToSave.length > 0) {
    fullPrompt += '\n\nAttached files in .pragmadocs/:\n' + filesToSave.map(f => `- ${f}`).join('\n')
  }
  const projectId = projects.currentProjectId ?? ''
  if (!projectId) { session.lastError = 'No project selected. Create a project first.'; return }

  // Scheduled: it occupies nothing until it starts, so neither the
  // working dir/project guard nor the choice of a profile is required now —
  // the profile is resolved at expiry from the current settings (see scheduler.rs
  // fire_one), so a session can be scheduled even before configuring one.
  if (runAt) {
    const p = profiles.value[profileIdx.value]
    try {
      await scheduled.create({
        projectId,
        prompt: fullPrompt,
        runAt,
        workingDir: workingDir.value || null,
        profileLabel: p?.label ?? null,
        model,
        attachments: filesToSave,
        title: session.sessionTitle || null,
        stepByStep: !ac,
        autoConfirm: ac,
      })
    } catch (e: any) {
      session.lastError = String(e)
      return
    }
    prompt.value = ''
    composerOpen.value = false
    selectedModel.value = 'sonnet'
    return
  }

  if (session.running || noProfiles.value) return
  const p = profiles.value[profileIdx.value]
  if (supersedeId.value && !session.sessionId) session.supersedeSession(supersedeId.value)
  session.sessionAttachments = []
  try {
    await session.startSession({
      prompt: fullPrompt,
      binary: p.binary,
      projectId,
      configDir: p.configDir,
      workingDir: workingDir.value || null,
      profileLabel: p.label,
      title: session.sessionTitle || null,
      model,
      resumeId: session.sessionId,
      attachments: filesToSave,
      stepByStep: !ac,
      autoConfirm: ac,
    })
  } catch (e: any) {
    session.lastError = String(e)
    session.sessionAttachments = filesToSave
    return
  }
  prompt.value = ''
  composerOpen.value = false
  selectedModel.value = 'sonnet'
}

useGlobalKeys({
  openComposer,
  openSettings: () => { if (showDesktopOnly) showSettings.value = true },
})

// — Missed scheduled sessions —
// Driven by the presence of `missed` rows in the shared store, not by a local
// flag: when the last one is resolved (Discard/Reschedule/Run now) the modal
// disappears by itself, with no need for an explicit "close".
const currentMissed = computed(() => scheduled.items.find(s => s.status === 'missed') ?? null)
const missedRescheduleAt = ref('')
const missedBusy = ref(false)

watch(currentMissed, (m) => { if (!m) missedRescheduleAt.value = '' })

async function discardMissed() {
  if (!currentMissed.value) return
  missedBusy.value = true
  try {
    await scheduled.cancel(currentMissed.value.id)
  } finally {
    missedBusy.value = false
  }
}

async function runMissedNow() {
  if (!currentMissed.value) return
  missedBusy.value = true
  try {
    await scheduled.runNow(currentMissed.value.id)
  } catch (e: any) {
    session.lastError = String(e)
  } finally {
    missedBusy.value = false
  }
}

async function rescheduleMissed() {
  if (!currentMissed.value || !missedRescheduleAt.value) return
  const iso = new Date(missedRescheduleAt.value).toISOString()
  if (new Date(iso).getTime() <= Date.now()) { session.lastError = 'Pick a time in the future.'; return }
  missedBusy.value = true
  try {
    await scheduled.reschedule(currentMissed.value.id, iso)
    missedRescheduleAt.value = ''
  } finally {
    missedBusy.value = false
  }
}

// — Watches —
// Auto-confirm lives in the store, per session: here it would only see the focused one,
// and with parallel sessions it would mean continuing one only because
// you passed over it — or not continuing one because you were looking elsewhere.
watch(() => session.pragmaPhase, (phase) => {
  if (phase === 'awaiting_answers' && canCommand.value) {
    answers.value = []
    composerOpen.value = true
  }
})

watch(() => session.lastError, err => { if (err) showErrorToast(err) })

// Bug found live in the field (parallel sessions): with the
// "only if empty" guard the first selected project fixed workingDir
// forever — switching to a SECOND project with a different working dir never
// realigned it, so a new session silently started in the
// directory of the wrong project (or was refused as "session already
// active" because it mistakenly shared the dir of the background session).
// It now realigns on every *real* project change (`currentProjectId`, not
// the whole object — which changes identity even for a save unrelated
// to the switch), not only when `workingDir` was empty.
watch(
  () => projects.currentProjectId,
  (id, previousId) => {
    if (id === previousId) return
    workingDir.value = projects.currentProject?.workingDir ?? ''
  },
)

// The steps only serve to decide whether the CI button is off or ready: they
// reload on project change and after a save from the popup.
const pipelineSteps = ref<PipelineStep[]>([])

async function loadPipelineSteps() {
  const id = projects.currentProjectId
  if (!id) { pipelineSteps.value = []; return }
  try {
    pipelineSteps.value = await invoke<PipelineStep[]>('get_pipeline_steps', { projectId: id })
  } catch {
    pipelineSteps.value = []
  }
}

watch(() => projects.currentProjectId, loadPipelineSteps, { immediate: true })

// The checklist reloads on project change even with the popup closed: the count
// on the button must already be right before anyone opens it, otherwise it does not
// remind anyone of anything. Silent failure — it is a counter, not a gate.
watch(
  () => projects.currentProjectId,
  (id) => { todos.refresh(id ?? null).catch(() => {}) },
  { immediate: true },
)

// — Web: re-read everything from the PC —
// After a reconnection, or if events were lost, the page cannot trust what
// it has: it re-reads settings, projects, lists and the open session. On the
// desktop there is never anything to realign, the memory is its own.
if (IS_WEB) {
  onWebResync(async () => {
    await settings.load()
    await projects.load()
    const pid = projects.currentProjectId
    if (pid) {
      await Promise.allSettled([
        session.fetchSavedSessions(pid),
        scheduled.refresh(pid),
        todos.refresh(pid),
      ])
    }
    if (session.sessionId) await session.refreshFromHost(session.sessionId)
  })
}

// — Mount —
onMounted(async () => {
  await settings.load()
  await projects.load()
  await session.initGlobalListeners()
  await scheduled.initListeners()
  applyTheme(isDark.value)

  const lsDir = localStorage.getItem(LS_WORKING_DIR)
  // The migration from localStorage writes into the PC's settings: never from the web.
  if (lsDir !== null && !IS_WEB) {
    workingDir.value = lsDir
    settings.settings.lastWorkingDir = lsDir || null
    await settings.save()
    localStorage.removeItem(LS_WORKING_DIR)
  } else {
    workingDir.value = settings.settings.lastWorkingDir ?? ''
  }

  await listen<{ paths: string[] }>('tauri://drag-drop', (e) => handleDroppedPaths(e.payload.paths))
  await listen('tauri://drag-enter', () => { dragOver.value = true })
  await listen('tauri://drag-leave', () => { dragOver.value = false })

  const splash = document.getElementById('pragma-splash')
  if (splash) {
    splash.classList.add('fade-out')
    setTimeout(() => splash.remove(), 260)
  }
})
</script>

<template>
  <div class="app-layout" data-testid="app-layout">
    <WebLinkGate v-if="IS_WEB" />
    <AppHeader
      v-model:focus-mode="focusMode"
      :pipeline-steps="pipelineSteps"
      @new-session="tryNewSession"
      @export-json="doExportJson"
      @export-md="doExportMd"
      @open-usage="showUsage = true"
      @open-todo="showTodo = true"
      @open-e2e="showE2e = true"
      @open-live="showLive = true"
      @open-pipeline="showPipeline = true"
      @open-help="showHelp = true"
      @open-settings="showSettings = true"
    />

    <!-- Web on a narrow screen: the same three panels, one at a time. v-show and not v-if,
         so switching from one tab to another does not lose scroll and reading state. -->
    <div v-if="mobile" class="main-layout is-mobile" data-testid="mobile-layout">
      <div v-show="mobileTab === 'sessions'" class="m-pane" data-testid="m-pane-sessions">
        <SessionPanel ref="sessionPanelRef" :profile="profiles[profileIdx] ?? null" />
      </div>
      <div v-show="mobileTab === 'stream'" class="m-pane center-area" data-testid="m-pane-stream">
        <div v-if="!projects.hasProjects" class="no-projects-state" data-testid="empty-projects">
          <div class="no-projects-title">No projects yet</div>
          <div class="no-projects-sub">Create a project in Pragma on the PC.</div>
        </div>
        <AtomStream v-else :focus-mode="focusMode" :working-dir="workingDir || undefined" @open-composer="openComposer" />
      </div>
      <div v-show="mobileTab === 'pragma'" class="m-pane" data-testid="m-pane-pragma">
        <PragmaPanel
          :profile="profiles[profileIdx] ?? null"
          :working-dir="workingDir || undefined"
          @continue-session="openComposer"
          @new-session="session.newSession()"
        />
        <div v-if="!session.sessionId" class="m-empty">Open a session to see its analysis, plan and report.</div>
      </div>
    </div>

    <div v-else class="main-layout">
      <SessionPanel ref="sessionPanelRef" :width="leftWidth" :profile="profiles[profileIdx] ?? null" />
      <div class="resize-handle" @mousedown="startDrag('left', $event)" />
      <div class="center-area">
        <div v-if="!projects.hasProjects" class="no-projects-state" data-testid="empty-projects">
          <svg class="no-projects-icon" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <polygon
              points="92,50 71,13.6 29,13.6 8,50 29,86.4 71,86.4"
              transform="rotate(90 50 50)"
              stroke="currentColor"
              stroke-width="2.75"
              stroke-linejoin="round"
            />
            <polyline
              points="30,37 46,50 30,63"
              stroke="currentColor"
              stroke-width="6.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <circle cx="74" cy="35" r="2.25" fill="currentColor" />
            <line x1="55" y1="62" x2="74" y2="62" stroke="currentColor" stroke-width="6" stroke-linecap="round" />
          </svg>
          <div class="no-projects-title">No projects yet</div>
          <div class="no-projects-sub">Create a project to start your first Pragma Symphony session.</div>
          <button class="no-projects-btn" data-testid="btn-empty-new-project" @click="sessionPanelRef?.openNewProject()">New project</button>
        </div>
        <AtomStream v-else :focus-mode="focusMode" :working-dir="workingDir || undefined" :attachments="attachments.length ? attachments : undefined" @open-composer="openComposer" />
      </div>
      <div class="resize-handle" @mousedown="startDrag('right', $event)" />
      <PragmaPanel
        :profile="profiles[profileIdx] ?? null"
        :working-dir="workingDir || undefined"
        :width="rightWidth"
        @continue-session="composerOpen = true"
        @new-session="session.newSession()"
      />
    </div>

    <div class="bottom-bar">
      <CacheExpiredBanner
        v-if="cacheBanner && canCommand"
        :info="cacheBanner"
        @summary="startFreshWithSummary"
        @dismiss="dismissCacheBanner"
      />

      <ErrorBanner
        v-if="session.lastError"
        :message="session.lastError"
        @dismiss="session.lastError = null"
        @open-settings="showSettings = true; session.lastError = null"
      />

      <PromptBar
        v-if="canCommand"
        v-model:profile-idx="profileIdx"
        :prompt="prompt"
        :profiles="profiles"
        @open="openComposer"
        @run="submit(selectedModel, autoConfirm, null)"
        @stop="session.stopSession()"
      />

      <WorkdirBar
        v-if="showDesktopOnly"
        :working-dir="workingDir"
        :attachments="attachments"
        :attachment-exists="attachmentExists"
        :disabled="session.running"
        @pick-dir="pickWorkingDir"
        @clear-dir="workingDir = ''"
        @attach="attachFile"
        @remove="removeAttachment"
      />
    </div>

    <nav v-if="mobile" class="mobile-tabs" data-testid="mobile-tabs">
      <button
        v-for="t in (['sessions', 'stream', 'pragma'] as const)"
        :key="t"
        class="mobile-tab"
        :class="{ active: mobileTab === t }"
        :data-testid="`mobile-tab-${t}`"
        @click="mobileTab = t"
      >
        {{ t === 'sessions' ? 'Sessions' : t === 'stream' ? 'Stream' : 'Pragma' }}
        <span v-if="t === 'stream' && session.running" class="mobile-tab-dot running" />
        <span v-if="t === 'pragma' && pragmaAttention" class="mobile-tab-dot" data-testid="mobile-tab-attention" />
      </button>
    </nav>

    <AppFooter :is-dark="isDark" @toggle-theme="toggleTheme" />

    <SettingsPanel v-if="showSettings" @close="onSettingsClose" />
    <HelpPanel v-if="showHelp" @close="showHelp = false" />

    <UsageModal :open="showUsage" :profile="profiles[profileIdx] ?? null" @close="showUsage = false" />

    <TodoModal :open="showTodo" @close="showTodo = false" />

    <E2eModal
      :open="showE2e"
      :profile="profiles[profileIdx] ?? null"
      :working-dir="workingDir"
      @close="showE2e = false"
      @generate="onE2eGenerate"
    />

    <LiveModal
      :open="showLive"
      :working-dir="workingDir"
      @close="showLive = false"
    />

    <PipelineModal
      :open="showPipeline"
      :profile="profiles[profileIdx] ?? null"
      :working-dir="workingDir"
      @close="showPipeline = false; loadPipelineSteps()"
    />

    <ComposerModal
      :open="composerOpen"
      :working-dir="workingDir"
      :cache-warning="cacheWarning"
      v-model:prompt="prompt"
      v-model:selected-model="selectedModel"
      v-model:auto-confirm="autoConfirm"
      v-model:answers="answers"
      @close="composerOpen = false"
      @submit="submit"
      @start-fresh="startFreshWithSummary"
    />

    <DragOverlay :visible="dragOver" :working-dir="workingDir" />

    <ToastStack v-model:export-toast="exportToast" v-model:error-toast="errorToast" />

    <ConfirmDialog
      :open="confirmNewSession"
      title="New session"
      :body="`${attachments.length} attached file${attachments.length !== 1 ? 's' : ''} will be removed. Continue?`"
      @cancel="confirmNewSession = false"
      @confirm="doConfirmNewSession"
    />

    <Teleport to="body">
      <div v-if="currentMissed && canCommand" class="missed-overlay" data-testid="missed-overlay">
        <div class="missed-modal">
          <div class="missed-modal-icon">⚠</div>
          <div class="missed-modal-title">Scheduled session missed</div>
          <div class="missed-modal-name">{{ currentMissed.title || currentMissed.prompt.slice(0, 80) }}</div>
          <div class="missed-modal-hint">
            was due on {{ new Date(currentMissed.runAt).toLocaleString() }}, while Pragma was closed.
          </div>
          <input v-model="missedRescheduleAt" type="datetime-local" class="missed-reschedule-input" data-testid="missed-reschedule-input" />
          <div class="missed-modal-actions">
            <button class="delete-modal-cancel" data-testid="missed-discard" :disabled="missedBusy" @click="discardMissed">Discard</button>
            <button class="delete-modal-cancel" data-testid="missed-reschedule" :disabled="missedBusy || !missedRescheduleAt" @click="rescheduleMissed">Reschedule</button>
            <button class="delete-modal-confirm" data-testid="missed-run-now" :disabled="missedBusy" @click="runMissedNow">Run now</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.bottom-bar {
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
}

/* On the web the bottom bar may be left with nothing inside (no prompt without commands, no dir). */
.bottom-bar:empty { display: none; }

.main-layout { display: flex; flex: 1; min-height: 0; overflow: hidden; }

/* — Web on a narrow screen — */
.m-pane { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
/* The side panels become full width; nothing to compress when it is the only one on screen. */
.m-pane :deep(.session-panel),
.m-pane :deep(.pragma-panel) { width: auto !important; flex: 1; min-width: 0; border: none; }
.m-pane :deep(.collapse-btn) { display: none; }
.m-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.mobile-tabs {
  display: flex;
  flex-shrink: 0;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  padding-bottom: env(safe-area-inset-bottom);
}
.mobile-tab {
  flex: 1;
  position: relative;
  padding: 11px 0 12px;
  background: none;
  border: none;
  border-top: 2px solid transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}
.mobile-tab.active { color: var(--color-atom-code); border-top-color: var(--color-atom-code); }
.mobile-tab-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-left: 5px;
  vertical-align: middle;
  border-radius: 50%;
  background: #d4a843;
}
.mobile-tab-dot.running { background: #7ec8a0; }

.center-area { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }

.no-projects-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
}
.no-projects-icon { width: 25rem; height: 25rem; max-width: 40vh; max-height: 40vh; color: var(--text-primary); opacity: 0.25; }
.no-projects-title { font-size: 1rem; font-weight: 600; color: var(--text-primary); }
.no-projects-sub { font-size: 0.84rem; opacity: 0.6; }
.no-projects-btn {
  margin-top: 6px;
  padding: 8px 22px;
  background: var(--color-atom-code);
  color: #fff;
  border: none;
  border-radius: 7px;
  font-family: inherit;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.no-projects-btn:hover { background: #5aa0e8; }

/* Missed scheduled sessions — same visual register as
   .delete-overlay/.delete-modal (global, defined in SessionPanel.vue), with the
   fields of the three-way Discard/Reschedule/Run now choice. */
.missed-overlay {
  position: fixed;
  inset: 0;
  z-index: 9500;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(2px);
}
.missed-modal {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 28px 32px 24px;
  min-width: 300px;
  max-width: 420px;
  text-align: center;
  box-shadow: 0 8px 40px rgba(0,0,0,0.4);
}
.missed-modal-icon { font-size: 2rem; margin-bottom: 12px; color: #d4a843; }
.missed-modal-title { font-size: 1rem; font-weight: 600; color: var(--text-primary); margin-bottom: 6px; }
.missed-modal-name {
  font-size: 0.82rem; color: var(--text-primary);
  background: var(--bg-secondary); border-radius: 6px; padding: 4px 10px;
  display: inline-block; margin-bottom: 8px; word-break: break-word;
}
.missed-modal-hint { font-size: 0.78rem; color: var(--text-secondary); margin-bottom: 16px; line-height: 1.4; }
.missed-reschedule-input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-secondary); border: 1px solid var(--border-color);
  border-radius: 6px; padding: 6px 10px; color: var(--text-primary);
  font-family: inherit; font-size: 0.82rem; margin-bottom: 16px; outline: none;
}
.missed-reschedule-input:focus { border-color: var(--color-atom-code); }
.missed-modal-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }

.resize-handle {
  width: 4px;
  flex-shrink: 0;
  cursor: col-resize;
  background: transparent;
  position: relative;
  z-index: 10;
  transition: background 0.15s;
}
.resize-handle::after { content: ''; position: absolute; inset: 0; left: -3px; right: -3px; }
.resize-handle:hover { background: var(--color-atom-code); opacity: 0.45; }
</style>
