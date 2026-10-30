<script setup lang="ts">
defineProps<{ message: string }>()

const emit = defineEmits<{
  dismiss: []
  openSettings: []
}>()
</script>

<template>
  <div class="error-banner" data-testid="error-banner">
    <span class="error-text">
      <!-- A missing binary is the only error with a known cure: the shortcut is offered
           instead of leaving the user to find alone where the path is configured. -->
      <template v-if="message.includes('cannot start')">
        ⚠ Claude CLI not found — check the path in
        <button class="error-settings-link" @click="emit('openSettings')">⚙ Settings</button>
      </template>
      <template v-else>⚠ {{ message }}</template>
    </span>
    <button class="error-close" @click="emit('dismiss')">×</button>
  </div>
</template>

<style scoped>
.error-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 16px 4px;
  background: rgba(192, 57, 43, 0.15);
  border-top: 1px solid rgba(192, 57, 43, 0.4);
}
.error-text {
  flex: 1;
  font-size: 0.78rem;
  color: #e06c75;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
}
.error-close {
  background: none;
  border: none;
  color: #e06c75;
  cursor: pointer;
  font-size: 0.9rem;
  padding: 0 4px;
  flex-shrink: 0;
  line-height: 1;
}
.error-close:hover { color: #fff; }

.error-settings-link {
  background: none;
  border: none;
  color: #e06c75;
  cursor: pointer;
  font-size: inherit;
  font-family: inherit;
  padding: 0;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.error-settings-link:hover { color: #fff; }
</style>
