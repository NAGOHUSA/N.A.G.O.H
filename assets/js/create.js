(function () {
  const workerBase = window.APP_CODE_MARKET_WORKER_BASE || '';
  const checkoutBtn = document.getElementById('startCheckout');
  const form = document.getElementById('createForm');
  const statusEl = document.getElementById('createStatus');

  function setStatus(message, isError) {
    statusEl.classList.remove('hidden');
    statusEl.textContent = message;
    if (isError) {
      statusEl.classList.add('error');
    } else {
      statusEl.classList.remove('error');
    }
  }

  checkoutBtn?.addEventListener('click', async () => {
    try {
      setStatus('Creating Stripe Checkout session...', false);
      const response = await fetch(`${workerBase}/api/create-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ successUrl: `${location.origin}/create-listing.html`, cancelUrl: `${location.origin}/create-listing.html?canceled=1` }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Checkout creation failed.');
      location.href = result.url;
    } catch (error) {
      setStatus(`Checkout error: ${error.message}`, true);
    }
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const urlParams = new URLSearchParams(location.search);
    const sessionId = urlParams.get('session_id');
    if (!sessionId) {
      setStatus('Missing session_id from Stripe redirect. Complete payment first.', true);
      return;
    }

    const payload = Object.fromEntries(new FormData(form).entries());
    payload.sessionId = sessionId;

    try {
      setStatus('Creating listing...', false);
      const response = await fetch(`${workerBase}/api/listings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to create listing.');
      setStatus(`Listing created.\nID: ${result.id}\nEdit link: ${result.editUrl}`, false);
      form.reset();
    } catch (error) {
      setStatus(`Create error: ${error.message}`, true);
    }
  });
})();
