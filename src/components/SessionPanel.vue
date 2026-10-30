<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { storeToRefs } from 'pinia'
import { invoke } from '../platform'
import { useSessionStore, type SessionInfo } from '../stores/session'
import { useProjectStore, type Project } from '../stores/projects'
import { useScheduledStore, relativeTime, type ScheduledSession } from '../stores/scheduled'
import type { Profile } from '../stores/settings'
import { canCommand, showDesktopOnly } from '../webCaps'

const props = defineProps<{ width?: number; profile: Profile | null }>()
const store = useSessionStore()
const projectStore = useProjectStore()
const scheduledStore = useScheduledStore()
const { savedSessions, sessionId, liveSessions } = storeToRefs(store)
const { projects, currentProject, currentProjectId } = storeToRefs(projectStore)
const { items: scheduledItems } = storeToRefs(scheduledStore)

// ── Parallel sessions ─────────────────────────────────────────
// The list shows only the current project, but parallel sessions live by
// definition on *other* projects: without this strip a session started and then
// left by switching project would vanish from view while still working.
const elsewhere = computed(() =>
  liveSessions.value.filter(s => s.projectId !== currentProjectId.value),
)

function projectTitle(id: string): string {
  return projects.value.find(p => p.id === id)?.title ?? 'other project'
}

function isRunning(id: string): boolean {
  return store.isRunning(id)
}

function modelOf(id: string): string {
  return store.sessions[id]?.model ?? 'sonnet'
}

// s.model reflects the DB (SessionInfo.model), not the live state: it stays correct
// even for sessions never loaded into memory in this run of the app.
function modelLabel(s: SessionInfo): string {
  if (s.model === 'opus') return 'Opus'
  if (s.model === 'fable') return 'Fable'
  if (s.model === 'sonnet') return 'Sonnet'
  return '—' // session created before the field existed
}

const collapsed = ref(false)
const searchQuery = ref('')
const searchResults = ref<SessionInfo[]>([])
let searchTimer: ReturnType<typeof setTimeout> | null = null

// ── Project modal ─────────────────────────────────────────────
const showProjectModal = ref(false)
const editingProject = ref<Project | null>(null)
const projectForm = ref({
  title: '', description: '', workingDir: '', color: '',
  testCommand: '', lintCommand: '', coverageCommand: '', reviewInvariants: '',
  sensitivePaths: '', projectCategory: '', projectStack: '',
})
const projectError = ref('')
const projectSaving = ref(false)

// ── Category → stack (hard-wired on the Rust side, see category.rs) ────
// Bypassable constraint: the catalogue proposes, it does not impose. `<input>` + `<datalist>`
// instead of a `<select>` because a category outside the catalogue is a
// legitimate case, not an error to block — the user types freely, the datalist
// is only a suggestion.
interface CategoryEntry { category: string; stack: string; rationale: string }
const categoryCatalog = ref<CategoryEntry[]>([])
// True while the form is populated programmatically (opening new/edit): the automatic
// stack proposal must fire only when the user is choosing a category, not
// when we are reloading already-saved data.
const populatingForm = ref(false)

async function ensureCategoryCatalog() {
  if (categoryCatalog.value.length === 0) {
    categoryCatalog.value = await invoke<CategoryEntry[]>('project_category_catalog')
  }
}

const matchedCategoryRule = computed(() => {
  const typed = projectForm.value.projectCategory.trim().toLowerCase()
  if (!typed) return null
  return categoryCatalog.value.find(c => c.category.toLowerCase() === typed) ?? null
})

watch(() => projectForm.value.projectCategory, () => {
  if (populatingForm.value) return
  const rule = matchedCategoryRule.value
  // Fills the stack only if the field is still empty: a category that
  // matches the catalogue proposes, it does not overwrite a choice already made.
  if (rule && !projectForm.value.projectStack.trim()) {
    projectForm.value.projectStack = rule.stack
  }
})

function useSuggestedStack() {
  if (matchedCategoryRule.value) {
    projectForm.value.projectStack = matchedCategoryRule.value.stack
  }
}

