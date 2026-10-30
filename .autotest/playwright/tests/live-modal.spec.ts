import { test, expect } from '@playwright/experimental-ct-vue'
import LiveModal from '../../../src/components/LiveModal.vue'
import type { Project } from '../../../src/stores/projects'

// Component tests for LiveModal.vue.
// Scope: frontend rendering + store-action wiring only, same boundary as review-card.spec.ts —
// session.runLive/stopLive are stubbed (createTestingPinia stubActions), no real invoke/IPC.
// project.open's watcher (which reseeds `command` from project.liveCommand) only fires on a
// *change* of the open prop, not on initial mount — so these tests read state that's driven
// by the store/props directly (configured/hasWorkingDir/canRun), not the local `command` ref.

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    title: 'Target',
    slug: 'target',
    description: null,
    workingDir: 'C:/work',
    color: null,
    testCommand: null,
    lintCommand: null,
    coverageCommand: null,
    verifyBaseline: null,
    reviewInvariants: null,
    e2eCommand: null,
    e2ePrecondition: null,
    e2eRunner: null,
    sensitivePaths: null,
    projectCategory: null,
    projectStack: null,
    liveCommand: 'npm run tauri dev',
    createdAt: '2026-08-04T00:00:00Z',
    updatedAt: '2026-08-04T00:00:00Z',
    sessionCount: 0,
    ...overrides,
  }
}

test('shows a warning when no working directory is set', async ({ mount, page }) => {
  const component = await mount(LiveModal, {
    props: { open: true, workingDir: '' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await expect(page.locator('.live-warn').first()).toContainText('No working directory set')
})

test('Run is disabled when the project has no live command configured', async ({ mount, page }) => {
  const component = await mount(LiveModal, {
    props: { open: true, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project({ liveCommand: null })], currentProjectId: 'p1' },
    },
  })
  await expect(page.locator('[data-testid="live-run"]')).toBeDisabled()
})

test('Run is disabled without a working directory even if configured', async ({ mount, page }) => {
  const component = await mount(LiveModal, {
    props: { open: true, workingDir: '' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await expect(page.locator('[data-testid="live-run"]')).toBeDisabled()
})

test('Run is enabled when configured with a working directory and idle', async ({ mount, page }) => {
  const component = await mount(LiveModal, {
    props: { open: true, workingDir: 'C:/work' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await expect(page.locator('[data-testid="live-run"]')).toBeEnabled()
  await expect(page.locator('[data-testid="live-run"]')).toHaveText('Run')
})

test('clicking Run calls session.runLive with the working dir and one-shot timeout', async ({ mount, page }) => {
  const component = await mount(LiveModal, {
    props: { open: true, workingDir: 'C:/work/target' },
    hooksConfig: { projectsState: { projects: [project({ id: 'proj-9' })], currentProjectId: 'proj-9' } },
  })
  await page.locator('[data-testid="live-run"]').click()
  const calls = await component.evaluate(() => (window as any).__sessionStore().runLive.calls)
  expect(calls).toEqual([['proj-9', 'C:/work/target', false, 600]])
})

test('checking long-running switches the run to unbounded with no timeout', async ({ mount, page }) => {
  const component = await mount(LiveModal, {
    props: { open: true, workingDir: 'C:/work' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await page.locator('.live-check input[type=checkbox]').check()
  await expect(page.locator('.live-number')).toHaveCount(0)
  await page.locator('[data-testid="live-run"]').click()
  const calls = await component.evaluate(() => (window as any).__sessionStore().runLive.calls)
  expect(calls).toEqual([['p1', 'C:/work', true, undefined]])
})

test('while running shows Running label, a Stop button, and disables Run', async ({ mount, page }) => {
  const component = await mount(LiveModal, {
    props: { open: true, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      liveState: { liveRunning: true },
    },
  })
  await expect(page.locator('[data-testid="live-run"]')).toHaveText('Running…')
  await expect(page.locator('[data-testid="live-run"]')).toBeDisabled()
  await page.locator('.live-ghost').click()
  const calls = await component.evaluate(() => (window as any).__sessionStore().stopLive.calls)
  expect(calls).toEqual([[]])
})

test('streamed output lines render, stderr lines get the error style', async ({ mount, page }) => {
  const component = await mount(LiveModal, {
    props: { open: true, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      liveState: {
        liveRunning: true,
        liveOutputLines: [
          { line: 'compiling…', stderr: false },
          { line: 'warning: unused import', stderr: true },
        ],
      },
    },
  })
  const lines = page.locator('.live-output-line')
  await expect(lines).toHaveCount(2)
  await expect(lines.nth(1)).toHaveClass(/is-stderr/)
})

test('exit 0 shows a passed result badge with duration', async ({ mount, page }) => {
  const component = await mount(LiveModal, {
    props: { open: true, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      liveState: {
        pragmaLive: { command: 'npm run tauri dev', output: '', exitCode: 0, timedOut: false, cancelled: false, durationMs: 1500 },
      },
    },
  })
  const result = page.locator('.live-result')
  await expect(result).toHaveClass(/passed/)
  await expect(result).toContainText('✓ Exit 0')
  await expect(result).toContainText('1.5s')
})

test('a non-zero exit shows a failed result badge', async ({ mount, page }) => {
  const component = await mount(LiveModal, {
    props: { open: true, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      liveState: {
        pragmaLive: { command: 'npm run tauri dev', output: '', exitCode: 1, timedOut: false, cancelled: false, durationMs: 500 },
      },
    },
  })
  const result = page.locator('.live-result')
  await expect(result).toHaveClass(/failed/)
  await expect(result).toContainText('✗ Exit 1')
})

test('a timed-out run shows the timed-out badge instead of an exit code', async ({ mount, page }) => {
  const component = await mount(LiveModal, {
    props: { open: true, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      liveState: {
        pragmaLive: { command: 'npm run tauri dev', output: '', exitCode: null, timedOut: true, cancelled: false, durationMs: 600000 },
      },
    },
  })
  await expect(page.locator('.live-result')).toContainText('⚠ Timed out')
})

test('a manually stopped run shows the stopped badge', async ({ mount, page }) => {
  const component = await mount(LiveModal, {
    props: { open: true, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      liveState: {
        pragmaLive: { command: 'npm run tauri dev', output: '', exitCode: null, timedOut: false, cancelled: true, durationMs: 3000 },
      },
    },
  })
  await expect(page.locator('.live-result')).toContainText('⏹ Stopped')
})

test('the result badge is hidden while a run is in progress', async ({ mount, page }) => {
  const component = await mount(LiveModal, {
    props: { open: true, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      liveState: {
        liveRunning: true,
        pragmaLive: { command: 'npm run tauri dev', output: '', exitCode: 0, timedOut: false, cancelled: false, durationMs: 1500 },
      },
    },
  })
  await expect(page.locator('.live-result')).toHaveCount(0)
})
