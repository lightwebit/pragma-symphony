import { test, expect } from '@playwright/experimental-ct-vue'
import ReviewCard from '../../../src/components/ReviewCard.vue'
import type { PragmaReview, ReviewFinding } from '../../../src/stores/session'

// Component tests for ReviewCard.vue.
// Scope: frontend rendering + store-action wiring only. Playwright does not drive the
// Tauri shell here — the store's actions are stubbed (createTestingPinia stubActions),
// so no real `invoke`/IPC ever fires. Full-stack VERIFY+REVIEW behavior is collaudo manuale.

const profile = { label: 'Sonnet', binary: 'claude', configDir: null }

function review(overrides: Partial<PragmaReview> = {}): PragmaReview {
  return {
    verdict: 'pass',
    findings: [],
    note: null,
    diffTruncated: false,
    round: 0,
    usedInvariants: true,
    filesChanged: 1,
    linesChanged: 10,
    deepReviewSuggested: false,
    securityPass: false,
    sensitiveFiles: [],
    sensitiveFromDefaults: false,
    ...overrides,
  }
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: 'medium',
    file: 'src/foo.ts',
    line: 42,
    summary: 'Missing null check',
    detail: 'Explanation of the issue.',
    ...overrides,
  }
}

test('pass verdict shows the passed status and no actions', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'pass' }),
      profile,
      projectId: 'p1',
      workingDir: 'C:/work',
      collapsed: false,
    },
  })
  await expect(component.locator('.review-status')).toHaveText('✓ review passed')
  await expect(component.locator('.review-actions')).toHaveCount(0)
})

test('pass verdict without invariants shows the generic-review hint', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'pass', usedInvariants: false }),
      profile,
      projectId: 'p1',
      workingDir: 'C:/work',
      collapsed: false,
    },
  })
  await expect(component.locator('.review-hint')).toContainText('No project invariants configured')
})

test('skipped and error verdicts render their status text', async ({ mount }) => {
  const skipped = await mount(ReviewCard, {
    props: { data: review({ verdict: 'skipped' }), profile, projectId: 'p1', collapsed: false },
  })
  await expect(skipped.locator('.review-status')).toHaveText('– review skipped')

  const errored = await mount(ReviewCard, {
    props: { data: review({ verdict: 'error' }), profile, projectId: 'p1', collapsed: false },
  })
  await expect(errored.locator('.review-status')).toHaveText('⚠ review undetermined')
})

test('findings verdict lists findings and offers Fix + Accept', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'findings', findings: [finding({ severity: 'high' })] }),
      profile,
      projectId: 'p1',
      workingDir: 'C:/work',
      collapsed: false,
    },
    hooksConfig: { sessionState: { reviewAccepted: false, running: false, pragma: { review: review({ verdict: 'findings', round: 0 }) } } },
  })
  await expect(component.locator('.review-status')).toContainText('1 finding(s)')
  await expect(component.locator('.finding').first()).toHaveClass(/high/)
  await expect(component.locator('.rv-fix')).toBeVisible()
  await expect(component.locator('.rv-accept')).toBeVisible()
})

test('clicking a finding expands its detail', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'findings', findings: [finding()] }),
      profile,
      projectId: 'p1',
      workingDir: 'C:/work',
      collapsed: false,
    },
  })
  await expect(component.locator('.finding-detail')).toHaveCount(0)
  await component.locator('.finding-head').click()
  await expect(component.locator('.finding-detail')).toHaveText('Explanation of the issue.')
})

test('Fix is disabled without a working directory', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'findings', findings: [finding()] }),
      profile,
      projectId: 'p1',
      workingDir: undefined,
      collapsed: false,
    },
  })
  await expect(component.locator('.rv-fix')).toBeDisabled()
})

test('clicking Fix calls the store action with the profile and working dir', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'findings', findings: [finding()] }),
      profile,
      projectId: 'proj-42',
      workingDir: 'C:/work/target',
      collapsed: false,
    },
  })
  await component.locator('.rv-fix').click()
  const calls = await component.evaluate(() => (window as any).__sessionStore().fixReviewFindings.calls)
  expect(calls).toEqual([['claude', 'proj-42', undefined, 'C:/work/target']])
})

test('clicking Accept calls the store action', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'findings', findings: [finding()] }),
      profile,
      projectId: 'p1',
      workingDir: 'C:/work',
      collapsed: false,
    },
  })
  await component.locator('.rv-accept').click()
  const calls = await component.evaluate(() => (window as any).__sessionStore().acceptReviewFindings.calls)
  expect(calls).toEqual([[]])
})

