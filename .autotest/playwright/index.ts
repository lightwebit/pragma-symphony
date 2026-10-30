import { beforeMount } from '@playwright/experimental-ct-vue/hooks'
import { createTestingPinia } from '@pinia/testing'
import { mockIPC } from '@tauri-apps/api/mocks'
import {
  useSessionStore, DRAFT_KEY, createSessionState,
  type SessionState, type PragmaState, type PragmaLive, type LiveOutputLine, type PipelineOutcome,
} from '../../src/stores/session'
import type { Project } from '../../src/stores/projects'

// Simple call-recording spy — createTestingPinia defaults to detecting vitest/jest
// globals for its spy, neither of which exist in this browser-mounted CT runtime.
function recordingSpy() {
  const fn = (...args: unknown[]) => {
    ;(fn as any).calls.push(args)
  }
  ;(fn as any).calls = []
  return fn
}

/** `pragma` is merged shallowly (below) so tests can set e.g. just `pragma.review`
 *  without rebuilding the whole PragmaState. */
export type SessionStateOverrides = Partial<Omit<SessionState, 'pragma'>> & {
  pragma?: Partial<PragmaState>
}

export interface HooksConfig {
  sessionState?: SessionStateOverrides
  // Backs useProjectStore() for components (LiveModal, PipelineModal) that read
  // projects.currentProject instead of taking props for that data.
  projectsState?: { projects?: Project[]; currentProjectId?: string | null }
  // PipelineModal calls `invoke()` directly (get_pipeline_steps, detect_remote_ci,
  // pipeline_template_for_stack, save_pipeline_steps) instead of going through a
  // stubbed store action — mockIPC intercepts those. Commands not listed resolve to
  // `undefined`, same as an unmocked Tauri command would never be called.
  invokeMock?: Record<string, unknown>
  // Delay in ms for each mocked command: reproduces the race between an
  // in-flight invoke and the user clicking in the meantime.
  invokeDelayMs?: Record<string, number>
  // Live/Pipeline outcome state lives on top-level session store refs, not inside
  // the per-session map (it's per-project, not per-session).
  // Unlike `running`/`reviewAccepted` these are plain refs, so Pinia's initialState
  // patches them directly.
  liveState?: { pragmaLive?: PragmaLive | null; liveRunning?: boolean; liveOutputLines?: LiveOutputLine[] }
  pipelineState?: {
    pipelineOutcome?: PipelineOutcome | null
    pipelineRunning?: boolean
    pipelineOutput?: Record<number, LiveOutputLine[]>
    pipelineStepIdx?: number | null
  }
}

// `running`, `reviewAccepted`, `canFixReview`… are writable `computed()` proxies onto
// `sessions.value[activeKey]` (src/stores/session.ts, per-session store refactor). Pinia's
// setup-store state detection excludes computed refs from `$state` (see pinia's
// `isComputed` check), so patching those flat keys via createTestingPinia's `initialState`
// is silently a no-op. The only state Pinia actually patches is the raw `sessions`/`activeKey`
// refs — so we seed the draft session directly, in its real nested shape.
function buildSessionState(overrides: SessionStateOverrides = {}): SessionState {
  const { pragma, ...rest } = overrides
  const base = createSessionState(rest)
  return { ...base, pragma: { ...base.pragma, ...pragma } }
}

beforeMount<HooksConfig>(async ({ app, hooksConfig }) => {
  if (hooksConfig?.invokeMock) {
    const responses = hooksConfig.invokeMock
    const delays = hooksConfig.invokeDelayMs ?? {}
    mockIPC(async (cmd) => {
      if (delays[cmd]) await new Promise(r => setTimeout(r, delays[cmd]))
      return cmd in responses ? responses[cmd] : undefined
    })
  }

  const pinia = createTestingPinia({
    createSpy: recordingSpy,
    stubActions: true,
    initialState: {
      session: {
        sessions: { [DRAFT_KEY]: buildSessionState(hooksConfig?.sessionState) },
        activeKey: DRAFT_KEY,
        pragmaLive: hooksConfig?.liveState?.pragmaLive ?? null,
        liveRunning: hooksConfig?.liveState?.liveRunning ?? false,
        liveOutputLines: hooksConfig?.liveState?.liveOutputLines ?? [],
        pipelineOutcome: hooksConfig?.pipelineState?.pipelineOutcome ?? null,
        pipelineRunning: hooksConfig?.pipelineState?.pipelineRunning ?? false,
        pipelineOutput: hooksConfig?.pipelineState?.pipelineOutput ?? {},
        pipelineStepIdx: hooksConfig?.pipelineState?.pipelineStepIdx ?? null,
      },
      projects: {
        projects: hooksConfig?.projectsState?.projects ?? [],
        currentProjectId: hooksConfig?.projectsState?.currentProjectId ?? null,
      },
    },
  })
  app.use(pinia)
  // Exposed so tests can inspect stubbed-action call args via component.evaluate() —
  // actions are stubbed (no real `invoke`/IPC), so this is the only way to assert wiring.
  ;(window as any).__sessionStore = () => useSessionStore(pinia)
})