// ── Category autodiscover (.md brief → manifest → nothing) ─────
// One-off, never automatic: it proposes, it does not decide. The reading order is decided
// on the Rust side (category::discover) — here there is only the button and the state of the
// result, on the same scheme as runDiscovery in E2eModal.vue.
const categoryDiscovering = ref(false)
const categoryDiscoveryError = ref<string | null>(null)
const categoryDiscoveryEvidence = ref<string | null>(null)
const categoryDiscoveryRationale = ref<string | null>(null)
const hasWorkingDirForDiscovery = computed(() => !!projectForm.value.workingDir.trim())

async function runCategoryDiscovery() {
  if (!props.profile || !hasWorkingDirForDiscovery.value) return
  categoryDiscovering.value = true
  categoryDiscoveryError.value = null
  categoryDiscoveryEvidence.value = null
  categoryDiscoveryRationale.value = null
  try {
    const d = await invoke<{
      category: string
      stack: string
      rationale: string | null
      evidence: string | null
    }>('discover_project_category', {
      binary: props.profile.binary,
      configDir: props.profile.configDir ?? null,
      workingDir: projectForm.value.workingDir.trim(),
    })
    projectForm.value.projectCategory = d.category
    projectForm.value.projectStack = d.stack
    categoryDiscoveryRationale.value = d.rationale
    categoryDiscoveryEvidence.value = d.evidence
  } catch (e) {
    categoryDiscoveryError.value = String(e)
  } finally {
    categoryDiscovering.value = false
  }
}

function openNewProject() {
  populatingForm.value = true
  editingProject.value = null
  projectForm.value = {
    title: '', description: '', workingDir: '', color: '',
    testCommand: '', lintCommand: '', coverageCommand: '', reviewInvariants: '',
    sensitivePaths: '', projectCategory: '', projectStack: '',
  }
  projectError.value = ''
  categoryDiscoveryError.value = null
  categoryDiscoveryEvidence.value = null
  categoryDiscoveryRationale.value = null
  showProjectModal.value = true
  ensureCategoryCatalog()
  // The watcher on projectCategory is flushed at the next tick, not right away: without
  // waiting for it the flag would go back to false before the watcher sees it.
  nextTick(() => { populatingForm.value = false })
}

function openEditProject(p: Project, e: MouseEvent) {
  e.stopPropagation()
  populatingForm.value = true
  editingProject.value = p
  projectForm.value = {
    title: p.title,
    description: p.description ?? '',
    workingDir: p.workingDir ?? '',
    color: p.color ?? '',
    testCommand: p.testCommand ?? '',
    lintCommand: p.lintCommand ?? '',
    coverageCommand: p.coverageCommand ?? '',
    reviewInvariants: p.reviewInvariants ?? '',
    sensitivePaths: p.sensitivePaths ?? '',
    projectCategory: p.projectCategory ?? '',
    projectStack: p.projectStack ?? '',
  }
  projectError.value = ''
  categoryDiscoveryError.value = null
  categoryDiscoveryEvidence.value = null
  categoryDiscoveryRationale.value = null
  showProjectModal.value = true
  ensureCategoryCatalog()
  nextTick(() => { populatingForm.value = false })
}

async function saveProject() {
  if (!projectForm.value.title.trim()) { projectError.value = 'Title required.'; return }
  projectSaving.value = true
  projectError.value = ''
  try {
    const input = {
      title: projectForm.value.title.trim(),
      description: projectForm.value.description.trim() || null,
      workingDir: projectForm.value.workingDir.trim() || null,
      color: projectForm.value.color.trim() || null,
      testCommand: projectForm.value.testCommand.trim() || null,
      lintCommand: projectForm.value.lintCommand.trim() || null,
      coverageCommand: projectForm.value.coverageCommand.trim() || null,
      reviewInvariants: projectForm.value.reviewInvariants.trim() || null,
      sensitivePaths: projectForm.value.sensitivePaths.trim() || null,
      projectCategory: projectForm.value.projectCategory.trim() || null,
      projectStack: projectForm.value.projectStack.trim() || null,
    }
    if (editingProject.value) {
      await projectStore.update(editingProject.value.id, input)
    } else {
      const created = await projectStore.create(input)
      projectStore.setCurrentProject(created.id)
    }
    showProjectModal.value = false
  } catch (e) {
    projectError.value = String(e)
  } finally {
    projectSaving.value = false
  }
}