test('clicking Accept shows the accepted note and hides the actions', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'findings', findings: [finding()] }),
      profile,
      projectId: 'p1',
      workingDir: 'C:/work',
      collapsed: false,
    },
    hooksConfig: { sessionState: { reviewAccepted: true } },
  })
  await expect(component.locator('.review-accepted')).toContainText('Findings accepted')
  await expect(component.locator('.review-actions')).toHaveCount(0)
})

test('actions are hidden while a fix turn is running', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'findings', findings: [finding()] }),
      profile,
      projectId: 'p1',
      workingDir: 'C:/work',
      collapsed: false,
    },
    hooksConfig: { sessionState: { running: true } },
  })
  await expect(component.locator('.review-actions')).toHaveCount(0)
})

test('round pill appears after the first Fix→Review round', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'findings', findings: [finding()], round: 1 }),
      profile,
      projectId: 'p1',
      workingDir: 'C:/work',
      collapsed: false,
    },
  })
  await expect(component.locator('.round-pill')).toHaveText('r2')
})

test('Fix limit reached at round 2 disables Fix and shows the limit note', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'findings', findings: [finding()], round: 2 }),
      profile,
      projectId: 'p1',
      workingDir: 'C:/work',
      collapsed: false,
    },
    hooksConfig: { sessionState: { pragma: { review: review({ verdict: 'findings', round: 2 }) } } },
  })
  await expect(component.locator('.rv-fix')).toHaveCount(0)
  await expect(component.locator('.rv-limit')).toContainText('Fix limit reached')
  await expect(component.locator('.rv-accept')).toBeVisible()
})

test('diff-truncated warning is shown when the diff was cut', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'pass', diffTruncated: true }),
      profile,
      projectId: 'p1',
      collapsed: false,
    },
  })
  await expect(component.locator('.review-warn')).toContainText('Diff truncated')
})

test('deep-review banner appears for a large diff and is dismissible', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'pass', filesChanged: 14, linesChanged: 520, deepReviewSuggested: true }),
      profile,
      projectId: 'p1',
      collapsed: false,
    },
  })
  const banner = component.locator('[data-testid="deep-review-banner"]')
  await expect(banner).toContainText('14 file(s), 520 line(s)')
  await expect(banner).toContainText('/code-review ultra')
  await banner.locator('.model-btn-dismiss').click()
  await expect(banner).toHaveCount(0)
})

test('deep-review banner is absent for a small diff', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'pass', deepReviewSuggested: false }),
      profile,
      projectId: 'p1',
      collapsed: false,
    },
  })
  await expect(component.locator('[data-testid="deep-review-banner"]')).toHaveCount(0)
})

test('security pass declares the sensitive files it covered', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({
        verdict: 'pass',
        securityPass: true,
        sensitiveFiles: ['src/auth/login.rs', 'db/migrations/003.sql'],
      }),
      profile,
      projectId: 'p1',
      collapsed: false,
    },
  })
  await expect(component.locator('[data-testid="review-security-pill"]')).toHaveText('SEC')
  const note = component.locator('[data-testid="review-security-note"]')
  await expect(note).toContainText('2 sensitive file(s)')
  await expect(note).toContainText('src/auth/login.rs')
  await expect(note).toContainText('db/migrations/003.sql')
  // The dedicated pass stays a user action: Pragma cannot launch it.
  await expect(note).toContainText('/security-review')
})

test('security pass on default patterns suggests declaring sensitive paths', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({
        verdict: 'pass',
        securityPass: true,
        sensitiveFiles: ['src/auth/login.rs'],
        sensitiveFromDefaults: true,
      }),
      profile,
      projectId: 'p1',
      collapsed: false,
    },
  })
  await expect(component.locator('[data-testid="review-security-defaults-hint"]'))
    .toContainText("Pragma's default patterns")
})

test('a diff with no sensitive file shows neither pill nor security note', async ({ mount }) => {
  const component = await mount(ReviewCard, {
    props: {
      data: review({ verdict: 'pass', securityPass: false }),
      profile,
      projectId: 'p1',
      collapsed: false,
    },
  })
  await expect(component.locator('[data-testid="review-security-pill"]')).toHaveCount(0)
  await expect(component.locator('[data-testid="review-security-note"]')).toHaveCount(0)
})
