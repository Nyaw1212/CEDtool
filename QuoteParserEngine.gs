const QuoteParserEngine = (() => {
  const STACKED_HEADER = /^([A-Z][A-Z0-9&.-]{1,15})\s+([A-Z0-9][A-Z0-9.+/_-]{2,})$/i;
  const STACKED_PRICE = /(?:^|\s)(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})\s+E(?:\s+\$?([\d,]+\.\d{2}))?(?=\s|$)/i;
  const FOOTER = /^(MERCHANDISE:|TAX:|TOTAL:|PLEASE NOTE:|TERMS AND CONDITIONS|\d+ OF \d+|\* PER )/i;

  function getMetadata() {
    return {
      id: 'parser',
      name: 'Greentech Quote Parser',
      version: '0.7.1',
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

    addMissingStackedMatches_(payload, items, catalog);
    items.sort((a, b) => Number(a.sourceLine || 0) - Number(b.sourceLine || 0));
    items.forEach((item, index) => { item.sourceOrder = index + 1; });

    return {
      ...result,
      count: items.length,
      matchedCount: items.filter(item => item.catalogMatch).length,
      newSkuCount: items.filter(item => !item.catalogMatch).length,
      items
    };
  }

  function addMissingStackedMatches_(payload, items, catalog) {
    const text = String(payload && payload.text ? payload.text : '');
    const lines = text
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const existing = new Set(items.map(item => compact_(item.parsedSku || item.sku)));

    for (let index = 0; index < lines.length; index += 1) {
      const header = lines[index].match(STACKED_HEADER);
      if (!header) continue;

      const vendor = normalizeSku_(header[1]);
      const parsedSku = normalizeSku_(header[2]);
      if (isExcludedVendor_(vendor) || !/[0-9]/.test(parsedSku)) continue;
      if (existing.has(compact_(parsedSku))) continue;

      const block = [lines[index]];
      for (let cursor = index + 1; cursor < Math.min(lines.length, index + 14); cursor += 1) {
        const line = lines[cursor];
        if (cursor > index + 1 && STACKED_HEADER.test(line)) break;
        block.push(line);
        if (FOOTER.test(line)) break;
      }

      const flat = block.slice(1).join(' ');
      const priceMatch = flat.match(STACKED_PRICE);
      if (!priceMatch) continue;

      const description = findFallbackDescription_(block.slice(1));
      const match = findCatalogMatch_(parsedSku, description, catalog);
      if (!match) continue;

      const quantity = Number(priceMatch[1]);
      const price = toNumber_(priceMatch[2]);
      const extPrice = priceMatch[3]
        ? toNumber_(priceMatch[3])
        : Number((quantity * price).toFixed(2));

      items.push({
        parsedSku,
        sku: parsedSku,
        vendor,
        spaSku: match.sku,
        description: description || match.description || '',
        invoiceDescription: description,
        quantityOrdered: quantity,
        quantityShipped: quantity,
        price,
        extPrice,
        catalogMatch: true,
        catalogPrice: match.price,
        catalogExtPrice: match.extPrice != null ? match.extPrice : null,
        matchSource: priceMatch[3] ? 'STACKED_FALLBACK' : 'STACKED_PARTIAL_PRICE_FALLBACK',
        matchScore: match.score,
        sourceLine: index + 1,
        sourceText: block.join('\n')
      });

      existing.add(compact_(parsedSku));
    }
  }

  function findFallbackDescription_(lines) {
    for (const line of lines) {
      if (!line || FOOTER.test(line)) continue;
      if (/^E$/i.test(line)) continue;
      if (/^\$?[\d,]+\.\d{2}$/.test(line)) continue;
      if (/^\d+(?:\.\d+)?$/.test(line)) continue;
      if (!/[A-Z]/i.test(line)) continue;
      return line;
    }
    return '';
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

  function isExcludedVendor_(value) {
    return /^(DOM|DOMESTIC|GROUNDING|T-BOLT|RD|HUG|MERCHANDISE|TAX|TOTAL|PLEASE|TERMS|GREENTECH|CUSTOMER|MAYER)$/i.test(value);
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

  function toNumber_(value) {
    const number = Number(String(value == null ? '' : value).replace(/[$,]/g, ''));
    return Number.isFinite(number) ? number : null;
  }

  return { getMetadata, parseInvoice };
})();
