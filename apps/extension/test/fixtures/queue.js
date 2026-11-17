// Shared by the queue fixtures. Every real submit is reported to the fixture server
// (/hit?form=NAME), so the tests can count exactly which forms were submitted.
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = form.dataset.name;
    fetch(`/hit?form=${encodeURIComponent(name)}`, { method: 'POST', keepalive: true }).finally(() => {
      if (form.dataset.after === 'thanks') location.href = `queue-thanks.html?form=${encodeURIComponent(name)}`;
    });
  });
});