async function deleteCurrentProject() {
  if (!currentProject.value) return
  if (!confirm(`Delete project "${currentProject.value.title}" and all its sessions? This cannot be undone.`)) return
  await projectStore.remove(currentProject.value.id)
  showProjectModal.value = false
}

// ── Session selector ──────────────────────────────────────────
const showProjectSelector = ref(false)

function selectProject(id: string) {
  projectStore.setCurrentProject(id)
  showProjectSelector.value = false
}

// ── Session list ──────────────────────────────────────────────
const confirmTarget = ref<SessionInfo | null>(null)

function askDelete(e: MouseEvent, s: SessionInfo) {
  e.stopPropagation()
  confirmTarget.value = s
}

async function confirmDelete() {
  if (!confirmTarget.value) return
  await store.deleteSession(confirmTarget.value.id)
  confirmTarget.value = null
}

const displayedSessions = computed<SessionInfo[]>(() => {
  const base = searchQuery.value.trim() ? searchResults.value : savedSessions.value
  if (sessionId.value && !base.find(s => s.id === sessionId.value)) {
    return [{
      id: sessionId.value,
      projectId: currentProjectId.value ?? '',
      title: null, startedAt: '', command: null, workingDir: null,
      atomCount: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      totalCostUsd: null, attachments: [], gitBranch: null, gitBase: null,
      model: store.sessions[sessionId.value]?.model ?? null,
      lastContextTokens: null, cacheTtlSecs: null, lastCallAt: null,
    }, ...base]
  }
  return base
})

// ── Sessioni programmate (§ scheduler) ──────────────────────────
const scheduledForProject = computed<ScheduledSession[]>(() =>
  scheduledItems.value.filter(s => s.projectId === currentProjectId.value),
)

// `relativeTime` is pure: without a periodic tick "in 3m" would stay "in 3m"
// forever. `clockTick` is only a reactive dependency to force the recompute.
const clockTick = ref(0)
let clockTimer: ReturnType<typeof setInterval> | null = null

function scheduledLabel(s: ScheduledSession): string {
  void clockTick.value
  if (s.status === 'queued') return 'waiting…'
  if (s.status === 'missed') return 'missed'
  return relativeTime(s.runAt)
}

function scheduledIcon(s: ScheduledSession): string {
  if (s.status === 'queued') return '⏳'
  if (s.status === 'missed') return '⚠'
  return '⏱'
}

function scheduledTitle(s: ScheduledSession): string {
  const when = new Date(s.runAt).toLocaleString()
  const status = s.status === 'queued' ? '\nwaiting: working directory busy'
    : s.status === 'missed' ? '\nmissed while Pragma was closed'
    : ''
  return `${when}${status}\n${s.prompt.slice(0, 200)}`
}

async function cancelScheduled(e: MouseEvent, s: ScheduledSession) {
  e.stopPropagation()
  await scheduledStore.cancel(s.id)
}

onMounted(() => {
  if (currentProjectId.value) {
    store.fetchSavedSessions(currentProjectId.value)
    scheduledStore.refresh(currentProjectId.value)
  }
  clockTimer = setInterval(() => { clockTick.value++ }, 30_000)
})

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
})

// Reloads sessions when the current project changes.
watch(currentProjectId, (pid) => {
  searchQuery.value = ''
  searchResults.value = []
  if (pid) {
    store.fetchSavedSessions(pid)
    scheduledStore.refresh(pid)
  } else {
    store.savedSessions = []
  }
})

watch(searchQuery, (q) => {
  if (searchTimer) clearTimeout(searchTimer)
  if (!q.trim()) return
  searchTimer = setTimeout(async () => {
    searchResults.value = await store.searchSessions(q)
  }, 250)
})

function formatDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function shortId(id: string): string { return id.slice(0, 8) }

// Opening a session no longer kills another: the one being left keeps
// running and stays reachable. Changing focus is just changing focus.
async function openSession(id: string) {
  await store.loadSession(id)
}

defineExpose({ openNewProject })
</script>

