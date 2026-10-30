import { ref } from 'vue'
import { TOAST_ERROR_DURATION_MS, TOAST_EXPORT_DURATION_MS } from '../PRAGMA_CONSTANTS'

// The app's two ephemeral notices. Each keeps its own timer: different durations
// and overlaps are possible — a shared timer would switch off the wrong toast.
export function useToasts() {
  const exportToast = ref<string | null>(null)
  const errorToast = ref<string | null>(null)

  let exportTimer: ReturnType<typeof setTimeout> | null = null
  let errorTimer: ReturnType<typeof setTimeout> | null = null

  function showExportToast(path: string) {
    if (exportTimer) clearTimeout(exportTimer)
    exportToast.value = path
    exportTimer = setTimeout(() => { exportToast.value = null }, TOAST_EXPORT_DURATION_MS)
  }

  function showErrorToast(msg: string) {
    if (errorTimer) clearTimeout(errorTimer)
    errorToast.value = msg
    errorTimer = setTimeout(() => { errorToast.value = null }, TOAST_ERROR_DURATION_MS)
  }

  return { exportToast, errorToast, showExportToast, showErrorToast }
}
