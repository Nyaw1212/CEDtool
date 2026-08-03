const ParserEngine = (() => {
  const FOOTER_PATTERN = /^(MERCHANDISE:|TAX:|TOTAL:|PLEASE NOTE:|TERMS AND CONDITIONS|\d+ OF \d+|\* PER |REVISION #:)/i;
  const HEADER_PATTERN = /^(LN|PRODUCT|DESCRIPTION|QTY|PRICE|PER \*|EXT PRICE|QUOTE:)$/i;
  const MAX_SPLIT_SKU_LINES = 3;
  const MIN_MATCH_SCORE = 0.72;

  function getMetadata() {
    return {
      id: 'parser',
      name: 'Greentech Quote Parser',
      version: '0.4.0',
      actions: ['parseInvoice']
    };
  }

  function parseInvoice(payload) {
    const text = String(payload && payload.text ? payload.text : '').trim();
    if (!text) throw new Error('Quote text is required.');

    const catalog = (PriceEngine.list().items || []).map(prepareCatalogItem_);
    const lines = normalizeLines_(text);
    const starts = findItemStarts_(lines);
    const items = [];

    starts.forEach((start, index) => {
      const nextStart = starts[index + 1];
      const endIndex = nextStart
        ? nextStart.lineIndex
        : findDocumentEnd_(lines, start.lineIndex + start.lineCount);

      const blockLines = lines.slice(start.lineIndex, endIndex);
      const parsed = parseItemBlock_(blockLines, start);
      if (!parsed) return;

      const match = findBestCatalogMatch_(parsed, catalog);
      const catalogItem = match ? match.item : null;

      items.push({
        parsedSku: parsed.parsedSku,
        sku: parsed.parsedSku,
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

  function prepareCatalogItem_(item) {
    return {
      ...item,
      normalizedSku: normalizeSku_(item.sku),
      compactSku: compactSku_(item.sku),
      normalizedDescription: normalizeText_(item.description),
      compactDescription: compactSku_(item.description)
    };
  }

  function normalizeLines_(text) {
    return String(text)
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  }

  function findItemStarts_(lines) {
    const starts = [];
    let coveredUntil = -1;

    for (let index = 0; index < lines.length; index += 1) {
      if (index <= coveredUntil) continue;
      const line = lines[index];
      if (FOOTER_PATTERN.test(line) || HEADER_PATTERN.test(line)) continue;

      const numbered = line.match(/^\d{1,3}\s+([A-Z][A-Z0-9&.-]{1,12})\s+(.+)$/i);
      if (numbered && looksLikeProductCode_(numbered[2])) {
        starts.push({
          lineIndex: index,
          lineCount: 1,
          parsedSku: normalizeSku_(numbered[2]),
          source: 'NUMBERED_QUOTE_LINE'
        });
        continue;
      }

      const standalone = detectStandaloneProduct_(lines, index);
      if (standalone) {
        starts.push({
          lineIndex: index,
          lineCount: standalone.lineCount,
          parsedSku: standalone.parsedSku,
          source: standalone.lineCount > 1 ? 'SPLIT_QUOTE_SKU' : 'STANDALONE_QUOTE_SKU'
        });
        coveredUntil = index + standalone.lineCount - 1;
      }
    }

    return starts.sort((a, b) => a.lineIndex - b.lineIndex);
  }

  function detectStandaloneProduct_(lines, lineIndex) {
    const first = lines[lineIndex] || '';
    if (!/^[A-Z][A-Z0-9&.-]{1,12}\s+\S+/i.test(first)) return null;
    if (/^(GREENTECH|CUSTOMER|CONTACT|MAYER|SHIP|QUOTE|UPDATED|EXPIRES|FREIGHT|FOB)\b/i.test(first)) return null;

    const firstParts = first.split(/\s+/);
    const vendor = firstParts.shift();
    if (!vendor || !/^[A-Z][A-Z0-9&.-]{1,12}$/i.test(vendor)) return null;

    for (let count = MAX_SPLIT_SKU_LINES; count >= 1; count -= 1) {
      const parts = lines.slice(lineIndex, lineIndex + count);
      if (parts.length !== count) continue;
      if (parts.some((part, offset) => offset > 0 && !/^[A-Z0-9.+/_-]+$/i.test(part))) continue;

      const skuParts = [firstParts.join(' ')].concat(parts.slice(1));
      const candidate = normalizeSku_(skuParts.join(' '));
      if (!looksLikeProductCode_(candidate)) continue;
      if (!hasPriceNearby_(lines, lineIndex + count)) continue;

      return { parsedSku: candidate, lineCount: count };
    }

    return null;
  }

  function hasPriceNearby_(lines, fromIndex) {
    const nearby = lines.slice(fromIndex, Math.min(lines.length, fromIndex + 12)).join(' ');
    return /(?:^|\s)\d+(?:\.\d+)?\s+\$?[\d,]+\.\d{2}\s+E(?:\s+\$?[\d,]+\.\d{2})?(?=\s|$)/i.test(nearby);
  }

  function looksLikeProductCode_(value) {
    const text = normalizeSku_(value);
    if (text.length < 3 || text.length > 80) return false;
    if (!/[A-Z]/.test(text) || !/[0-9]/.test(text)) return false;
    return !/^(OF|PER|EACH|HUNDRED|THOUSAND)$/i.test(text);
  }

  function parseItemBlock_(blockLines, start) {
    const cleanLines = trimAtFooter_(blockLines);
    const flat = cleanLines.join(' ');

    const fullPrice = flat.match(
      /(?:^|\s)(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})\s+E\s+\$?([\d,]+\.\d{2})(?=\s|$)/i
    );
    const partialPrice = fullPrice
      ? null
      : flat.match(/(?:^|\s)(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d{2})\s+E(?=\s|$)/i);

    const priceMatch = fullPrice || partialPrice;
    if (!priceMatch) return null;

    const quantity = Number(priceMatch[1]);
    const price = toNumber_(priceMatch[2]);
    const extPrice = fullPrice
      ? toNumber_(priceMatch[3])
      : Number((quantity * price).toFixed(2));

    return {
      parsedSku: start.parsedSku,
      invoiceDescription: extractDescription_(cleanLines, start),
      quantity,
      price,
      extPrice
    };
  }

  function extractDescription_(lines, start) {
    const candidates = [];

    lines.forEach((line, index) => {
      if (index < start.lineCount) return;
      if (FOOTER_PATTERN.test(line) || HEADER_PATTERN.test(line)) return;
      if (/^\d{1,3}$/.test(line)) return;
      if (/^E$/i.test(line)) return;
      if (/^\$?[\d,]+\.\d{2}$/.test(line)) return;
      if (/^\d+(?:\.\d+)?\s+\$?[\d,]+\.\d{2}\s+E/i.test(line)) return;
      if (!/[A-Z]/i.test(line)) return;

      const normalized = line.replace(/\s+/g, ' ').trim();
      if (!normalized) return;
      candidates.push(normalized);
    });

    if (!candidates.length) return '';

    const first = candidates[0];
    return first.length <= 180 ? first : first.slice(0, 180).trim();
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
        previous[j] = Math.min(
          previous[j] + 1,
          previous[j - 1] + 1,
          diagonal + cost
        );
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

  function trimAtFooter_(lines) {
    const output = [];
    for (const line of lines) {
      if (FOOTER_PATTERN.test(line)) break;
      output.push(line);
    }
    return output;
  }

  function findDocumentEnd_(lines, fromIndex) {
    for (let index = fromIndex; index < lines.length; index += 1) {
      if (FOOTER_PATTERN.test(lines[index])) return index;
    }
    return lines.length;
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