<template>
  <aside class="session-panel" :class="{ 'is-collapsed': collapsed }" :style="!collapsed && props.width ? { width: props.width + 'px' } : undefined">
    <div class="panel-header">
      <template v-if="!collapsed">
        <span class="panel-title">Sessions</span>
      </template>
      <button class="collapse-btn" :title="collapsed ? 'Expand' : 'Collapse'" @click="collapsed = !collapsed">
        {{ collapsed ? '›' : '‹' }}
      </button>
    </div>

    <template v-if="!collapsed">
      <!-- Project selector -->
      <div class="project-bar">
        <div class="project-selector" data-testid="project-selector" @click="showProjectSelector = !showProjectSelector">
          <span v-if="currentProject?.color" class="project-dot" :style="{ background: currentProject.color }" />
          <span class="project-name" data-testid="project-name">{{ currentProject?.title ?? 'No project' }}</span>
          <span class="project-caret">▾</span>
        </div>
        <button v-if="showDesktopOnly" class="project-btn" data-testid="btn-new-project" title="New project" @click="openNewProject">+</button>
        <button v-if="showDesktopOnly && currentProject" class="project-btn" data-testid="btn-edit-project" title="Edit project" @click="openEditProject(currentProject, $event)">⚙</button>
      </div>

      <!-- Project dropdown -->
      <div v-if="showProjectSelector" class="project-dropdown">
        <div
          v-for="p in projects"
          :key="p.id"
          class="project-option"
          data-testid="project-option"
          :class="{ 'project-option--active': p.id === currentProjectId }"
          @click="selectProject(p.id)"
        >
          <span v-if="p.color" class="project-dot" :style="{ background: p.color }" />
          <span class="project-option-name">{{ p.title }}</span>
          <span class="project-option-count">{{ p.sessionCount }}</span>
        </div>
        <div v-if="projects.length === 0" class="project-option project-option--empty">No projects yet</div>
      </div>

      <!-- Live sessions on other projects -->
      <div v-if="elsewhere.length" class="elsewhere" data-testid="running-elsewhere">
        <div class="elsewhere-label">elsewhere</div>
        <div
          v-for="s in elsewhere"
          :key="s.id!"
          class="elsewhere-item"
          data-testid="elsewhere-item"
          :title="`${projectTitle(s.projectId)} — click to switch`"
          @click="openSession(s.id!)"
        >
          <span
            class="running-dot"
            :class="{ 'opus-running': s.model !== 'sonnet', 'is-paused': !s.running }"
          >●</span>
          <span class="elsewhere-name">{{ s.title || shortId(s.id!) }}</span>
          <span class="elsewhere-project">{{ projectTitle(s.projectId) }}</span>
        </div>
      </div>

      <!-- Scheduled sessions -->
      <div v-if="scheduledForProject.length" class="scheduled" data-testid="scheduled-list">
        <div class="elsewhere-label">scheduled</div>
        <div
          v-for="s in scheduledForProject"
          :key="s.id"
          class="scheduled-item"
          data-testid="scheduled-item"
          :class="{ 'scheduled-item--missed': s.status === 'missed' }"
          :title="scheduledTitle(s)"
        >
          <span class="scheduled-icon">{{ scheduledIcon(s) }}</span>
          <span class="scheduled-name">{{ s.title || s.prompt.slice(0, 40) }}</span>
          <span class="scheduled-when">{{ scheduledLabel(s) }}</span>
          <button v-if="canCommand" class="delete-btn" data-testid="scheduled-cancel" title="Cancel" @click="cancelScheduled($event, s)">✕</button>
        </div>
      </div>

      <!-- Search -->
      <div class="search-row">
        <input v-model="searchQuery" class="search-input" placeholder="search…" type="search" />
      </div>

      <!-- Session list -->
      <div v-if="!currentProject" class="empty-msg">Select or create a project to start.</div>

      <div v-else-if="displayedSessions.length === 0" class="empty-msg">
        {{ searchQuery ? 'No results.' : 'No sessions yet.' }}
      </div>

      <ul v-else class="session-list">
        <li
          v-for="s in displayedSessions"
          :key="s.id"
          class="session-item"
          data-testid="session-item"
          :class="{ active: sessionId === s.id }"
          :title="`ID: ${s.id}\n${s.command ?? ''}`"
          @click="openSession(s.id)"
        >
          <div class="session-row">
            <span
              class="session-name"
              :class="{ 'session-running': isRunning(s.id), 'opus-running': isRunning(s.id) && modelOf(s.id) !== 'sonnet' }"
            >
              {{ s.title || shortId(s.id) }}
              <span
                v-if="isRunning(s.id)"
                class="running-dot"
                :class="{ 'opus-running': modelOf(s.id) !== 'sonnet' }"
                title="running"
              >●</span>
            </span>
            <div class="session-row-right">
              <span class="session-atoms">{{ s.atomCount }}</span>
              <button v-if="showDesktopOnly" class="delete-btn" data-testid="session-delete" title="Delete session" @click="askDelete($event, s)">✕</button>
            </div>
          </div>
          <div class="session-date">
            {{ formatDate(s.startedAt) }}
            <span
              class="session-model-badge"
              :class="{ 'is-known': s.model && s.model !== 'sonnet', 'is-unknown': !s.model }"
              :title="s.model ? `Model: ${modelLabel(s)}` : 'Model not recorded (session started before this was tracked)'"
            >{{ modelLabel(s) }}</span>
          </div>
        </li>
      </ul>
    </template>
  </aside>

  <!-- Delete session modal -->
  <Teleport to="body">
    <div v-if="confirmTarget" class="delete-overlay" @click.self="confirmTarget = null">
      <div class="delete-modal">
        <div class="delete-modal-icon">🗑</div>
        <div class="delete-modal-title">Delete session?</div>
        <div class="delete-modal-name">{{ confirmTarget.title || confirmTarget.id.slice(0, 8) }}</div>
        <div class="delete-modal-hint">This action cannot be undone.</div>
        <div class="delete-modal-actions">
          <button class="delete-modal-cancel" data-testid="session-delete-cancel" @click="confirmTarget = null">Cancel</button>
          <button class="delete-modal-confirm" data-testid="session-delete-confirm" @click="confirmDelete">Delete</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Project create/edit modal -->
  <Teleport to="body">
    <div v-if="showProjectModal" class="delete-overlay" @click.self="showProjectModal = false">
      <div class="project-modal" data-testid="project-modal">
        <div class="project-modal-title">{{ editingProject ? 'Edit project' : 'New project' }}</div>

        <div class="project-fields">
          <div class="field field-full">
            <label class="project-field-label">Title *</label>
            <input v-model="projectForm.title" class="project-input" data-testid="project-title-input" placeholder="My Project" autofocus />
          </div>

          <div class="field field-full">
            <label class="project-field-label">Description</label>
            <input v-model="projectForm.description" class="project-input" placeholder="Optional description" />
          </div>

          <div class="field field-full">
            <label class="project-field-label">Default working directory</label>
            <input v-model="projectForm.workingDir" class="project-input" data-testid="project-workdir-input" placeholder="/path/to/repo" />
          </div>

          <!-- Category → stack: hard-wired on the Rust side (category.rs), bypassable constraint.
               <datalist> proposes, it does not impose — a category outside the catalogue is a
               legitimate case, not an error. -->
          <div class="field">
            <label class="project-field-label">Project category</label>
            <input
              v-model="projectForm.projectCategory"
              class="project-input"
              data-testid="project-category-input"
              list="project-category-options"
              placeholder="e.g. Desktop app"
            />
            <datalist id="project-category-options">
              <option v-for="c in categoryCatalog" :key="c.category" :value="c.category" />
            </datalist>
          </div>

          <div class="field">
            <label class="project-field-label">Stack</label>
            <input
              v-model="projectForm.projectStack"
              class="project-input"
              data-testid="project-stack-input"
              list="project-stack-options"
              placeholder="e.g. Rust/Tauri + CI/CD"
            />
            <datalist id="project-stack-options">
              <option v-for="c in categoryCatalog" :key="c.stack" :value="c.stack" />
            </datalist>
          </div>

          <!-- Autodiscover: .md brief in the working dir → manifest → nothing. Never
               automatic, always an explicit click. -->
          <div class="field field-full project-discovery-row">
            <button
              type="button"
              class="project-hint-action"
              data-testid="project-discover-category"
              :disabled="categoryDiscovering || !hasWorkingDirForDiscovery || !props.profile"
              :title="!hasWorkingDirForDiscovery ? 'Set a working directory first' : ''"
              @click="runCategoryDiscovery"
            >{{ categoryDiscovering ? 'Reading project…' : 'Detect from project' }}</button>
            <span v-if="categoryDiscoveryEvidence" class="project-discovery-evidence">{{ categoryDiscoveryEvidence }}</span>
          </div>
          <div v-if="categoryDiscoveryError" class="field field-full project-error">{{ categoryDiscoveryError }}</div>
          <div v-if="categoryDiscoveryRationale" class="field field-full project-hint">{{ categoryDiscoveryRationale }}</div>

          <!-- "Opening the hood": the rule applied stays visible, never a
               black-box proposal. -->
          <div v-if="matchedCategoryRule" class="field field-full project-hint">
            {{ matchedCategoryRule.rationale }}
            <button
              v-if="projectForm.projectStack.trim() !== matchedCategoryRule.stack"
              type="button"
              class="project-hint-action"
              @click="useSuggestedStack"
            >Use suggested stack: {{ matchedCategoryRule.stack }}</button>
          </div>

          <div class="field">
            <label class="project-field-label">Color (hex)</label>
            <input v-model="projectForm.color" class="project-input" placeholder="#7ec8a0" />
          </div>

          <div class="field">
            <label class="project-field-label">Test command</label>
            <input v-model="projectForm.testCommand" class="project-input" data-testid="project-test-command-input" placeholder="npm test" />
          </div>

          <div class="field">
            <label class="project-field-label">Lint command</label>
            <input v-model="projectForm.lintCommand" class="project-input" placeholder="npm run lint" />
          </div>

          <div class="field">
            <label class="project-field-label">Coverage command</label>
            <input v-model="projectForm.coverageCommand" class="project-input" placeholder="npm run coverage" />
          </div>

          <div class="field field-full">
            <label class="project-field-label">Review invariants</label>
            <textarea
              v-model="projectForm.reviewInvariants"
              class="project-input project-textarea"
              data-testid="project-review-invariants-input"
              rows="4"
              placeholder="Rules every diff must respect — contracts, parity with legacy, conventions. One per line. Leave empty for a generic review."
            />
          </div>

          <div class="field field-full">
            <label class="project-field-label">Sensitive paths</label>
            <textarea
              v-model="projectForm.sensitivePaths"
              class="project-input project-textarea"
              data-testid="project-sensitive-paths-input"
              rows="3"
              placeholder="Globs, one per line — e.g. src/auth/** or **/*.sql. A diff touching these gets a security pass in the review. Leave empty to use Pragma's default patterns."
            />
          </div>
        </div>

        <div v-if="projectError" class="project-error">{{ projectError }}</div>

        <div class="project-modal-actions">
          <button v-if="editingProject" class="delete-modal-confirm" style="background:#c0392b" @click="deleteCurrentProject">Delete project</button>
          <div style="flex:1" />
          <button class="delete-modal-cancel" data-testid="project-cancel" @click="showProjectModal = false">Cancel</button>
          <button class="delete-modal-confirm" data-testid="project-save" :disabled="projectSaving" @click="saveProject">
            {{ projectSaving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.session-panel {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-color);
  overflow: hidden;
  transition: none;
}

.session-panel.is-collapsed { width: 28px; }

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 8px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  gap: 4px;
  min-height: 37px;
}

