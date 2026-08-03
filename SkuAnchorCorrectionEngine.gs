const SkuAnchorCorrectionEngine = (() => {
  const MAX_JOIN_LINES = 3;
  const MAX_LINE_DISTANCE = 6;

  function getMetadata() {
    const metadata = QuoteParserEngine.getMetadata();
    return {
      ...metadata,
      name: 'Greentech Parser with LIST and NOSPA Anchors',
      version: '0.8.0'
    };
  }

  function parseInvoice(payload) {
    const result = QuoteParserEngine.parseInvoice(payload);
    const text = String(payload && payload.text ? payload.text : '');
    const spaItems = PriceEngine.list().items || [];
    const noSpaItems = PriceEngine.listNoSpa().items || [];
    const anchorItems = prepareAnchorItems_(spaItems, noSpaItems);

    const numberedAnchors = findNumberedSkuAnchors_(text, anchorItems);
    const generalAnchors = findSkuAnchors_(text, anchorItems);
    const usedAnchors = new Set();

    const items = (result.items || []).map((item, itemIndex) => {
      if (itemIndex < numberedAnchors.length) {
        const anchor = numberedAnchors[itemIndex];
        usedAnchors.add(anchor.key);
        return applyAnchor_(item, anchor, 'NUMBERED_HEADER_ORDER');
      }

      const anchor = findNearestAnchor_(item, generalAnchors, usedAnchors);
      if (!anchor) return item;

      usedAnchors.add(anchor.key);
      return applyAnchor_(item, anchor, 'NEARBY_SKU_ANCHOR');
    });

    return {
      ...result,
      count: items.length,
      matchedCount: items.filter(item => item.catalogMatch).length,
      newSkuCount: items.filter(item => !item.catalogMatch).length,
      items
    };
  }

  function prepareAnchorItems_(spaItems, noSpaItems) {
    const combined = [];
    const seen = new Set();

    spaItems.forEach(item => {
      const compactSku = compact_(item.sku);
      if (!compactSku || seen.has(`SPA:${compactSku}`)) return;
      seen.add(`SPA:${compactSku}`);
      combined.push({
        sku: item.sku,
        compactSku,
        source: 'SPA',
        price: item.price,
        extPrice: item.extPrice,
        description: item.description || ''
      });
    });

    noSpaItems.forEach(item => {
      const compactSku = compact_(item.sku);
      if (!compactSku) return;
      if (spaItems.some(spa => compact_(spa.sku) === compactSku)) return;
      if (seen.has(`NOSPA:${compactSku}`)) return;
      seen.add(`NOSPA:${compactSku}`);
      combined.push({
        sku: item.sku,
        compactSku,
        source: 'NOSPA',
        price: null,
        extPrice: null,
        description: ''
      });
    });

    return combined.sort((a, b) => b.compactSku.length - a.compactSku.length);
  }

  function findNumberedSkuAnchors_(text, anchorItems) {
    const lines = normalizeLines_(text).filter(Boolean);
    const anchors = [];

    lines.forEach((line, lineIndex) => {
      const match = line.match(/^(\d{1,3})\s+([A-Z][A-Z0-9&.-]{1,15})\s+(.+)$/i);
      if (!match) return;

      const productText = compact_(match[3]);
      const anchorItem = anchorItems.find(item =>
        productText === item.compactSku ||
        productText.startsWith(item.compactSku) ||
        item.compactSku.startsWith(productText)
      );

      if (!anchorItem) return;

      anchors.push({
        key: `NUMBERED:${lineIndex}:${anchorItem.source}:${anchorItem.compactSku}`,
        lineIndex,
        lineNumber: lineIndex + 1,
        lineCount: 1,
        anchorItem
      });
    });

    return anchors.sort((a, b) => a.lineIndex - b.lineIndex);
  }

  function findSkuAnchors_(text, anchorItems) {
    const lines = normalizeLines_(text);
    const anchors = [];
    const seen = new Set();

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      for (let lineCount = 1; lineCount <= MAX_JOIN_LINES; lineCount += 1) {
        const compactJoined = compact_(lines.slice(lineIndex, lineIndex + lineCount).join(' '));
        if (!compactJoined) continue;

        for (const anchorItem of anchorItems) {
          if (!compactJoined.includes(anchorItem.compactSku)) continue;

          const key = `${lineIndex}:${anchorItem.source}:${anchorItem.compactSku}`;
          if (seen.has(key)) continue;
          seen.add(key);

          anchors.push({
            key,
            lineIndex,
            lineNumber: lineIndex + 1,
            lineCount,
            anchorItem
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
      anchor.anchorItem.compactSku === currentSku &&
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

    if (item.catalogMatch && currentSku && compact_(item.spaSku) === currentSku) {
      return null;
    }

    return candidates[0].anchor;
  }

  function applyAnchor_(item, anchor, matchSource) {
    const anchorItem = anchor.anchorItem;
    const isSpa = anchorItem.source === 'SPA';

    return {
      ...item,
      parsedSku: anchorItem.sku,
      sku: anchorItem.sku,
      spaSku: isSpa ? anchorItem.sku : '',
      catalogMatch: isSpa,
      catalogPrice: isSpa ? anchorItem.price : null,
      catalogExtPrice: isSpa && anchorItem.extPrice != null
        ? anchorItem.extPrice
        : null,
      noSpaMatch: !isSpa,
      skuSource: anchorItem.source,
      matchSource: isSpa ? matchSource : `${matchSource}_NOSPA`,
      matchScore: 1
    };
  }

  function normalizeLines_(text) {
    return String(text)
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim());
  }

  function compact_(value) {
    return String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  return { getMetadata, parseInvoice };
})();
