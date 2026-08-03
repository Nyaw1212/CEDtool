const ParserEngine = (() => {
  const ITEM_LINE_PATTERN = /^(\d{1,3})\s+([A-Z][A-Z0-9&.-]{1,12})\s+(.+)$/i;
  const PRICE_LINE_PATTERN = /^(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})\s+E(?:\s+\$?([\d,]+\.\d{2}))?$/i;
  const MIN_MATCH_SCORE = 0.72;

  function getMetadata() {
    return {
      id: 'parser',
      name: 'Greentech Numbered Quote Parser',
      version: '0.5.3',
      actions: ['parseInvoice']
    };
  }

  function parseInvoice(payload) {
    const text = String(payload && payload.text ? payload.text : '').trim();
    if (!text) throw new Error('Quote text is required.');

    const catalog = (PriceEngine.list().items || []).map(prepareCatalogItem_);
    const lines = normalizeLines_(text);
    const starts = findNumberedItemStarts_(lines);
    const items = [];

    starts.forEach((start, index) => {
      const nextStart = starts[index + 1];
      const endIndex = nextStart ? nextStart.lineIndex : lines.length;
      const blockLines = lines.slice(start.lineIndex, endIndex);
      const parsed = parseNumberedItemBlock_(blockLines, start);
      if (!parsed) return;

      const match = findBestCatalogMatch_(parsed, catalog);
      const catalogItem = match ? match.item : null;

      items.push({
        parsedSku: parsed.parsedSku,
        sku: parsed.parsedSku,
        vendor: parsed.vendor,
        spaSku: catalogItem ? catalogItem.sku : '',
        description: parsed.invoiceDescription || (catalogItem ? catalogItem.description : ''),
        invoiceDescription: parsed.invoiceDescription,
        quantityOrdered: parsed.quantity,
        quantityShipped: parsed.quantity,
        price: parsed.price,
        extPrice: parsed.extPrice,
        catalogMatch: Boolean(catalogItem),
        catalogPrice: catalogItem ? catalogItem.price : null,
        catalogExtPrice: catalogItem ? catalogItem.extPrice || null : null,
        matchScore: match ? match.score : 0,
        matchSource: match ? match.source : 'NO_MATCH',
        sourceOrder: items.length + 1,
        sourceLine: start.lineIndex + 1,
        sourceText: blockLines.join('\n')
      });
    });

    const documentInfo = extractDocumentInfo_(text);

    return {
      success: true,
      documentType: documentInfo.type,
      invoice: {
        number: documentInfo.number,
        date: documentInfo.date
      },
      count: items.length,
      matchedCount: items.filter(item => item.catalogMatch).length,
      newSkuCount: items.filter(item => !item.catalogMatch).length,
      items
    };
  }

  function normalizeLines_(text) {
    return String(text)
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  function findNumberedItemStarts_(lines) {
    const starts = [];

    lines.forEach((line, lineIndex) => {
      const match = line.match(ITEM_LINE_PATTERN);
      if (!match) return;

      const vendor = normalizeSku_(match[2]);
      const productText = normalizeSku_(match[3]);
      const parsedSku = extractSkuFromProductText_(vendor, productText);

      if (!parsedSku || !hasPriceBeforeNextItem_(lines, lineIndex + 1)) return;

      starts.push({
        lineIndex,
        lineNumber: Number(match[1]),
        vendor,
        parsedSku
      });
    });

    return starts;
  }

  function extractSkuFromProductText_(vendor, productText) {
    const tokens = productText.split(/\s+/).filter(Boolean);
    if (!tokens.length) return '';

    // Q.TRON module codes intentionally contain spaces and end with wattage.
    if (vendor === 'QCELL' && /^Q\.TRON\b/i.test(productText)) {
      return productText;
    }

    // All normal Greentech lines use: LN VENDOR SKU.
    return normalizeSku_(tokens[0]);
  }

  function hasPriceBeforeNextItem_(lines, fromIndex) {
    for (let index = fromIndex; index < Math.min(lines.length, fromIndex + 10); index += 1) {
      if (ITEM_LINE_PATTERN.test(lines[index])) return false;
      if (PRICE_LINE_PATTERN.test(lines[index])) return true;
    }
    return false;
  }

  function parseNumberedItemBlock_(blockLines, start) {
    let priceMatch = null;
    let priceLineIndex = -1;

    for (let index = 1; index < blockLines.length; index += 1) {
      const match = blockLines[index].match(PRICE_LINE_PATTERN);
      if (!match) continue;
      priceMatch = match;
      priceLineIndex = index;
      break;
    }

    if (!priceMatch) return null;

    const quantity = Number(priceMatch[1]);
    const price = toNumber_(priceMatch[2]);
    const extPrice = priceMatch[3]
      ? toNumber_(priceMatch[3])
      : Number((quantity * price).toFixed(2));

    const invoiceDescription = extractDescription_(blockLines, priceLineIndex);

    return {
      parsedSku: start.parsedSku,
      vendor: start.vendor,
      invoiceDescription,
      quantity,
      price,
      extPrice
    };
  }

  function extractDescription_(blockLines, priceLineIndex) {
    // In this template the first line after LN/Vendor/SKU is the description.
    for (let index = 1; index < priceLineIndex; index += 1) {
      const line = blockLines[index];
      if (!line || PRICE_LINE_PATTERN.test(line)) continue;
      return line.length <= 180 ? line : line.slice(0, 180).trim();
    }
    return '';
  }

  function prepareCatalogItem_(item) {
    return {
      ...item,
      normalizedSku: normalizeSku_(item.sku),
      compactSku: compactSku_(item.sku),
      normalizedDescription: normalizeText_(item.description),
      compactDescription: compactSku_(item.description)
    };
  }

  function findBestCatalogMatch_(parsed, catalog) {
    const parsedSku = compactSku_(parsed.parsedSku);
    const parsedDescription = normalizeText_(parsed.invoiceDescription);
    let best = null;

    for (const item of catalog) {
      let score = 0;
      let source = 'FUZZY';

      if (parsedSku && parsedSku === item.compactSku) {
        score = 1;
        source = 'EXACT_SKU';
      } else if (
        parsedSku.length >= 6 &&
        (item.compactDescription.includes(parsedSku) || parsedSku.includes(item.compactSku))
      ) {
        score = 0.96;
        source = 'SKU_IN_DESCRIPTION';
      } else {
        const skuScore = similarity_(parsedSku, item.compactSku);
        const descriptionScore = tokenSimilarity_(parsedDescription, item.normalizedDescription);
        score = Math.max(skuScore, descriptionScore, (skuScore * 0.7) + (descriptionScore * 0.3));
        source = descriptionScore > skuScore ? 'DESCRIPTION_MATCH' : 'FUZZY_SKU';
      }

      if (!best || score > best.score) best = { item, score, source };
    }

    return best && best.score >= MIN_MATCH_SCORE ? best : null;
  }

  function similarity_(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const distance = levenshtein_(a, b);
    return 1 - (distance / Math.max(a.length, b.length));
  }

  function levenshtein_(a, b) {
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);

    for (let i = 1; i <= a.length; i += 1) {
      let diagonal = previous[0];
      previous[0] = i;

      for (let j = 1; j <= b.length; j += 1) {
        const saved = previous[j];
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + cost);
        diagonal = saved;
      }
    }

    return previous[b.length];
  }

  function tokenSimilarity_(a, b) {
    const left = new Set(String(a || '').split(/\s+/).filter(token => token.length > 1));
    const right = new Set(String(b || '').split(/\s+/).filter(token => token.length > 1));
    if (!left.size || !right.size) return 0;

    let intersection = 0;
    left.forEach(token => {
      if (right.has(token)) intersection += 1;
    });

    const union = new Set([...left, ...right]).size;
    return union ? intersection / union : 0;
  }

  function extractDocumentInfo_(text) {
    const quoteNumberMatch = text.match(/\b(Q\d{5,})\b/i);
    const quoteDateMatch = text.match(/Quote Date:[\s\S]{0,180}?(\d{2}\/\d{2}\/\d{2,4})/i);

    return {
      type: 'QUOTE',
      number: quoteNumberMatch ? quoteNumberMatch[1].toUpperCase() : '',
      date: quoteDateMatch ? quoteDateMatch[1] : ''
    };
  }

  function normalizeSku_(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/\s+/g, ' ')
      .toUpperCase();
  }

  function compactSku_(value) {
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
