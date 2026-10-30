<script setup lang="ts">
defineProps<{
  visible: boolean
  // Without a working dir there is nowhere to copy the file: the overlay says so while
  // dragging, instead of just letting the drop fail.
  workingDir: string
}>()
</script>

<template>
  <Transition name="drag-overlay">
    <div v-if="visible" class="drag-overlay">
      <div class="drag-overlay-inner">
        <span class="drag-icon">📎</span>
        <span v-if="workingDir">Drop to attach</span>
        <span v-else class="drag-no-dir">Set a working directory before attaching files</span>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.drag-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(40, 44, 52, 0.82);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.drag-overlay-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 60px;
  border: 2px dashed var(--accent);
  border-radius: 16px;
  color: var(--text-primary);
  font-size: 1.1rem;
}
.drag-icon { font-size: 2.5rem; }
.drag-no-dir { color: #e06c75; font-size: 0.9rem; text-align: center; }
.drag-overlay-enter-active,
.drag-overlay-leave-active { transition: opacity 0.15s; }
.drag-overlay-enter-from,
.drag-overlay-leave-to { opacity: 0; }
</style>
