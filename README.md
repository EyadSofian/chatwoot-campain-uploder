# Chatwoot Campaign Uploader

Dashboard app for Chatwoot self-hosted that can:

- Import or update contacts from CSV.
- Add contact custom attributes.
- Create labels and add contacts without removing existing labels.
- Sync WhatsApp inboxes from Chatwoot.
- Sync WhatsApp templates through Chatwoot.
- Send WhatsApp template campaigns through Chatwoot API in safe test mode, so the campaign message appears in the conversation.

## Railway

Use these settings:

```bash
Build Command: npm install
Start Command: npm start
```

Required environment variable:

```bash
CHATWOOT_URL=https://chat.engosoft.com
```

Optional:

```bash
PORT=3000
```

Railway usually provides `PORT` automatically, so only add `PORT` if you need to force a local value.

## Safe Sending Flow

1. Open the app.
2. Enter your Chatwoot API token and Account ID.
3. Click `Sync Inboxes`.
4. Choose the WhatsApp inbox.
5. Click `Sync Templates من Meta` if the template list is stale.
6. Choose the template.
7. Upload the CSV.
8. Keep `Dry Run` and `Test Mode` enabled first.
9. Review logs.
10. For a real test, disable `Dry Run`, keep `Test Mode`, and enable confirmation.
11. After two successful test numbers, disable `Test Mode` for the full campaign.

## CSV Format

Minimum:

```csv
name,phone_number,test13
Eyad Sofian,+201007725744,Ahmed_ibrahim
Eyad Mohamed,+201210280648,Ahmed_ibrahim
```

For template variables, add columns and map them in the app:

```csv
name,phone_number,test13,course_name
Eyad Sofian,+201007725744,Ahmed_ibrahim,Revit
```

Mapping example:

```text
1=name
2=course_name
```

Do not open and resave phone CSV files in Excel unless the phone column is formatted as text. Excel can convert numbers to scientific notation.
