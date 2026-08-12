# Chatwoot Campaign Uploader

Dashboard app for Chatwoot self-hosted that can:

- Import or update contacts from CSV.
- Add contact custom attributes.
- Create labels and add contacts without removing existing labels.
- Sync WhatsApp inboxes from Chatwoot.
- Sync WhatsApp templates through Chatwoot.
- Send WhatsApp template campaigns through Chatwoot API in safe test mode, so the campaign message appears in the conversation.
- Send campaigns unassigned, then route the first customer reply to a fixed Team or to a Team selected by ordered Label/Custom Attribute rules.
- Run contact uploads and WhatsApp sends as server-side background jobs, with uploads separated from send queues.
- Search saved campaign jobs by label/campaign name, operator, status, or template name.

## Railway

Use these settings:

```bash
Build Command: npm install
Start Command: npm start
```

Required environment variable:

```bash
CHATWOOT_URL=https://chat.engosoft.com
CHATWOOT_API_TOKEN=your_admin_or_agent_access_token
```

Optional:

```bash
PORT=3000
CAMPAIGN_MARKER_TTL_SECONDS=2592000
CAMPAIGN_PENDING_MARKER_TTL_SECONDS=3600
WEBHOOK_SECRET=choose-a-random-secret
```

Railway usually provides `PORT` automatically, so only add `PORT` if you need to force a local value.

`CAMPAIGN_MARKER_TTL_SECONDS` defaults to 30 days. Use the same value in
Chatwoot Actions. Before any template is sent, the uploader verifies a
`pending` campaign marker on the conversation. This prevents Department and
Reopen automation from taking over a fast customer reply. Successful sends are
marked `sent`; failed sends expire their marker immediately. A `pending` marker
expires after one hour by default, so an interrupted job cannot block normal
routing for the full campaign window.

`WEBHOOK_SECRET` is optional but recommended. If it is set, add the same value
to the Chatwoot webhook URL as `?token=...`.

## Reply-Based Agent or Team Assignment

Use this when you want the broadcast to stay unassigned until the customer
replies.

1. In the assignment panel, enable automatic assignment.
2. Choose either `Target ثابت عند رد العميل` or `شروط Label / Custom Attribute عند الرد`.
3. For a fixed route, choose `Agent` or `Team`, sync that target type, and select the target.
4. For conditional routing, sync Agents and/or Teams, then choose the target type and target separately on every rule.
5. The first matching rule wins; put the optional fallback last.
6. Send the campaign as a background job.

When the customer replies, Chatwoot sends a webhook to the app. The app checks
the campaign marker on the conversation and assigns the stored target. An Agent
target goes directly to that inbox member. A Team target keeps Chatwoot's own
Auto Assign, availability, and capacity policy.

Example rules:

- `Label = revit_august` → `Agent: Ahmed`
- `course_type = BIM` → `Team: BIM Sales`
- `Fallback` → `Team: General Sales`

The Label and Custom Attribute used by the router are the same values configured
in the campaign form. The route is resolved when the campaign row is prepared,
then stored on the conversation. This makes the first-reply webhook deterministic
even if the CSV or dashboard rules change later. The campaign Label is also added
to the conversation while preserving existing conversation labels.

Before sending, the app clears any existing Team/Agent assignment on the target
conversation. If sending fails, the previous assignment is restored. A successful
campaign stays unassigned until the first public incoming message arrives.
Campaign marker updates and first-reply handling share a per-conversation lock,
so the implementation stays compatible with older Chatwoot installations while
protecting very fast replies from being reactivated by a late send update.

Add this webhook in Chatwoot:

```text
Settings → Integrations → Webhooks → Add new webhook
URL: https://YOUR-APP-DOMAIN/api/webhooks/chatwoot
Event: message_created
```

If `WEBHOOK_SECRET` is set:

```text
URL: https://YOUR-APP-DOMAIN/api/webhooks/chatwoot?token=YOUR_SECRET
```

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