.panel-title {
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
  text-transform: uppercase;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
}

.collapse-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 1rem;
  padding: 0 2px;
  line-height: 1;
  flex-shrink: 0;
  transition: color 0.15s;
}
.collapse-btn:hover { color: var(--text-primary); }

/* ── Project bar ── */
.project-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.project-selector {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  min-width: 0;
  padding: 2px 4px;
  border-radius: 4px;
  transition: background 0.12s;
}
.project-selector:hover { background: var(--bg-card); }

.project-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.project-name {
  font-size: 0.8rem;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.project-caret {
  font-size: 0.6rem;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.project-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.85rem;
  padding: 2px 4px;
  line-height: 1;
  border-radius: 4px;
  transition: color 0.12s, background 0.12s;
  flex-shrink: 0;
}
.project-btn:hover { color: var(--text-primary); background: var(--bg-card); }

/* ── Project dropdown ── */
.project-dropdown {
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-card);
  flex-shrink: 0;
  max-height: 160px;
  overflow-y: auto;
}

.project-option {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 0.8rem;
  color: var(--text-primary);
  transition: background 0.1s;
}
.project-option:hover { background: var(--bg-secondary); }
.project-option--active { color: var(--color-atom-code); }
.project-option--empty { color: var(--text-secondary); font-style: italic; cursor: default; }

