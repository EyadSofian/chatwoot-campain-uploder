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
  error = ""
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

  return merged;
}

function parseFutureDate(value, now) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) return null;
  return date;
}
