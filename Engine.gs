const Engine = (() => {
  const modules_ = Object.freeze({
    price: PriceEngine
  });

  function initialize() {
    return {
      appName: CONFIG.APP_NAME,
      modules: Object.keys(modules_).map(key => modules_[key].getMetadata())
    };
  }

  function execute(moduleName, actionName, payload) {
    const module = modules_[moduleName];

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