.project-option-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project-option-count {
  font-size: 0.7rem;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-radius: 10px;
  padding: 0 5px;
  flex-shrink: 0;
}

/* ── Live sessions on other projects ── */
.elsewhere {
  border-bottom: 1px solid var(--border-color);
  padding: 6px 8px;
  flex-shrink: 0;
}

.elsewhere-label {
  font-size: 0.66rem;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--text-secondary);
  opacity: 0.7;
  margin-bottom: 3px;
}

.elsewhere-item {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 3px 4px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.12s;
}
.elsewhere-item:hover { background: var(--bg-card); }

.elsewhere-name {
  font-size: 0.78rem;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}

.elsewhere-project {
  font-size: 0.68rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-left: auto;
  opacity: 0.75;
}

/* Paused on the protocol: alive but not consuming — no blinking. */
.running-dot.is-paused { animation: none; opacity: 0.55; }

/* ── Scheduled sessions ── */
.scheduled {
  border-bottom: 1px solid var(--border-color);
  padding: 6px 8px;
  flex-shrink: 0;
}

.scheduled-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 4px;
  border-radius: 4px;
  transition: background 0.12s;
}
.scheduled-item:hover { background: var(--bg-card); }
.scheduled-item--missed { color: #d4a843; }

.scheduled-icon { font-size: 0.75rem; flex-shrink: 0; }

.scheduled-name {
  font-size: 0.78rem;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}

.scheduled-when {
  font-size: 0.68rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-left: auto;
  opacity: 0.75;
}

.scheduled-item .delete-btn { flex-shrink: 0; }

/* ── Search ── */
.search-row {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.search-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  padding: 4px 8px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.78rem;
  outline: none;
  transition: border-color 0.15s;
}
.search-input:focus { border-color: var(--color-atom-code); }
.search-input::placeholder { color: var(--text-secondary); opacity: 0.5; }

/* ── Session list ── */
.empty-msg {
  padding: 16px 12px;
  font-size: 0.78rem;
  color: var(--text-secondary);
  font-style: italic;
}

.session-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  flex: 1;
}

