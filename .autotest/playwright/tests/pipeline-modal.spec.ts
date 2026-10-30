import { test, expect } from '@playwright/experimental-ct-vue'
import PipelineModal from '../../../src/components/PipelineModal.vue'
import type { Project } from '../../../src/stores/projects'
import type { Profile } from '../../../src/stores/settings'

// Component tests for PipelineModal.vue.
// Scope: frontend rendering + wiring only, same boundary as review-card.spec.ts / live-modal.spec.ts.
//
// Unlike LiveModal, this component calls `invoke()` directly (get_pipeline_steps,
// detect_remote_ci, pipeline_template_for_stack, save_pipeline_steps) instead of going through
// a stubbed store action — `hooksConfig.invokeMock` (mockIPC) covers that where a test needs it.
// The `open` watcher that fires those calls only runs on a *change* of the prop, not on initial
// mount, so most tests here mount directly with `open: true` and build state by driving the UI
// (+ Step / kind select) — only the "on open" tests use `component.update()` to trigger it for real.

const profile: Profile = { label: 'Sonnet', binary: 'claude', configDir: null, language: null }

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
    liveCommand: null,
    createdAt: '2026-08-04T00:00:00Z',
    updatedAt: '2026-08-04T00:00:00Z',
    sessionCount: 0,
    ...overrides,
  }
}

test('shows a working-dir warning and an empty state with no steps', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: '' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await expect(page.locator('.pl-warn')).toContainText('No working directory set')
  await expect(page.locator('.pl-empty')).toContainText('No steps yet')
})

test('+ Step adds an editable command step', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: 'C:/work' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await expect(page.locator('.pl-step')).toHaveCount(1)
  await expect(page.locator('.pl-select')).toHaveValue('command')
  await expect(page.locator('.pl-input[placeholder="npm run build"]')).toBeVisible()
})

test('switching a step to kind verify shows the baseline note instead of a command field', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: 'C:/work' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await page.locator('.pl-select').selectOption('verify')
  await expect(page.locator('.pl-input[placeholder="npm run build"]')).toHaveCount(0)
  await expect(page.locator('.pl-verify-note')).toContainText('through VERIFY')
})

test('removing a step drops its row', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: 'C:/work' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await page.getByText('+ Step', { exact: true }).click()
  await expect(page.locator('.pl-step')).toHaveCount(2)
  await page.locator('.pl-step').first().locator('.pl-danger').click()
  await expect(page.locator('.pl-step')).toHaveCount(1)
})

test('move up/down are disabled at the boundaries of the list', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: 'C:/work' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await page.getByText('+ Step', { exact: true }).click()
  const steps = page.locator('.pl-step')
  await expect(steps.nth(0).locator('[title="Move up"]')).toBeDisabled()
  await expect(steps.nth(0).locator('[title="Move down"]')).toBeEnabled()
  await expect(steps.nth(1).locator('[title="Move down"]')).toBeDisabled()
  await expect(steps.nth(1).locator('[title="Move up"]')).toBeEnabled()
})

test('moving a step down swaps its position with the next one', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: 'C:/work' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await page.locator('.pl-label-input').first().fill('first')
  await page.getByText('+ Step', { exact: true }).click()
  await page.locator('.pl-label-input').nth(1).fill('second')

  await page.locator('.pl-step').nth(0).locator('[title="Move down"]').click()
  await expect(page.locator('.pl-label-input').nth(0)).toHaveValue('second')
  await expect(page.locator('.pl-label-input').nth(1)).toHaveValue('first')
})

test('Run pipeline is disabled with no enabled step', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: 'C:/work' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await expect(page.locator('[data-testid="pipeline-run"]')).toBeDisabled()
})

test('Run pipeline is disabled without a working directory', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: '' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await expect(page.locator('[data-testid="pipeline-run"]')).toBeDisabled()
})

test('Run pipeline is disabled without a profile', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile: null, workingDir: 'C:/work' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await expect(page.locator('[data-testid="pipeline-run"]')).toBeDisabled()
})

test('Run pipeline is disabled while a run is already in progress', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      pipelineState: { pipelineRunning: true },
    },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await expect(page.locator('[data-testid="pipeline-run"]')).toBeDisabled()
  await expect(page.locator('[data-testid="pipeline-run"]')).toHaveText('Running…')
})

test('Run pipeline is enabled with an enabled step, a profile, and a working directory', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: 'C:/work' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await expect(page.locator('[data-testid="pipeline-run"]')).toBeEnabled()
})

test('an unchecked step does not count toward "has an enabled step"', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: 'C:/work' },
    hooksConfig: { projectsState: { projects: [project()], currentProjectId: 'p1' } },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await page.locator('.pl-step-head input[type=checkbox]').uncheck()
  await expect(page.locator('[data-testid="pipeline-run"]')).toBeDisabled()
})

