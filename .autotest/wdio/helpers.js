/** Shared helpers for the Tauri E2E specs. */

/** Element by `data-testid` — the only selector kind the specs should use. */
export function byTestId(id) {
  return $(`[data-testid="${id}"]`)
}

/**
 * The app is ready when the splash overlay is gone: it sits at z-index 9999 and
 * would swallow every click for its first ~300ms of life.
 */
export async function waitForAppReady(timeout = 30_000) {
  await browser.waitUntil(
    async () => !(await $('#pragma-splash').isExisting()),
    { timeout, timeoutMsg: 'Splash never went away — the frontend did not mount' },
  )
  await byTestId('app-layout').waitForDisplayed({ timeout: 5_000 })
}

/** Creates a project through the UI and leaves it as the current one. */
export async function createProject(title, { workingDir, testCommand, reviewInvariants } = {}) {
  const trigger = (await byTestId('btn-empty-new-project').isExisting())
    ? byTestId('btn-empty-new-project')
    : byTestId('btn-new-project')
  await trigger.click()

  await byTestId('project-modal').waitForDisplayed()
  await byTestId('project-title-input').setValue(title)
  if (workingDir) await byTestId('project-workdir-input').setValue(workingDir)
  if (testCommand) await byTestId('project-test-command-input').setValue(testCommand)
  if (reviewInvariants) await byTestId('project-review-invariants-input').setValue(reviewInvariants)
  await byTestId('project-save').click()

  await byTestId('project-modal').waitForExist({ reverse: true })
}

/** Opens the project dropdown and clicks the option matching `title` exactly. */
export async function selectProjectByTitle(title) {
  await byTestId('project-selector').click()
  const options = await $$('[data-testid="project-option"]')
  for (const opt of options) {
    const text = await opt.$('.project-option-name').getText()
    if (text === title) {
      await opt.click()
      return
    }
  }
  throw new Error(`Project option "${title}" not found in the dropdown`)
}
