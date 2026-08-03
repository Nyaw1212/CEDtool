const Engine = (() => {
  /**
   * Resolve modules lazily at runtime.
   *
   * Apps Script does not guarantee source-file evaluation order, so modules
   * must not be referenced while the global Engine object is being created.
   */
  function getModules_() {
    return {
      price: PriceEngine,
      parser: QuoteParserEngine
    };
  }

  function initialize() {
    const modules = getModules_();

    return {
      appName: CONFIG.APP_NAME,
      modules: Object.keys(modules).map(key => modules[key].getMetadata())
    };
  }

  function execute(moduleName, actionName, payload) {
    const modules = getModules_();
    const module = modules[moduleName];

    if (!module) {
      throw new Error(`Unknown engine module: ${moduleName}`);
    }

    if (typeof module[actionName] !== 'function') {
      throw new Error(`Unknown action "${actionName}" in module "${moduleName}".`);
    }

    return module[actionName](payload || {});
  }

  return { initialize, execute };
})();
