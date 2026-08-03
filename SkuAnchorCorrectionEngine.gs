const SkuAnchorCorrectionEngine = (() => {
  const MAX_JOIN_LINES = 3;
  const MAX_LINE_DISTANCE = 6;

  function getMetadata() {
    const metadata = QuoteParserEngine.getMetadata();
    return {
      ...metadata,
      name: 'Greentech Quote Parser with SKU Anchor Correction',
      version: '0.7.6'
    };
  }

  function parseInvoice(payload) {
    const result = QuoteParserEngine.parseInvoice(payload);
    const text = String(payload && payload.text ? payload.text : '');
    const catalog = PriceEngine.list().items || [];
    const anchors = findCatalogSkuAnchors_(text, catalog);
    const usedAnchors = new Set();

    const items = (result.items || []).map(item => {
      const anchor = findNearestAnchor_(item, anchors, usedAnchors);
      if (!anchor) return item;

      usedAnchors.add(anchor.key);

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
        matchSource: 'NEARBY_SPA_SKU_ANCHOR',
        matchScore: 1
      };
    });

    return {
      ...result,
      count: items.length,
      matchedCount: items.filter(item => item.catalogMatch).length,
      newSkuCount: items.filter(item => !item.catalogMatch).length,
      items
    };
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
        const joined = lines
          .slice(lineIndex, lineIndex + lineCount)
          .join(' ');
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

    // Keep a correct exact parsed SKU unchanged, but mark its anchor used so it
    // cannot be assigned to a later dirty item.
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

    // Only replace when the existing value is not already a credible catalog
    // SKU. This targets dirty values such as COMBINER 80 G1 or CABLE - LONG.
    if (item.catalogMatch && currentSku && compact_(item.spaSku) === currentSku) {
      return null;
    }

    return candidate;
  }

  function compact_(value) {
    return String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  return { getMetadata, parseInvoice };
})();
