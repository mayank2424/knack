<template>
  <div class="modal-backdrop">
    <div
      class="modal p-[24px] rounded-[12px]"
      :class="{ 'shadow-[0_10px_30px_rgba(0,0,0,0.2)]': elevated }"
      style="margin: 32px; color: #374151"
    >
      <!-- <div style="color: #ff0000"> commented-out markup is ignored -->
      <h2>{{ title }}</h2>
      <slot />
    </div>
  </div>
</template>

<script setup>
defineProps({ title: String, elevated: Boolean });
</script>

<style scoped>
.modal-backdrop {
  background: rgba(17, 24, 39, 0.5);
  z-index: 50;
}
.modal {
  max-width: 560px;
  background: rgb(255, 255, 255);
  border: 1px solid #e8e2d7;
  transition: opacity 250ms ease-out;
}
.modal h2 {
  font-size: 1.25rem;
  color: oklch(0.55 0.22 263);
}
</style>
