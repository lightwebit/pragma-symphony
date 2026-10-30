import { ref, onMounted, onUnmounted } from 'vue'
import { IS_WEB } from '../platform'
import { MOBILE_MAX_PX } from '../mobileTabs'

// true when the web page is on a narrow screen. On the desktop it is always false, even with the
// window narrowed: the tab layout belongs to the web version, the desktop does not change.
export function useMobileLayout() {
  const mobile = ref(false)
  if (!IS_WEB || typeof window === 'undefined' || !window.matchMedia) return { mobile }

  const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_PX}px)`)
  mobile.value = mq.matches
  const onChange = (e: MediaQueryListEvent) => { mobile.value = e.matches }
  onMounted(() => mq.addEventListener('change', onChange))
  onUnmounted(() => mq.removeEventListener('change', onChange))
  return { mobile }
}
