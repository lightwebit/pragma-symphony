import { spawnSync } from 'node:child_process'
import { renameSync, rmSync } from 'node:fs'
import path from 'node:path'

export const OUT = process.env.PRAGMA_SHOTS_OUT

/** Forces the theme without going through the toggle button (which a modal may cover). */
export async function setTheme(theme) {
  await browser.execute((t) => {
    document.documentElement.setAttribute('data-theme', t)
    try { localStorage.setItem('pragma-theme', t) } catch {}
  }, theme)
  await browser.pause(250)
}

/** Saves `<name>-dark.png` and `<name>-light.png` of whatever is on screen now. */
export async function shot(name) {
  for (const theme of ['dark', 'light']) {
    await setTheme(theme)
    const file = path.join(OUT, `${name}-${theme}.png`)
    await browser.saveScreenshot(file)
    downscale(file)
  }
  await setTheme('dark')
}

export async function openSession(title) {
  const items = await $$('[data-testid="session-item"]')
  for (const it of items) {
    if ((await it.getText()).includes(title)) {
      await it.click()
      await browser.pause(700)
      return
    }
  }
  throw new Error(`session "${title}" not in the list`)
}

export async function clickByText(selector, text) {
  const els = await $$(selector)
  for (const el of els) {
    if ((await el.getText()).trim() === text) {
      await el.click()
      return
    }
  }
  throw new Error(`no ${selector} with text "${text}"`)
}

/**
 * The webview renders at devicePixelRatio 2, which makes ~400 KB PNGs. Halve them to 1440 px
 * wide with ffmpeg when it is installed; otherwise the full-size capture stays.
 */
function downscale(file) {
  const tmp = file.replace(/\.png$/, '.small.png')
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vf', 'scale=1440:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=none', tmp])
  if (r.status === 0) renameSync(tmp, file)
  else rmSync(tmp, { force: true })
}

/** A 1440x800 CSS-pixel viewport, whatever the display scaling (the window rect is in device pixels). */
export async function sizeWindow() {
  const dpr = await browser.execute(() => devicePixelRatio)
  const { width, height } = await browser.getWindowRect()
  const cur = await browser.execute(() => ({ w: innerWidth, h: innerHeight }))
  const chromeW = width - cur.w * dpr
  const chromeH = height - cur.h * dpr
  await browser.setWindowRect(0, 0, Math.round(1440 * dpr + chromeW), Math.round(800 * dpr + chromeH))
  await browser.pause(800)
}

/** Opens exactly one card of the pragma panel (all others closed), by the start of its label. */
export async function onlyCard(label) {
  for (const btn of await $$('.pragma-panel .chevron-btn.open')) await btn.click()
  const labels = await $$('.pragma-panel .card-label')
  for (const l of labels) {
    if ((await l.getText()).trim().toUpperCase().startsWith(label)) {
      await l.click()
      await browser.pause(300)
      return
    }
  }
  throw new Error(`no panel card "${label}"`)
}

/** Opens every card of the pragma panel. */
export async function allCards() {
  for (const btn of await $$('.pragma-panel .chevron-btn:not(.open)')) await btn.click()
  await browser.pause(300)
}

/** Replies the fake `claude` will give, one per call, in order. */
export async function queueReplies(replies) {
  const { writeFileSync, readdirSync, unlinkSync } = await import('node:fs')
  const dir = process.env.PRAGMA_SHOTS_QUEUE
  for (const f of readdirSync(dir)) unlinkSync(path.join(dir, f))
  replies.forEach((text, i) => writeFileSync(path.join(dir, `${i + 1}.txt`), text))
}
