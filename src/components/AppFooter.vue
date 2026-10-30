<script setup lang="ts">
import { invoke, IS_WEB } from '../platform'

defineProps<{ isDark: boolean }>()
const emit = defineEmits<{ toggleTheme: [] }>()

// Legal links go to the system browser, not the app's webview:
// opening them in here would mean navigating away from Pragma with no way back.
// On the web `open_url` does not exist (it would open the PC's browser): a new tab does the same thing.
function openUrl(url: string) {
  if (IS_WEB) { window.open(url, '_blank', 'noopener'); return }
  invoke('open_url', { url }).catch(console.error)
}
</script>

<template>
  <footer class="app-footer">
    <div class="footer-left">
      <span>© 2026</span>
      <span class="footer-sep">—</span>
      <a class="footer-link" @click.prevent="openUrl('https://noema.tools')">noema.tools</a>
    </div>
    <div class="footer-right">
      <a class="footer-link" @click.prevent="openUrl('https://noema.tools/pragma-symphony/terms')">Terms</a>
      <a class="footer-link" @click.prevent="openUrl('https://noema.tools/pragma-symphony/privacy')">Privacy</a>
      <button class="theme-btn" data-testid="btn-theme" :title="isDark ? 'Switch to light theme' : 'Switch to dark theme'" @click="emit('toggleTheme')">{{ isDark ? '☀' : '🌙' }}</button>
    </div>
  </footer>
</template>

<style scoped>
.app-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 16px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
  font-size: 0.68rem;
  color: var(--text-secondary);
  gap: 8px;
}

.footer-left,
.footer-right { display: flex; align-items: center; gap: 6px; }
.footer-sep { opacity: 0.4; }

.footer-link {
  color: var(--color-atom-code);
  text-decoration: none;
  cursor: pointer;
  transition: opacity 0.15s;
}
.footer-link:hover { opacity: 0.75; }

.theme-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.85rem;
  padding: 0 2px;
  line-height: 1;
  transition: opacity 0.15s;
  color: inherit;
}
.theme-btn:hover { opacity: 0.7; }

/* Web on a narrow screen: two centred rows instead of one that wraps at random. */
@media (max-width: 899px) {
  html.web .app-footer { flex-direction: column; gap: 2px; padding: 4px 10px; }
  html.web .footer-left { flex-wrap: wrap; justify-content: center; }
}
</style>
