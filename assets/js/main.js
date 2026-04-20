(function () {
  const config = window.APP_CODE_MARKET_CONFIG || {
    githubOwner: 'NAGOHUSA',
    githubRepo: 'N.A.G.O.H',
    listingsPath: '_data/listings',
  };

  const baseApi = `https://api.github.com/repos/${config.githubOwner}/${config.githubRepo}/contents/${config.listingsPath}`;

  async function fetchListingFiles() {
    const response = await fetch(baseApi, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error('Failed to load listings index from GitHub API.');
    const contents = await response.json();
    const jsonFiles = contents.filter((item) => item.type === 'file' && item.name.endsWith('.json'));
    const listingPromises = jsonFiles.map((item) => fetch(item.download_url).then((r) => r.json()));
    const listings = await Promise.all(listingPromises);
    return listings.filter((l) => !l.expiresAt || new Date(l.expiresAt) > new Date());
  }

  function cardHtml(listing) {
    const icon = listing.iconUrl || 'assets/icons/placeholder.png';
    return `
      <article class="listing-card">
        <img class="listing-card-img" alt="${listing.title} icon" src="${icon}" loading="lazy" />
        <div class="listing-card-body">
          <div class="listing-card-title">${listing.title}</div>
          <p class="listing-card-desc">${listing.description}</p>
          <div class="listing-card-footer">
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <span class="badge">${listing.platform}</span>
              <span class="badge amber">$${listing.priceUsd}</span>
            </div>
            <a class="btn" href="listing.html?id=${encodeURIComponent(listing.id)}">View →</a>
          </div>
        </div>
      </article>
    `;
  }

  function detailHtml(listing) {
    const icon = listing.iconUrl || 'assets/icons/placeholder.png';
    // Also set the page title
    const titleEl = document.getElementById('listingTitle');
    if (titleEl) titleEl.textContent = listing.title;
    return `
      <div class="listing-detail">
        <div>
          <img class="listing-detail-img" alt="${listing.title} icon" src="${icon}" />
          <h2 style="margin-top:1.5rem;margin-bottom:0.75rem">${listing.title}</h2>
          <p style="color:var(--muted);font-size:0.88rem;line-height:1.7;margin-bottom:1.5rem">${listing.description}</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:2rem">
            <span class="badge">${listing.platform}</span>
            ${listing.techStack ? listing.techStack.split(',').map(t => `<span class="badge blue">${t.trim()}</span>`).join('') : ''}
          </div>
          <div style="font-size:0.78rem;color:var(--muted);line-height:1.6">
            <p>N.A.G.O.H does not process transactions. All purchases are made directly with the seller via their payment link.</p>
          </div>
        </div>
        <div class="listing-sidebar">
          <div class="card">
            <div class="listing-price">$${listing.priceUsd}</div>
            <p style="font-size:0.72rem;color:var(--muted);margin-top:4px;margin-bottom:1.25rem">One-time purchase price</p>
            <a class="btn btn-solid" style="width:100%;justify-content:center" target="_blank" rel="noopener noreferrer" href="${listing.sellerPaymentLink}">Buy from Seller →</a>
          </div>
          <div class="card">
            <div style="font-size:0.65rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:0.75rem">Listing Details</div>
            <div class="listing-meta-row">
              <span class="listing-meta-label">Platform</span>
              <span class="listing-meta-val">${listing.platform}</span>
            </div>
            <div class="listing-meta-row">
              <span class="listing-meta-label">Tech Stack</span>
              <span class="listing-meta-val">${listing.techStack || 'Not specified'}</span>
            </div>
            <div class="listing-meta-row">
              <span class="listing-meta-label">Repository</span>
              <a class="listing-meta-val" target="_blank" rel="noopener noreferrer" href="${listing.repoUrl}" style="font-size:0.78rem;word-break:break-all">View on GitHub →</a>
            </div>
            <div class="listing-meta-row">
              <span class="listing-meta-label">Contact</span>
              <a class="listing-meta-val" href="mailto:${listing.contactEmail}" style="font-size:0.78rem">${listing.contactEmail}</a>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  async function renderIndex() {
    const grid = document.getElementById('listings');
    if (!grid) return;
    const emptyState = document.getElementById('emptyState');
    try {
      const listings = await fetchListingFiles();
      if (!listings.length) {
        emptyState?.classList.remove('hidden');
        return;
      }
      listings.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      grid.innerHTML = listings.map(cardHtml).join('');
    } catch (error) {
      grid.innerHTML = `<p class="card">Error loading listings: ${error.message}</p>`;
    }
  }

  async function renderDetail() {
    const detail = document.getElementById('listingDetail');
    if (!detail) return;
    const id = new URLSearchParams(location.search).get('id');
    if (!id) {
      detail.innerHTML = '<p>Missing listing ID.</p>';
      return;
    }

    try {
      const metaResponse = await fetch(`${baseApi}/${encodeURIComponent(id)}.json`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!metaResponse.ok) throw new Error('Listing not found.');
      const meta = await metaResponse.json();
      const listingResponse = await fetch(meta.download_url);
      if (!listingResponse.ok) throw new Error('Listing not found.');
      const listing = await listingResponse.json();
      detail.innerHTML = detailHtml(listing);
    } catch (error) {
      detail.innerHTML = `<p>Failed to load listing: ${error.message}</p>`;
    }
  }

  renderIndex();
  renderDetail();
})();