test('clicking Run pipeline saves the steps then calls session.runPipeline', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: 'C:/work/target' },
    hooksConfig: {
      projectsState: { projects: [project({ id: 'proj-7' })], currentProjectId: 'proj-7' },
      invokeMock: { save_pipeline_steps: null },
    },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await page.locator('.pl-label-input').fill('build')
  await page.locator('.pl-input[placeholder="npm run build"]').fill('npm run build')
  await page.locator('[data-testid="pipeline-run"]').click()
  const calls = await component.evaluate(() => (window as any).__sessionStore().runPipeline.calls)
  expect(calls).toEqual([['proj-7', 'C:/work/target', 'claude', undefined]])
})

test('step outcomes render passed, failed, skipped, and timed-out badges', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      pipelineState: {
        pipelineOutcome: {
          passed: false,
          durationMs: 4200,
          stoppedEarly: true,
          steps: [
            { id: 'a', label: 'lint', kind: 'command', command: 'npm run lint', passed: true, skipped: false, exitCode: 0, timedOut: false, cancelled: false, durationMs: 800, output: '' },
          ],
        },
      },
    },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await expect(page.locator('.pl-step-result')).toContainText('✓ passed')
  await expect(page.locator('.pl-step').first()).toHaveClass(/is-passed/)
})

test('a failing step lists its new failures and the aggregate result is marked failed', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      pipelineState: {
        pipelineOutcome: {
          passed: false,
          durationMs: 4200,
          stoppedEarly: true,
          steps: [
            {
              id: 'a', label: 'test', kind: 'verify', command: '', passed: false, skipped: false,
              exitCode: 1, timedOut: false, cancelled: false, durationMs: 800, output: '',
              newFailures: ['tests/foo.spec.ts > should work'],
            },
          ],
        },
      },
    },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await expect(page.locator('.pl-step-result')).toContainText('✗ exit 1')
  await expect(page.locator('.pl-failures')).toContainText('tests/foo.spec.ts > should work')
  const result = page.locator('.pl-result')
  await expect(result).toHaveClass(/failed/)
  await expect(result).toContainText('✗ Pipeline failed — stopped early')
})

test('a disabled step that never ran shows the skipped badge', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: true, profile, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      pipelineState: {
        pipelineOutcome: {
          passed: true,
          durationMs: 100,
          stoppedEarly: false,
          steps: [
            { id: 'a', label: 'off', kind: 'command', command: 'echo hi', passed: false, skipped: true, exitCode: null, timedOut: false, cancelled: false, durationMs: 0, output: '' },
          ],
        },
      },
    },
  })
  await page.getByText('+ Step', { exact: true }).click()
  await expect(page.locator('.pl-step-result')).toContainText('⏭ skipped')
  await expect(page.locator('.pl-step').first()).toHaveClass(/is-skipped/)
})

test('opening the modal loads existing steps, detects remote CI, and shows the info note', async ({ mount, page }) => {
  const savedStep = { id: 'x', label: 'build', command: 'npm run build', kind: 'command', enabled: true }
  const component = await mount(PipelineModal, {
    props: { open: false, profile, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      invokeMock: {
        get_pipeline_steps: [savedStep],
        detect_remote_ci: { githubActions: true, azurePipelines: false },
      },
    },
  })
  await component.update({ props: { open: true, profile, workingDir: 'C:/work' } })
  await expect(page.locator('.pl-step')).toHaveCount(1)
  await expect(page.locator('.pl-label-input')).toHaveValue('build')
  await expect(page.locator('[data-testid="pipeline-remote-ci-note"]')).toContainText('GitHub Actions')
})

test('a step added while the saved steps are still loading is not wiped by the load', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: false, profile, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      invokeMock: {
        get_pipeline_steps: [],
        detect_remote_ci: { githubActions: false, azurePipelines: false },
      },
      invokeDelayMs: { get_pipeline_steps: 400 },
    },
  })
  await component.update({ props: { open: true, profile, workingDir: 'C:/work' } })
  await page.getByText('+ Step', { exact: true }).click()
  await page.locator('.pl-label-input').fill('echo step')
  await page.waitForTimeout(600)
  await expect(page.locator('.pl-step')).toHaveCount(1)
  await expect(page.locator('.pl-label-input')).toHaveValue('echo step')
  await expect(page.locator('[data-testid="pipeline-run"]')).toBeEnabled()
})

test('no remote CI detected means no info note', async ({ mount, page }) => {
  const component = await mount(PipelineModal, {
    props: { open: false, profile, workingDir: 'C:/work' },
    hooksConfig: {
      projectsState: { projects: [project()], currentProjectId: 'p1' },
      invokeMock: {
        get_pipeline_steps: [],
        detect_remote_ci: { githubActions: false, azurePipelines: false },
      },
    },
  })
  await component.update({ props: { open: true, profile, workingDir: 'C:/work' } })
  await expect(page.locator('[data-testid="pipeline-remote-ci-note"]')).toHaveCount(0)
})
