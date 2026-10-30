import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '../platform'

const LS_KEY = 'pragma_current_project_id'

export interface Project {
  id: string
  title: string
  slug: string
  description: string | null
  workingDir: string | null
  color: string | null
  // Optional shell commands used by the VERIFY phase. testCommand
  // takes part in the gate with the new failures compared with verifyBaseline; lint/coverage are
  // informational only in TestsCard.
  testCommand: string | null
  lintCommand: string | null
  coverageCommand: string | null
  verifyBaseline: string | null
  // Invariants the REVIEW phase must check on every diff (contracts, parity with
  // legacy, conventions…). Injected into the separate review session — see review.rs.
  // Empty = generic review.
  reviewInvariants: string | null
  // Config of the on-demand E2E run. Written by the E2E popup via updateE2eConfig,
  // not by the project form: it is chosen once with discovery. Generated specs and scripts
  // do not live here — they live in <workingDir>/.autoTest/.
  // e2eCommand null = E2E not configured, the button stays off.
  e2eCommand: string | null
  e2ePrecondition: string | null
  e2eRunner: string | null
  // Globs (one per line) of the project's sensitive surfaces: if the session diff
  // touches one, REVIEW also gets the security hand-off (see review.rs).
  // Empty = Pragma uses its default patterns.
  sensitivePaths: string | null
  // Category requested by the client and stack derived from the hard-wired category→stack table.
  // Free text, always correctable — no DB-side constraint.
  projectCategory: string | null
  projectStack: string | null
  // Command of the on-demand "Live" button. Written by the Live popup, not by the project
  // form — same pattern as e2eCommand. null = button off.
  liveCommand: string | null
  createdAt: string
  updatedAt: string
  sessionCount: number
}

export interface CreateProjectInput {
  title: string
  description?: string | null
  workingDir?: string | null
  color?: string | null
  testCommand?: string | null
  lintCommand?: string | null
  coverageCommand?: string | null
  reviewInvariants?: string | null
  sensitivePaths?: string | null
  projectCategory?: string | null
  projectStack?: string | null
}

export const useProjectStore = defineStore('projects', () => {
  const projects = ref<Project[]>([])
  const currentProjectId = ref<string | null>(localStorage.getItem(LS_KEY))

  const currentProject = computed<Project | null>(
    () => projects.value.find(p => p.id === currentProjectId.value) ?? null
  )

  const hasProjects = computed(() => projects.value.length > 0)

  async function load() {
    try {
      projects.value = await invoke<Project[]>('list_projects')
      // If the saved ID no longer exists, selects the first one available.
      if (currentProjectId.value && !projects.value.find(p => p.id === currentProjectId.value)) {
        setCurrentProject(projects.value[0]?.id ?? null)
      } else if (!currentProjectId.value && projects.value.length > 0) {
        setCurrentProject(projects.value[0].id)
      }
    } catch (e) {
      console.error('[pragma] list_projects:', e)
    }
  }

  async function create(input: CreateProjectInput): Promise<Project> {
    const project = await invoke<Project>('create_project', {
      title: input.title,
      description: input.description ?? null,
      workingDir: input.workingDir ?? null,
      color: input.color ?? null,
      testCommand: input.testCommand ?? null,
      lintCommand: input.lintCommand ?? null,
      coverageCommand: input.coverageCommand ?? null,
      reviewInvariants: input.reviewInvariants ?? null,
      sensitivePaths: input.sensitivePaths ?? null,
      projectCategory: input.projectCategory ?? null,
      projectStack: input.projectStack ?? null,
    })
    projects.value.unshift(project)
    return project
  }

  async function update(id: string, input: CreateProjectInput): Promise<void> {
    await invoke('update_project', {
      id,
      title: input.title,
      description: input.description ?? null,
      workingDir: input.workingDir ?? null,
      color: input.color ?? null,
      testCommand: input.testCommand ?? null,
      lintCommand: input.lintCommand ?? null,
      coverageCommand: input.coverageCommand ?? null,
      reviewInvariants: input.reviewInvariants ?? null,
      sensitivePaths: input.sensitivePaths ?? null,
      projectCategory: input.projectCategory ?? null,
      projectStack: input.projectStack ?? null,
    })
    const idx = projects.value.findIndex(p => p.id === id)
    if (idx !== -1) {
      projects.value[idx] = { ...projects.value[idx], ...input, updatedAt: new Date().toISOString() }
    }
  }

  async function remove(id: string): Promise<void> {
    await invoke('delete_project', { id })
    projects.value = projects.value.filter(p => p.id !== id)
    if (currentProjectId.value === id) {
      setCurrentProject(projects.value[0]?.id ?? null)
    }
  }

  async function updateE2eConfig(
    id: string,
    e2eCommand: string | null,
    e2ePrecondition: string | null,
    e2eRunner: string | null,
  ): Promise<void> {
    await invoke('update_e2e_config', { projectId: id, e2eCommand, e2ePrecondition, e2eRunner })
    const idx = projects.value.findIndex(p => p.id === id)
    if (idx !== -1) {
      projects.value[idx] = { ...projects.value[idx], e2eCommand, e2ePrecondition, e2eRunner }
    }
  }

  async function updateLiveCommand(id: string, liveCommand: string | null): Promise<void> {
    await invoke('update_live_command', { projectId: id, liveCommand })
    const idx = projects.value.findIndex(p => p.id === id)
    if (idx !== -1) {
      projects.value[idx] = { ...projects.value[idx], liveCommand }
    }
  }

  function setCurrentProject(id: string | null) {
    currentProjectId.value = id
    if (id) {
      localStorage.setItem(LS_KEY, id)
    } else {
      localStorage.removeItem(LS_KEY)
    }
  }

  return {
    projects,
    currentProjectId,
    currentProject,
    hasProjects,
    load,
    create,
    update,
    updateE2eConfig,
    updateLiveCommand,
    remove,
    setCurrentProject,
  }
})
