function doGet() {
  const template = HtmlService.createTemplateFromFile('Index');
  template.appVersion = CONFIG.APP_VERSION;
  template.buildLabel = CONFIG.BUILD_LABEL;

  return template
    .evaluate()
    .setTitle(`${CONFIG.APP_NAME} ${CONFIG.APP_VERSION}`)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
