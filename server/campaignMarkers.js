export const DEFAULT_CAMPAIGN_MARKER_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_CAMPAIGN_PENDING_MARKER_TTL_SECONDS = 60 * 60;

export function getCampaignMarkerTtlSeconds(value = process.env.CAMPAIGN_MARKER_TTL_SECONDS) {
  const parsed = Number(value ?? DEFAULT_CAMPAIGN_MARKER_TTL_SECONDS);
  if (!Number.isFinite(parsed)) return DEFAULT_CAMPAIGN_MARKER_TTL_SECONDS;
  return Math.max(0, Math.floor(parsed));
}

export function getCampaignPendingMarkerTtlSeconds(
  value = process.env.CAMPAIGN_PENDING_MARKER_TTL_SECONDS
) {
  const parsed = Number(value ?? DEFAULT_CAMPAIGN_PENDING_MARKER_TTL_SECONDS);
  if (!Number.isFinite(parsed)) return DEFAULT_CAMPAIGN_PENDING_MARKER_TTL_SECONDS;
  return Math.max(0, Math.floor(parsed));
}

export function buildCampaignMarkerAttributes({
  attrs = {},
  campaignKey,
  labelName,
  templateName,
  status,
  now = new Date(),
  ttlSeconds = getCampaignMarkerTtlSeconds(),
  pendingTtlSeconds = getCampaignPendingMarkerTtlSeconds(),
  error = "",
  replyAssignment = null
}) {
  const markedAt = now.toISOString();
  const activeTtlSeconds = status === "pending" ? pendingTtlSeconds : ttlSeconds;
  const activeUntil = new Date(now.getTime() + activeTtlSeconds * 1000).toISOString();
  const previousActiveUntil = parseFutureDate(
    attrs.api_campaign_status === "sent" ? attrs.api_campaign_active_until : null,
    now
  );
  const merged = {
    ...attrs,
    api_campaign_label: labelName,
    api_campaign_created_at: attrs.api_campaign_created_at || markedAt,
    api_campaign_marked_at: markedAt,
    api_campaign_status: status,
    api_campaign_active_until: status === "failed"
      ? previousActiveUntil?.toISOString() || markedAt
      : activeUntil,
    last_api_campaign_label: labelName,
    last_api_template: templateName
  };

  if (status === "sent" && campaignKey) merged[campaignKey] = markedAt;
  if (status === "failed" && error) merged.api_campaign_last_error = String(error).slice(0, 500);
  else delete merged.api_campaign_last_error;

  if (replyAssignment?.mode === "on_reply_team") {
    merged.api_campaign_reply_assign_mode = "on_reply_team";
    merged.api_campaign_reply_team_id = String(replyAssignment.teamId || "");
    merged.api_campaign_reply_team_name = String(replyAssignment.teamName || "");
    merged.api_campaign_reply_inbox_id = String(replyAssignment.inboxId || "");
    merged.api_campaign_reply_assignment_key = String(replyAssignment.assignmentKey || "");
    merged.api_campaign_reply_pending = status !== "failed";
    delete merged.api_campaign_reply_assigned_at;
    delete merged.api_campaign_reply_assignee_id;
    delete merged.api_campaign_reply_assignee_name;
  } else {
    delete merged.api_campaign_reply_assign_mode;
    delete merged.api_campaign_reply_team_id;
    delete merged.api_campaign_reply_team_name;
    delete merged.api_campaign_reply_inbox_id;
    delete merged.api_campaign_reply_assignment_key;
    delete merged.api_campaign_reply_assigned_at;
    delete merged.api_campaign_reply_assignee_id;
    delete merged.api_campaign_reply_assignee_name;
    merged.api_campaign_reply_pending = false;
  }

  return merged;
}

function parseFutureDate(value, now) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) return null;
  return date;
}
