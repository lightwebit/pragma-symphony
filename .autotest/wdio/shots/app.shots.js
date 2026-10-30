/**
 * Screenshot script. Not a test: it drives the app through its views and saves each one,
 * dark and light, into docs/screenshots/. Run with `npm run screenshots`.
 *
 * Static views come from the seeded database; live phases (questions, plan awaiting approval,
 * the closing) are played by the fake `claude` binary, so nothing is spent.
 */
import { byTestId, waitForAppReady, selectProjectByTitle } from '../helpers.js'
import { startFakeRelay } from '../fakeRelay.js'
import { shot, openSession, clickByText, sizeWindow, onlyCard, allCards, queueReplies } from './helpers.js'

const closeModal = async (testid) => { await byTestId(testid).click(); await browser.pause(300) }

describe('screenshots: static views', () => {
  before(async () => {
    await waitForAppReady()
    await sizeWindow()
    await browser.pause(1500)
    await selectProjectByTitle('Atlas Shop')
    await browser.pause(500)
  })

  it('start and projects', async () => {
    await shot('01-start')
    await byTestId('project-selector').click()
    await browser.pause(400)
    await shot('02-projects')
    await byTestId('project-selector').click()
  })

  it('project settings', async () => {
    await byTestId('btn-edit-project').click()
    await byTestId('project-modal').waitForDisplayed()
    await shot('03-project-settings')
    await closeModal('project-cancel')
  })

  it('search', async () => {
    const search = await $('.search-input')
    await search.setValue('order')
    await browser.pause(900)
    await shot('04-search')
    await search.clearValue()
    await browser.pause(500)
  })

  it('todo', async () => {
    await byTestId('btn-todo').click()
    await byTestId('todo-overlay').waitForDisplayed()
    await shot('05-todo')
    await closeModal('todo-close')
  })

  it('composer', async () => {
    await byTestId('prompt-trigger').click()
    await byTestId('composer-modal').waitForDisplayed()
    await byTestId('composer-textarea').setValue('Add pagination to the orders list: 20 per page, with the total count in a response header.')
    await shot('06-composer')
    await byTestId('composer-advanced-toggle').click()
    await browser.pause(300)
    await shot('07-composer-advanced')
    await byTestId('composer-schedule-toggle').click()
    await browser.pause(300)
    await shot('08-composer-schedule')
    await byTestId('composer-textarea').setValue('')
    await closeModal('composer-close')
  })

  it('session: full cycle, one card at a time', async () => {
    await openSession('Bulk discount')
    await shot('10-session-full-cycle')
    for (const [label, name] of [
      ['ANALYSIS', 'analysis'], ['QUESTIONS', 'questions'], ['PLAN', 'plan'],
      ['REPORT', 'report'], ['TESTS', 'tests'], ['REVIEW', 'review'],
    ]) {
      await onlyCard(label)
      await shot(`11-card-${name}`)
    }
    await allCards()
    await shot('12-cards-all-open')
  })

  it('session: security review, error, raw note', async () => {
    await openSession('Order ownership')
    await allCards()
    await shot('13-session-security-review')
    await openSession('UUID keys')
    await shot('14-session-error')
    await openSession('Checkout on payment timeout')
    await shot('15-session-raw-note')
  })

  it('stream: raw mode and an open diff', async () => {
    await openSession('Order ownership')
    await clickByText('.action-btn', 'focus')
    await browser.pause(500)
    await shot('16-stream-raw')
    for (const row of await $$('.atom-row.clickable')) {
      if ((await row.getText()).includes('diff')) { await row.click(); break }
    }
    await browser.pause(400)
    await shot('17-stream-diff-open')
    await clickByText('.action-btn', 'raw')
  })

  it('live', async () => {
    await byTestId('btn-live').click()
    await byTestId('live-modal').waitForDisplayed()
    await shot('20-live-config')
    await byTestId('live-run').click()
    await byTestId('live-result').waitForDisplayed({ timeout: 20_000 })
    await shot('21-live-running')
    await closeModal('live-close')
  })

  it('pipeline', async () => {
    await byTestId('btn-pipeline').click()
    await byTestId('pipeline-modal').waitForDisplayed()
    await shot('22-pipeline-config')
    await byTestId('pipeline-run').click()
    await byTestId('pipeline-result').waitForDisplayed({ timeout: 30_000 })
    await browser.pause(800)
    await shot('23-pipeline-result')
    await closeModal('pipeline-close')
  })

  it('e2e', async () => {
    await byTestId('btn-e2e').click()
    await byTestId('e2e-modal').waitForDisplayed()
    for (const [i, tab] of ['Runner', 'Spec', 'Run'].entries()) {
      await clickByText('.e2e-tabs button', tab)
      await browser.pause(300)
      await shot(`2${4 + i}-e2e-${tab.toLowerCase()}`)
    }
    await closeModal('e2e-close')
  })

  it('settings, help', async () => {
    await byTestId('btn-settings').click()
    await byTestId('settings-panel').waitForDisplayed()
    await shot('30-settings-top')
    await browser.execute(() => {
      for (const el of document.querySelectorAll('.section-title')) {
        if (el.textContent.trim() === 'Web sharing') el.scrollIntoView({ block: 'start' })
      }
    })
    await browser.pause(300)
    await shot('31-settings-rest')
    await closeModal('settings-close')
    await byTestId('btn-help').click()
    await byTestId('help-panel').waitForDisplayed()
    await shot('32-help')
    await closeModal('help-close')
  })

  it('export', async () => {
    await openSession('Bulk discount')
    await clickByText('.action-btn', '↓ MD')
    await browser.pause(700)
    await shot('33-export')
  })
})

