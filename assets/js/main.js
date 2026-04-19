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
      <article class="card listing-card">
        <img alt="${listing.title} icon" src="${icon}" loading="lazy" />
        <h3>${listing.title}</h3>
        <p class="muted">${listing.description}</p>
        <p><span class="badge">${listing.platform}</span> <span class="badge">$${listing.priceUsd}</span></p>
        <a class="btn" href="listing.html?id=${encodeURIComponent(listing.id)}">View details</a>
      </article>
    `;
  }

  function detailHtml(listing) {
    const icon = listing.iconUrl || 'assets/icons/placeholder.png';
    return `
      <h1>${listing.title}</h1>
      <img class="icon-lg" alt="${listing.title} icon" src="${icon}" />
      <p>${listing.description}</p>
      <p><strong>Platform:</strong> ${listing.platform}</p>
      <p><strong>Price:</strong> $${listing.priceUsd}</p>
      <p><strong>Tech stack:</strong> ${listing.techStack || 'Not specified'}</p>
      <p><strong>Source repository:</strong> <a target="_blank" rel="noopener noreferrer" href="${listing.repoUrl}">${listing.repoUrl}</a></p>
      <p><strong>Contact:</strong> <a href="mailto:${listing.contactEmail}">${listing.contactEmail}</a></p>
      <a class="btn" target="_blank" rel="noopener noreferrer" href="${listing.sellerPaymentLink}">Buy from seller</a>
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