.session-item {
  padding: 8px 12px;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: background 0.12s, border-color 0.12s;
}
.session-item:hover { background: var(--bg-card); }
.session-item.locked { cursor: not-allowed; opacity: 0.5; }
.session-item.active { border-left-color: var(--color-atom-code); background: var(--bg-card); }

/* Web on a narrow screen: the list is full screen and used with a finger. */
@media (max-width: 899px) {
  html.web .session-item { padding: 12px 16px; }
  html.web .project-bar { padding: 8px 12px; }
  html.web .project-selector { padding-top: 6px; padding-bottom: 6px; }
}

.session-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2px;
}

.session-row-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.delete-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.65rem;
  padding: 0 2px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}
.session-item:hover .delete-btn { opacity: 1; }
.delete-btn:hover { color: #e05555; }

.session-running { color: var(--color-atom-code); font-style: italic; }
.session-running.opus-running { color: #a07de0; }

.running-dot {
  font-style: normal;
  font-size: 0.6rem;
  color: var(--color-atom-code);
  margin-left: 3px;
  animation: blink 1.2s step-start infinite;
}
.running-dot.opus-running { color: #a07de0; }

@keyframes blink { 50% { opacity: 0; } }

.session-name {
  font-size: 0.82rem;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 155px;
}

.session-atoms {
  font-size: 0.72rem;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border-radius: 10px;
  padding: 1px 6px;
  flex-shrink: 0;
}

.session-date { font-size: 0.72rem; color: var(--text-secondary); }

.session-model-badge {
  margin-left: 6px;
  font-size: 0.64rem;
  font-weight: 700;
  padding: 0px 5px;
  border-radius: 7px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
.session-model-badge.is-known { background: rgba(160, 125, 224, 0.18); color: #a07de0; }
.session-model-badge.is-unknown { opacity: 0.5; font-weight: 400; text-transform: none; }
</style>

<style>
/* Delete session modal */
.delete-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(2px);
}

.delete-modal {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 28px 32px 24px;
  min-width: 280px;
  max-width: 360px;
  text-align: center;
  box-shadow: 0 8px 40px rgba(0,0,0,0.4);
}
.delete-modal-icon { font-size: 2rem; margin-bottom: 12px; }
.delete-modal-title { font-size: 1rem; font-weight: 600; color: var(--text-primary); margin-bottom: 6px; }
.delete-modal-name {
  font-size: 0.82rem; color: var(--color-atom-code); font-family: monospace;
  background: var(--bg-secondary); border-radius: 6px; padding: 4px 10px;
  display: inline-block; margin-bottom: 10px;
}
.delete-modal-hint { font-size: 0.78rem; color: var(--text-secondary); margin-bottom: 20px; }
.delete-modal-actions { display: flex; gap: 10px; justify-content: center; }
.delete-modal-cancel {
  padding: 7px 20px; border-radius: 7px; border: 1px solid var(--border-color);
  background: none; color: var(--text-primary); font-family: inherit; font-size: 0.85rem;
  cursor: pointer; transition: background 0.12s;
}
.delete-modal-cancel:hover { background: var(--bg-secondary); }
.delete-modal-confirm {
  padding: 7px 20px; border-radius: 7px; border: none; background: #c0392b;
  color: #fff; font-family: inherit; font-size: 0.85rem; font-weight: 600;
  cursor: pointer; transition: background 0.12s;
}
.delete-modal-confirm:hover { background: #e74c3c; }
.delete-modal-confirm:disabled { opacity: 0.5; cursor: not-allowed; }

/* Project create/edit modal */
.project-modal {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 24px 28px 20px;
  min-width: 320px;
  max-width: 680px;
  width: 100%;
  box-shadow: 0 8px 40px rgba(0,0,0,0.4);
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 88vh;
  overflow-y: auto;
}
.project-modal-title {
  font-size: 1rem; font-weight: 600; color: var(--text-primary);
  margin-bottom: 10px;
}

/* Two columns — single fields (commands, category/stack, colour…) side by side,
   long ones (title, working dir, textarea) across the full width via
   .field-full. Below a certain width it goes back to one column: two narrow inputs
   side by side become unreadable before it is worth keeping them in a row. */
.project-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 16px;
}
.field { display: flex; flex-direction: column; min-width: 0; }
.field-full { grid-column: 1 / -1; }

@media (max-width: 520px) {
  .project-fields { grid-template-columns: 1fr; }
}

.project-field-label { font-size: 0.75rem; color: var(--text-secondary); margin-top: 6px; }
.project-input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-secondary); border: 1px solid var(--border-color);
  border-radius: 6px; padding: 6px 10px;
  color: var(--text-primary); font-family: inherit; font-size: 0.85rem;
  outline: none; transition: border-color 0.15s;
}
.project-input:focus { border-color: var(--color-atom-code); }
.project-textarea { resize: vertical; min-height: 62px; line-height: 1.45; }
.project-error { font-size: 0.78rem; color: #e05555; margin-top: 4px; }
.project-warning { font-size: 0.78rem; color: #c9a227; margin-top: 4px; }

/* Applied category→stack rule — "opening the hood", never a black box. */
.project-hint {
  font-size: 0.75rem; color: var(--text-secondary);
  background: var(--bg-secondary); border: 1px solid var(--border-color);
  border-radius: 6px; padding: 6px 10px; line-height: 1.45;
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
}
.project-hint-action {
  background: none; border: 1px solid var(--color-atom-code);
  color: var(--color-atom-code); border-radius: 5px;
  padding: 2px 8px; font-size: 0.72rem; font-family: inherit;
  cursor: pointer; transition: background 0.12s;
  white-space: nowrap;
}
.project-hint-action:hover { background: var(--bg-card); }
.project-hint-action:disabled { opacity: 0.5; cursor: not-allowed; }

.project-discovery-row { flex-direction: row; align-items: center; gap: 10px; flex-wrap: wrap; }
.project-discovery-evidence { font-size: 0.72rem; color: var(--text-secondary); font-style: italic; }

.project-modal-actions { display: flex; gap: 10px; align-items: center; margin-top: 14px; }
</style>