describe('screenshots: a live session (scripted fake claude)', () => {
  before(async () => {
    await waitForAppReady()
    await sizeWindow()
    await selectProjectByTitle('Atlas Shop')
    await browser.pause(500)
  })

  it('asks questions, shows the plan, runs to the end', async () => {
    await queueReplies([
      [
        'ANALYSIS:',
        'The orders list is served by `GET /orders` in `src/routes/orders.ts` and returns every row. Pagination needs a page size, a way to ask for a page, and the total somewhere the client can read it.',
        'QUESTIONS:',
        '1. How does the client ask for a page?',
        '   - `?page=2` (page number)',
        '   - `?cursor=...` (opaque cursor)',
        '2. Where does the total count go?',
        '   - `X-Total-Count` response header',
        '   - In the JSON body',
        'AWAITING_ANSWERS',
      ].join('\n'),
      [
        'ANALYSIS:',
        'Page-number pagination with the total in a response header. The query already sorts by `created_at`, so pages are stable.',
        'PLAN:',
        '1. Read `page` from the query string (default 1, size fixed at 20)',
        '2. Add `LIMIT/OFFSET` to the orders query and a `COUNT(*)` for the total',
        '3. Send the total in `X-Total-Count`',
        '4. Add tests for the first page, a middle page and a page past the end',
        'AWAITING_CONFIRMATION',
      ].join('\n'),
      [
        'STEP_COMPLETE: 1',
        '`page` is read from the query string, with 1 as default and a minimum of 1.',
        'STEP_COMPLETE: 2',
        'The query uses `LIMIT 20 OFFSET`, and the total comes from a separate `COUNT(*)`.',
        'STEP_COMPLETE: 3',
        '`X-Total-Count` is set on every response of the list.',
        'STEP_COMPLETE: 4',
        'Three tests added: first page, a middle page, a page past the end.',
        'REPORT:',
        'The orders list is paginated: 20 per page, `?page=N`, total in `X-Total-Count`. Changed `src/routes/orders.ts` and `src/routes/orders.test.ts`.',
        'TESTS:',
        '- First page returns 20 orders and the right total',
        '- A middle page returns the next 20',
        '- A page past the end returns an empty list with the total',
        'CLOSING:',
        'Pagination is in. Tell me if you want a page-size parameter next.',
        'AWAITING_CLOSE',
      ].join('\n'),
    ])
    await byTestId('btn-new-session').click()
    await browser.pause(500)
    await byTestId('session-title-input').setValue('Pagination on the orders list')
    await byTestId('prompt-trigger').click()
    await byTestId('composer-modal').waitForDisplayed()
    await byTestId('composer-textarea').setValue('Add pagination to the orders list: 20 per page, with the total count in a response header.')
    // Confirm the plan by hand, so the awaiting-approval state can be shown.
    await byTestId('composer-advanced-toggle').click()
    const auto = byTestId('composer-auto-confirm')
    if (await auto.isSelected()) await auto.click()
    await byTestId('composer-submit').click()

    await byTestId('question-item').waitForDisplayed({ timeout: 60_000 })
    await browser.pause(1500)
    await shot('40-live-questions')

    // Answer in the composer.
    if (!(await byTestId('composer-modal').isDisplayed())) await byTestId('prompt-trigger').click()
    await byTestId('composer-modal').waitForDisplayed()
    await byTestId('composer-option-0-0').click()
    await byTestId('composer-option-1-0').click()
    await shot('41-live-answering')
    await byTestId('composer-submit').click()

    await byTestId('pragma-continue').waitForDisplayed({ timeout: 60_000 })
    await browser.pause(800)
    await shot('42-live-plan-awaiting-approval')
  })
})

async function clickByTextWhenThere(selector, text) {
  try {
    await browser.waitUntil(async () => {
      for (const el of await $$(selector)) if ((await el.getText()).trim() === text) return true
      return false
    }, { timeout: 60_000, timeoutMsg: `${selector} "${text}" never appeared` })
  } catch (e) {
    await browser.saveScreenshot(process.env.PRAGMA_SHOTS_OUT + '/_debug.png')
    throw e
  }
  await browser.pause(800)
}

describe('screenshots: web sharing, desktop side', () => {
  let relay
  after(async () => {
    if (await byTestId('btn-share-stop').isExisting()) await byTestId('btn-share-stop').click()
    relay?.close()
  })

  it('privacy notice, key and PIN, then sharing', async () => {
    relay = await startFakeRelay({ secret: 'demo-secret-demo-secret' })
    await byTestId('btn-settings').click()
    await byTestId('settings-panel').waitForDisplayed()
    await byTestId('remote-enabled').click()
    await browser.execute(() => document.querySelector('[data-testid="remote-enabled"]').scrollIntoView({ block: 'center' }))
    await browser.pause(400)
    await shot('50-share-privacy-notice')
    await byTestId('remote-secret').setValue('demo-secret-demo-secret')
    await byTestId('remote-commands').click()
    await byTestId('remote-pin').setValue('2468')
    await browser.execute(() => document.querySelector('[data-testid="remote-pin"]').scrollIntoView({ block: 'center' }))
    await browser.pause(400)
    await shot('51-share-key-and-pin')
    await byTestId('remote-hub-url').setValue(relay.hubUrl)
    await byTestId('settings-save').click()
    await byTestId('settings-panel').waitForExist({ reverse: true })
    await byTestId('btn-share').click()
    await byTestId('btn-share-stop').waitForDisplayed({ timeout: 15_000 })
    await browser.pause(800)
    await shot('52-share-active')
  })
})
