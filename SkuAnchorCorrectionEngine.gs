const SkuAnchorCorrectionEngine = (() => {
  const MAX_JOIN_LINES = 3;
  const MAX_LINE_DISTANCE = 6;

  function getMetadata() {
    const metadata = QuoteParserEngine.getMetadata();
    return {
      ...metadata,
      name: 'Greentech Quote Parser with SKU Anchor Correction',
      version: '0.7.7'
    };
  }

  function parseInvoice(payload) {
    const result = QuoteParserEngine.parseInvoice(payload);
    const text = String(payload && payload.text ? payload.text : '');
    const catalog = PriceEngine.list().items || [];
    const numberedAnchors = findNumberedSkuAnchors_(text, catalog);
    const generalAnchors = findCatalogSkuAnchors_(text, catalog);
    const usedAnchors = new Set();

    const items = (result.items || []).map((item, itemIndex) => {
      // Special condition for the normal numbered quote section. PDF text can
      // give the parser an incorrect source line, so bind rows to numbered
      // product headers by document order instead of nearest-line distance.
      // Example: row 2 must map to "02 QCELL SPCD-00001", not back to row 1.
      if (itemIndex < numberedAnchors.length) {
        const numberedAnchor = numberedAnchors[itemIndex];
        usedAnchors.add(numberedAnchor.key);
        return applyAnchor_(item, numberedAnchor, 'NUMBERED_HEADER_ORDER');
      }

      // Keep the existing dirty/stacked-page behavior for items after the
      // numbered section, including split SKUs and missing extension prices.
      const anchor = findNearestAnchor_(item, generalAnchors, usedAnchors);
      if (!anchor) return item;

      usedAnchors.add(anchor.key);
      return applyAnchor_(item, anchor, 'NEARBY_SPA_SKU_ANCHOR');
    });

    return {
      ...result,
      count: items.length,
      matchedCount: items.filter(item => item.catalogMatch).length,
      newSkuCount: items.filter(item => !item.catalogMatch).length,
      items
    };
  }

  function findNumberedSkuAnchors_(text, catalog) {
    const lines = String(text)
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const preparedCatalog = catalog
      .map(item => ({ ...item, compactSku: compact_(item.sku) }))
      .filter(item => item.compactSku.length >= 5)
      .sort((a, b) => b.compactSku.length - a.compactSku.length);

    const anchors = [];

    lines.forEach((line, lineIndex) => {
      const match = line.match(/^(\d{1,3})\s+([A-Z][A-Z0-9&.-]{1,15})\s+(.+)$/i);
      if (!match) return;

      const productText = compact_(match[3]);
      const catalogItem = preparedCatalog.find(item =>
        productText.includes(item.compactSku) || item.compactSku.includes(productText)
      );

      if (!catalogItem) return;

      anchors.push({
        key: `NUMBERED:${lineIndex}:${catalogItem.compactSku}`,
        lineIndex,
        lineNumber: lineIndex + 1,
        lineCount: 1,
        catalogItem
      });
    });

    return anchors.sort((a, b) => a.lineIndex - b.lineIndex);
  }

  function findCatalogSkuAnchors_(text, catalog) {
    const lines = String(text)
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim());

    const preparedCatalog = catalog
      .map(item => ({ ...item, compactSku: compact_(item.sku) }))
      .filter(item => item.compactSku.length >= 5)
      .sort((a, b) => b.compactSku.length - a.compactSku.length);

    const anchors = [];
    const seen = new Set();

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      for (let lineCount = 1; lineCount <= MAX_JOIN_LINES; lineCount += 1) {
        const joined = lines.slice(lineIndex, lineIndex + lineCount).join(' ');
        const compactJoined = compact_(joined);
        if (!compactJoined) continue;

        for (const catalogItem of preparedCatalog) {
          if (!compactJoined.includes(catalogItem.compactSku)) continue;

          const key = `${lineIndex}:${catalogItem.compactSku}`;
          if (seen.has(key)) continue;
          seen.add(key);

          anchors.push({
            key,
            lineIndex,
            lineNumber: lineIndex + 1,
            lineCount,
            catalogItem
          });
        }
      }
    }

    return anchors.sort((a, b) => a.lineIndex - b.lineIndex);
  }

  function findNearestAnchor_(item, anchors, usedAnchors) {
    const currentSku = compact_(item.parsedSku || item.sku);
    const sourceLine = Math.max(1, Number(item.sourceLine || 1));

    const exact = anchors.find(anchor =>
      !usedAnchors.has(anchor.key) &&
      anchor.catalogItem &&
      compact_(anchor.catalogItem.sku) === currentSku &&
      Math.abs(anchor.lineNumber - sourceLine) <= MAX_LINE_DISTANCE
    );
    if (exact) return exact;

    const candidates = anchors
      .filter(anchor => !usedAnchors.has(anchor.key))
      .map(anchor => ({
        anchor,
        distance: Math.abs(anchor.lineNumber - sourceLine)
      }))
      .filter(candidate => candidate.distance <= MAX_LINE_DISTANCE)
      .sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        return a.anchor.lineIndex - b.anchor.lineIndex;
      });

    if (!candidates.length) return null;

    const candidate = candidates[0].anchor;
    if (item.catalogMatch && currentSku && compact_(item.spaSku) === currentSku) {
      return null;
    }

    return candidate;
  }

  function applyAnchor_(item, anchor, matchSource) {
    return {
      ...item,
      parsedSku: anchor.catalogItem.sku,
      sku: anchor.catalogItem.sku,
      spaSku: anchor.catalogItem.sku,
      catalogMatch: true,
      catalogPrice: anchor.catalogItem.price,
      catalogExtPrice: anchor.catalogItem.extPrice != null
        ? anchor.catalogItem.extPrice
        : null,
      matchSource,
      matchScore: 1
    };
  }

  function compact_(value) {
    return String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  return { getMetadata, parseInvoice };
})();
