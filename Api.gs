function getAppBootstrap() {
  try {
    return { success: true, data: Engine.initialize() };
  } catch (error) {
    return createErrorResponse_(error);
  }
}

function runEngine(moduleName, actionName, payload) {
  try {
    return Engine.execute(moduleName, actionName, payload || {});
  } catch (error) {
    return createErrorResponse_(error);
  }
}

function createErrorResponse_(error) {
  console.error(error);
  return { success: false, error: error && error.message ? error.message : String(error) };
}
