import { ref, computed, watch } from 'vue'
import { invoke, IS_WEB } from '../platform'
import { useSessionStore } from '../stores/session'
import { useSettingsStore } from '../stores/settings'

export function useAttachments(showError: (msg: string) => void) {
  const session = useSessionStore()
  const settings = useSettingsStore()

  const workingDir = ref('')
  let restoringWorkingDir = false
  const attachmentExists = ref<Record<string, boolean>>({})

  const attachments = computed({
    get: () => session.sessionAttachments,
    set: (v) => { session.sessionAttachments = v },
  })

  watch(workingDir, async val => {
    if (restoringWorkingDir) return
    // The "last used" folder is a PC setting: it is never written from the web.
    if (IS_WEB) return
    settings.settings.lastWorkingDir = val || null
    await settings.save()
  })

  watch(() => session.sessionWorkingDir, val => {
    if (val) {
      restoringWorkingDir = true
      workingDir.value = val
      restoringWorkingDir = false
    }
  })

  async function refreshAttachmentExists() {
    const dir = workingDir.value
    if (!dir) { attachmentExists.value = {}; return }
    const result: Record<string, boolean> = {}
    for (const name of session.sessionAttachments) {
      result[name] = await invoke<boolean>('file_exists', { path: `${dir}/.pragmadocs/${name}` })
    }
    attachmentExists.value = result
  }

  watch(
    [() => session.sessionAttachments, workingDir],
    async () => { await refreshAttachmentExists() },
    { deep: true },
  )

  async function pickWorkingDir() {
    const dir = await invoke<string | null>('pick_directory')
    if (dir) workingDir.value = dir
  }

  async function attachFile() {
    if (!workingDir.value) {
      showError('No working directory set — select one to attach files')
      const dir = await invoke<string | null>('pick_directory')
      if (!dir) return
      workingDir.value = dir
    }
    const src = await invoke<string | null>('pick_file')
    if (!src) return
    const filename = await invoke<string>('copy_to_pragmadocs', { src, workingDir: workingDir.value })
    if (!attachments.value.includes(filename)) attachments.value.push(filename)
  }

  function removeAttachment(filename: string) {
    attachments.value = attachments.value.filter(f => f !== filename)
  }

  async function handleDroppedPaths(paths: string[]) {
    if (!workingDir.value || !paths.length) return
    for (const src of paths) {
      try {
        const filename = await invoke<string>('copy_to_pragmadocs', { src, workingDir: workingDir.value })
        if (!attachments.value.includes(filename)) attachments.value.push(filename)
      } catch { /* ignore non-file drops */ }
    }
  }

  return {
    workingDir,
    attachments,
    attachmentExists,
    pickWorkingDir,
    attachFile,
    removeAttachment,
    handleDroppedPaths,
  }
}
