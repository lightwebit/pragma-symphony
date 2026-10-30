<script setup lang="ts">
import { type ExpiredCache, formatTokens, formatIdle } from '../cacheExpiry'

defineProps<{ info: ExpiredCache }>()

const emit = defineEmits<{
  summary: []
  dismiss: []
}>()
</script>

<template>
  <div class="cache-banner" data-testid="cache-expired-banner">
    <span class="cache-text">
      ⚠ Cache expired ({{ formatIdle(info.idleMinutes) }} idle): continuing rewrites
      <strong>~{{ formatTokens(info.contextTokens) }} tokens</strong> of context,
      ~{{ info.rewriteVsRead }}× the cost of reading it from cache.
    </span>
    <button class="cache-use" data-testid="cache-expired-summary" @click="emit('summary')">
      New session with summary
    </button>
    <button class="cache-dismiss" title="Continue anyway" @click="emit('dismiss')">×</button>
  </div>
</template>

<style scoped>
.cache-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 16px;
  background: rgba(212, 168, 67, 0.12);
  border-top: 1px solid rgba(212, 168, 67, 0.4);
}
.cache-text {
  flex: 1;
  font-size: 0.78rem;
  color: var(--color-atom-data, #d4a843);
}
.cache-use {
  background: rgba(212, 168, 67, 0.18);
  border: 1px solid rgba(212, 168, 67, 0.45);
  border-radius: 4px;
  color: var(--color-atom-data, #d4a843);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 2px 8px;
  flex-shrink: 0;
}
.cache-use:hover { background: rgba(212, 168, 67, 0.32); }
.cache-dismiss {
  background: none;
  border: none;
  color: var(--color-atom-data, #d4a843);
  cursor: pointer;
  font-size: 0.9rem;
  padding: 0 4px;
  flex-shrink: 0;
  line-height: 1;
}
.cache-dismiss:hover { color: #fff; }
</style>
