// External same-origin code keeps reconnect usable under the strict CSP.
document.getElementById("offline-retry")?.addEventListener("click", () => {
  window.location.reload();
});
