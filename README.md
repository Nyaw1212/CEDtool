# CEDtool

Google Apps Script web app backed by the native Google Sheets service.

## Current milestone

- Reusable engine router
- Native Sheets price engine
- Price-list data viewer
- Search by SKU or description
- Comparison action scaffold for future tools

## Data source

- Spreadsheet: `12dmbFsAtR_K5ZOKuMebH5NHtzuvQ6WC4z1ECXO07gpY`
- Sheet: `LIST`
- Expected columns: `SKU`, `Description`, `Price`, `Ext Price`

## Local setup

Keep your local `.clasp.json`; it is intentionally ignored by Git.

```powershell
git pull origin main
clasp status
clasp push
```

## Web app release

After testing the pushed HEAD code, create or update a versioned web-app deployment through clasp or the Apps Script deployment screen.
