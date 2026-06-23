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
CAMPAIGN_MARKER_TTL_SECONDS=2592000
CAMPAIGN_PENDING_MARKER_TTL_SECONDS=3600
```

Railway usually provides `PORT` automatically, so only add `PORT` if you need to force a local value.

`CAMPAIGN_MARKER_TTL_SECONDS` defaults to 30 days. Use the same value in
Chatwoot Actions. Before any template is sent, the uploader verifies a
`pending` campaign marker on the conversation. This prevents Department and
Reopen automation from taking over a fast customer reply. Successful sends are
marked `sent`; failed sends expire their marker immediately. A `pending` marker
expires after one hour by default, so an interrupted job cannot block normal
routing for the full campaign window.

## Assign on Customer Reply (Team Round-Robin)

By default the app assigns each conversation at send time. There is also an
`on_reply_team` assignment mode that does the opposite: the broadcast goes out
to everyone **unassigned**, and no agent is touched until the customer takes an
action. When the customer replies, an incoming-message webhook triggers the
app, which assigns the conversation to the next member of the chosen team using
a persisted round-robin counter — so replies are distributed **equally** across
the team members you designated for the campaign, using our own logic instead
of Chatwoot's built-in routing.

How to use it:

1. In the assignment panel choose `توزيع بالتساوي على التيم عند رد العميل`
   (`on_reply_team`) and pick the team.
2. Run the campaign as a server-side Background Job (not Dry Run).
3. In Chatwoot, add a Webhook (Settings → Integrations → Webhooks) pointing to:

   ```text
   https://<your-app>/api/webhooks/chatwoot
   ```

   Subscribe it to the `Message created` event.

4. Set `CHATWOOT_API_TOKEN` on the server (required — the webhook runs
   server-to-server without the UI token).

Required env for this feature:

```bash
CHATWOOT_API_TOKEN=<agent_or_bot_access_token>
```

Optional:

```bash
WEBHOOK_SECRET=<shared_secret>
```

If `WEBHOOK_SECRET` is set, the webhook must include it as `?token=<secret>` in
the URL or an `x-webhook-token` header; requests without it are rejected.

The app stamps each conversation with `api_campaign_assign_mode=on_reply`,
`api_campaign_assign_team=<teamId>`, and `api_campaign_assign_status` (moving
from `awaiting` to `done`). The webhook ignores conversations that are already
assigned or already routed, so duplicate replies do not reassign.

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
