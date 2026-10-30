import { onMounted, onUnmounted } from 'vue'

// Global shortcuts of the app. Registered on `window` and removed on unmount:
// in dev, HMR remounts App.vue constantly, and without cleanup the handlers pile up.
export function useGlobalKeys(actions: { openComposer: () => void; openSettings: () => void }) {
  function handleKey(e: KeyboardEvent) {
    if (e.ctrlKey && e.key === 'k') { e.preventDefault(); actions.openComposer() }
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); actions.openSettings() }
  }

  onMounted(() => window.addEventListener('keydown', handleKey))
  onUnmounted(() => window.removeEventListener('keydown', handleKey))
}
