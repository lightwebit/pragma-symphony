<script setup lang="ts">
// Two stackable toasts: the error sits higher than the export one because when
// they appear together it is the one that must stay readable.
const exportToast = defineModel<string | null>('exportToast', { default: null })
const errorToast = defineModel<string | null>('errorToast', { default: null })
</script>

<template>
  <Transition name="export-toast">
    <div v-if="exportToast" class="export-toast">
      <span class="export-toast-label">saved to</span>
      <span class="export-toast-path">{{ exportToast }}</span>
      <button class="export-toast-close" @click="exportToast = null">×</button>
    </div>
  </Transition>

  <Transition name="export-toast">
    <div v-if="errorToast" class="export-toast error-toast">
      <span class="export-toast-label">⚠</span>
      <span class="export-toast-path">{{ errorToast }}</span>
      <button class="export-toast-close" @click="errorToast = null">×</button>
    </div>
  </Transition>
</template>

<style scoped>
.export-toast {
  position: fixed;
  bottom: 52px;
  right: 16px;
  z-index: 200;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 7px;
  padding: 8px 12px;
  box-shadow: 0 4px 18px rgba(0,0,0,0.35);
  max-width: 480px;
}
.export-toast-label { font-size: 0.7rem; color: var(--text-secondary); white-space: nowrap; flex-shrink: 0; }
.export-toast-path { font-size: 0.72rem; font-family: monospace; color: var(--color-atom-config); word-break: break-all; flex: 1; }
.export-toast-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  padding: 0 2px;
  flex-shrink: 0;
}
.export-toast-close:hover { color: var(--text-primary); }
.export-toast-enter-active,
.export-toast-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.export-toast-enter-from,
.export-toast-leave-to { opacity: 0; transform: translateY(8px); }

.error-toast {
  bottom: 96px;
  border-color: var(--error-color, #e05c5c);
  background: color-mix(in srgb, var(--error-color, #e05c5c) 12%, var(--bg-secondary));
}
</style>
