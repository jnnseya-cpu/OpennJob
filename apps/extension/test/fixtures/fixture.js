// Shared by the fixtures: records what happens to the form so tests can assert on it.
window.__fixture = { submitCount: 0, submitClicks: 0, inputEvents: {}, changeEvents: {} };
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('form');
  const bump = (bag, el) => {
    const key = el.id || el.name;
    if (key) bag[key] = (bag[key] || 0) + 1;
  };
  form.addEventListener('input', (e) => bump(window.__fixture.inputEvents, e.target));
  form.addEventListener('change', (e) => bump(window.__fixture.changeEvents, e.target));
  form.querySelector('[type="submit"]').addEventListener('click', () => { window.__fixture.submitClicks += 1; });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    window.__fixture.submitCount += 1;
    document.getElementById('result').hidden = false;
  });
});
