const CED_WEB_APP_URL =
  'https://script.google.com/macros/s/AKfycbycBrApPZ87yJXnLaf47wo2fJyMMzHIbhzclLyD5NYZq0bziAsSq3ThsYvAhInistDJ/exec';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('CED Tool')
    .addItem('Open Invoice Parser', 'openCedWebApp')
    .addToUi();
}

function openCedWebApp() {
  const html = HtmlService.createHtmlOutput(`
    <!DOCTYPE html>
    <html>
      <head>
        <base target="_blank">
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 20px;
            text-align: center;
          }

          a {
            display: inline-block;
            padding: 12px 18px;
            border-radius: 8px;
            background: #1d4ed8;
            color: #ffffff;
            text-decoration: none;
            font-weight: 700;
          }
        </style>
      </head>
      <body>
        <p>Open the CED invoice parser:</p>
        <a href="${CED_WEB_APP_URL}">Open CED Tool</a>
      </body>
    </html>
  `)
    .setWidth(360)
    .setHeight(180);

  SpreadsheetApp.getUi().showModalDialog(html, 'CED Tool');
}
