(function () {
  const workerBase = window.APP_CODE_MARKET_WORKER_BASE || '';
  const form = document.getElementById('editForm');
  const statusEl = document.getElementById('editStatus');
  const deleteBtn = document.getElementById('deleteBtn');
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const secret = params.get('secret');

  function setStatus(message, isError) {
    statusEl.classList.remove('hidden');
    statusEl.textContent = message;
    if (isError) {
      statusEl.classList.add('error');
    } else {
      statusEl.classList.remove('error');
    }
  }

  async function loadListing() {
    if (!id || !secret) {
      setStatus('Missing id or secret in query params.', true);
      return;
    }
    try {
      const response = await fetch(`${workerBase}/api/listings/${encodeURIComponent(id)}?secret=${encodeURIComponent(secret)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load listing.');
      Object.entries(data.listing).forEach(([key, value]) => {
        const field = form.elements.namedItem(key);
        if (field) field.value = value ?? '';
      });
      setStatus('Listing loaded. You can now edit or delete it.', false);
    } catch (error) {
      setStatus(`Load error: ${error.message}`, true);
    }
  }

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      payload.secret = secret;
      const response = await fetch(`${workerBase}/api/listings/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Update failed.');
      setStatus('Listing updated successfully.', false);
    } catch (error) {
      setStatus(`Update error: ${error.message}`, true);
    }
  });

  deleteBtn?.addEventListener('click', async () => {
    if (!confirm('Delete this listing permanently?')) return;
    try {
      const response = await fetch(`${workerBase}/api/listings/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Delete failed.');
      setStatus('Listing deleted.', false);
      form.reset();
    } catch (error) {
      setStatus(`Delete error: ${error.message}`, true);
    }
  });

  loadListing();
})();
