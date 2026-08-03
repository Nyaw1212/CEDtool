const QuoteParserEngine = (() => {
  function getMetadata() {
    return {
      id: 'parser',
      name: 'Greentech Quote Parser',
      version: '0.4.1',
      actions: ['parseInvoice']
    };
  }

  function parseInvoice(payload) {
    const result = ParserEngine.parseInvoice(payload);
    const catalog = PriceEngine.list().items || [];

    const items = (result.items || []).map(item => {
      const parsedSku = extractParsedSku_(item);
      const match = findCatalogMatch_(parsedSku, item.invoiceDescription, catalog);

      return {
        ...item,
        parsedSku,
        sku: parsedSku,
        spaSku: match ? match.sku : '',
        catalogMatch: Boolean(match),
        catalogPrice: match ? match.price : null,
        catalogExtPrice: match && match.extPrice != null ? match.extPrice : null,
        matchSource: match ? match.source : 'NO_MATCH',
        matchScore: match ? match.score : 0
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

  function extractParsedSku_(item) {
    const lines = String(item.sourceText || '')
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    const first = lines[0] || '';

    // Quote page 1: 12 IRIDG XR-10-168M-US
    const numbered = first.match(/^\d{1,3}\s+([A-Z][A-Z0-9&.-]{1,12})\s+(.+)$/i);
    if (numbered) {
      const vendor = numbered[1].toUpperCase();
      const remainder = numbered[2].trim();

      // Q.TRON module names are legitimate multi-token product codes.
      if (vendor === 'QCELL' && /^Q\.TRON\b/i.test(remainder)) {
        return normalizeSku_(remainder);
      }

      return normalizeSku_(remainder.split(/\s+/)[0]);
    }

    // Invoice style: T 30 ENP IQ8HC-72-M-DOM-US ...
    const invoice = first.match(/^T\s+\d+(?:\.\d+)?\s+[A-Z0-9&.-]+\s+(\S+)/i);
    if (invoice) return normalizeSku_(invoice[1]);

    // Page 2: vendor and SKU can be on their own line(s).
    const standalone = first.match(/^[A-Z][A-Z0-9&.-]{1,12}\s+(.+)$/i);
    if (standalone) {
      const pieces = [standalone[1]];
      for (let i = 1; i < Math.min(lines.length, 3); i += 1) {
        if (!/^[A-Z0-9.+/_-]+$/i.test(lines[i])) break;
        pieces.push(lines[i]);
      }
      return normalizeSku_(pieces.join(''));
    }

    return normalizeSku_(item.parsedSku || item.sku);
  }

  function findCatalogMatch_(parsedSku, description, catalog) {
    const compactParsed = compact_(parsedSku);
    const normalizedDescription = normalizeText_(description);
    let best = null;

    catalog.forEach(catalogItem => {
      const compactCatalog = compact_(catalogItem.sku);
      const catalogDescription = normalizeText_(catalogItem.description);
      let score = 0;
      let source = 'NO_MATCH';

      if (compactParsed && compactParsed === compactCatalog) {
        score = 1;
        source = 'EXACT_SKU';
      } else if (compactParsed.length >= 6 && compactCatalog.includes(compactParsed)) {
        score = 0.94;
        source = 'PARTIAL_SKU';
      } else {
        const descriptionScore = tokenScore_(normalizedDescription, catalogDescription);
        if (descriptionScore >= 0.72) {
          score = descriptionScore;
          source = 'DESCRIPTION_MATCH';
        }
      }

      if (!best || score > best.score) {
        best = { ...catalogItem, score, source };
      }
    });

    return best && best.score >= 0.72 ? best : null;
  }

  function tokenScore_(leftText, rightText) {
    const left = new Set(String(leftText || '').split(/\s+/).filter(token => token.length > 1));
    const right = new Set(String(rightText || '').split(/\s+/).filter(token => token.length > 1));
    if (!left.size || !right.size) return 0;

    let intersection = 0;
    left.forEach(token => {
      if (right.has(token)) intersection += 1;
    });

    return intersection / Math.max(left.size, right.size);
  }

  function normalizeSku_(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/\s+/g, ' ')
      .toUpperCase();
  }

  function compact_(value) {
    return String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  function normalizeText_(value) {
    return String(value == null ? '' : value)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return { getMetadata, parseInvoice };
})();
