<script setup lang="ts">
withDefaults(defineProps<{
  open: boolean
  title: string
  body: string
  okLabel?: string
  cancelLabel?: string
}>(), {
  okLabel: 'Continue',
  cancelLabel: 'Cancel',
})

const emit = defineEmits<{
  cancel: []
  confirm: []
}>()
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="confirm-overlay" data-testid="confirm-overlay" @click.self="emit('cancel')">
      <div class="confirm-modal">
        <div class="confirm-modal-title">{{ title }}</div>
        <div class="confirm-modal-body">{{ body }}</div>
        <div class="confirm-modal-actions">
          <button class="confirm-modal-cancel" data-testid="confirm-cancel" @click="emit('cancel')">{{ cancelLabel }}</button>
          <button class="confirm-modal-ok" data-testid="confirm-ok" @click="emit('confirm')">{{ okLabel }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  backdrop-filter: blur(2px);
}
.confirm-modal {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 28px 32px 24px;
  min-width: 280px;
  max-width: 360px;
  text-align: center;
  box-shadow: 0 8px 40px rgba(0,0,0,0.4);
}
.confirm-modal-title { font-size: 1rem; font-weight: 600; color: var(--text-primary); margin-bottom: 10px; }
.confirm-modal-body { font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 22px; line-height: 1.5; }
.confirm-modal-actions { display: flex; gap: 10px; justify-content: center; }
.confirm-modal-cancel {
  padding: 7px 20px;
  border-radius: 7px;
  border: 1px solid var(--border-color);
  background: none;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.85rem;
  cursor: pointer;
  transition: background 0.12s;
}
.confirm-modal-cancel:hover { background: var(--bg-secondary); }
.confirm-modal-ok {
  padding: 7px 20px;
  border-radius: 7px;
  border: none;
  background: var(--color-atom-code);
  color: #fff;
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.confirm-modal-ok:hover { background: #5aa0e8; }
</style>
