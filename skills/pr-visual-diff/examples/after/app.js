// Dynamic content that changes on every load: a live clock. Demonstrates why
// capture.mjs offers --freeze-time and --mask.
document.querySelectorAll('.timestamp').forEach((el) => {
  el.textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour12: false });
});
