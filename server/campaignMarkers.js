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

// Chatwoot's POST /conversations/:id/custom_attributes replaces the whole hash,
// and other integrations (Insights Hub attribution, Odoo Bridge, Majed/Botpress)
// write their own keys to the same conversations. The uploader may only set or
// remove the keys below; everything else must be carried over from a fresh read.
export const CAMPAIGN_REPLY_ROUTE_ATTRIBUTE_KEYS = Object.freeze([
  "api_campaign_reply_assign_mode",
  "api_campaign_reply_target_type",
  "api_campaign_reply_target_id",
  "api_campaign_reply_target_name",
  "api_campaign_reply_team_id",
  "api_campaign_reply_team_name",
  "api_campaign_reply_inbox_id",
  "api_campaign_reply_assignment_key",
  "api_campaign_reply_rule_id",
  "api_campaign_reply_rule_name",
  "api_campaign_reply_condition",
  "api_campaign_reply_pending",
  "api_campaign_reply_assigned_at",
  "api_campaign_reply_assignee_id",
  "api_campaign_reply_assignee_name",
]);

export const CAMPAIGN_OWNED_ATTRIBUTE_KEYS = Object.freeze([
  "api_campaign_label",
  "api_campaign_created_at",
  "api_campaign_marked_at",
  "api_campaign_status",
  "api_campaign_active_until",
  "api_campaign_last_error",
  ...CAMPAIGN_REPLY_ROUTE_ATTRIBUTE_KEYS,
  "last_api_campaign_label",
  "last_api_template",
]);

// Per-campaign duplicate keys are `api_sent_<label>_<template>`.
const CAMPAIGN_OWNED_PREFIXES = Object.freeze(["api_campaign_", "api_sent_"]);
const OWNED_KEY_SET = new Set(CAMPAIGN_OWNED_ATTRIBUTE_KEYS);

export function isCampaignOwnedAttributeKey(key) {
  const name = String(key || "");
  return OWNED_KEY_SET.has(name) || CAMPAIGN_OWNED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function pickCampaignOwnedAttributes(attrs = {}) {
  return Object.fromEntries(
    Object.entries(attrs || {}).filter(([key]) => isCampaignOwnedAttributeKey(key))
  );
}

// Returns only the uploader's own changes: `set` holds campaign-owned values to
// write and `remove` lists campaign-owned keys to drop. `attrs` must be the
// conversation's attributes read inside the conversation lock. For a failed
// send, `previousAttrs` is the campaign-owned state from before this send's
// pending marker, so an older active campaign window and reply route survive.
export function buildCampaignMarkerChanges({
  attrs = {},
  previousAttrs = null,
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
  const current = attrs || {};
  const previous = previousAttrs || current;
  const markedAt = now.toISOString();
  const activeTtlSeconds = status === "pending" ? pendingTtlSeconds : ttlSeconds;
  const activeUntil = new Date(now.getTime() + activeTtlSeconds * 1000).toISOString();
  const previousActiveUntil = parseFutureDate(
    previous.api_campaign_status === "sent" ? previous.api_campaign_active_until : null,
    now
  );
  const set = {
    api_campaign_label: labelName,
    api_campaign_created_at: current.api_campaign_created_at || markedAt,
    api_campaign_marked_at: markedAt,
    api_campaign_status: status,
    api_campaign_active_until: status === "failed"
      ? previousActiveUntil?.toISOString() || markedAt
      : activeUntil,
    last_api_campaign_label: labelName,
    last_api_template: templateName
  };
  const remove = new Set();

  if (status === "sent" && campaignKey) set[campaignKey] = markedAt;
  if (status === "failed" && error) set.api_campaign_last_error = String(error).slice(0, 500);
  else remove.add("api_campaign_last_error");

  const preservePreviousReplyRoute = status === "failed"
    && isTruthy(previous.api_campaign_reply_pending)
    && Boolean(String(
      previous.api_campaign_reply_target_id || previous.api_campaign_reply_team_id || ""
    ).trim())
    && Boolean(parseFutureDate(previous.api_campaign_active_until, now));

  if (preservePreviousReplyRoute) {
    for (const key of CAMPAIGN_REPLY_ROUTE_ATTRIBUTE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(previous, key)) set[key] = previous[key];
      else remove.add(key);
    }
  } else if (["on_reply_target", "on_reply_team"].includes(replyAssignment?.mode)) {
    const targetType = replyAssignment.targetType === "agent" ? "agent" : "team";
    const targetId = String(
      replyAssignment.targetId
        || (targetType === "agent" ? replyAssignment.agentId : replyAssignment.teamId)
        || ""
    );
    const targetName = String(
      replyAssignment.targetName
        || (targetType === "agent" ? replyAssignment.agentName : replyAssignment.teamName)
        || ""
    );
    const sameRouteAlreadyCompleted = String(current.api_campaign_reply_assignment_key || "")
      === String(replyAssignment.assignmentKey || "")
      && Boolean(String(current.api_campaign_reply_assigned_at || "").trim());
    set.api_campaign_reply_assign_mode = "on_reply_target";
    set.api_campaign_reply_target_type = targetType;
    set.api_campaign_reply_target_id = targetId;
    set.api_campaign_reply_target_name = targetName;
    if (targetType === "team") {
      // Legacy aliases keep markers readable by instances running the previous
      // Team-only webhook during a rolling deploy.
      set.api_campaign_reply_team_id = targetId;
      set.api_campaign_reply_team_name = targetName;
    } else {
      remove.add("api_campaign_reply_team_id");
      remove.add("api_campaign_reply_team_name");
    }
    set.api_campaign_reply_inbox_id = String(replyAssignment.inboxId || "");
    set.api_campaign_reply_assignment_key = String(replyAssignment.assignmentKey || "");
    set.api_campaign_reply_rule_id = String(replyAssignment.ruleId || "");
    set.api_campaign_reply_rule_name = String(replyAssignment.ruleName || "");
    set.api_campaign_reply_condition = String(replyAssignment.condition || "").slice(0, 500);
    set.api_campaign_reply_pending = sameRouteAlreadyCompleted ? false : status !== "failed";
    if (sameRouteAlreadyCompleted) {
      set.api_campaign_reply_assigned_at = current.api_campaign_reply_assigned_at;
      if (current.api_campaign_reply_assignee_id) {
        set.api_campaign_reply_assignee_id = current.api_campaign_reply_assignee_id;
        set.api_campaign_reply_assignee_name = current.api_campaign_reply_assignee_name || "";
      }
    } else {
      remove.add("api_campaign_reply_assigned_at");
      remove.add("api_campaign_reply_assignee_id");
      remove.add("api_campaign_reply_assignee_name");
    }
  } else {
    for (const key of CAMPAIGN_REPLY_ROUTE_ATTRIBUTE_KEYS) remove.add(key);
    remove.delete("api_campaign_reply_pending");
    set.api_campaign_reply_pending = false;
  }

  return assertCampaignOwnedChanges({ set, remove: [...remove] });
}

export function assertCampaignOwnedChanges(changes) {
  const keys = [...Object.keys(changes?.set || {}), ...(changes?.remove || [])];
  const foreign = keys.filter((key) => !isCampaignOwnedAttributeKey(key));
  if (foreign.length) {
    throw new Error(`Campaign Uploader refused to change attributes it does not own: ${foreign.join(", ")}`);
  }
  return changes;
}

function isTruthy(value) {
  return value === true || String(value).trim().toLowerCase() === "true";
}

function parseFutureDate(value, now) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) return null;
  return date;
}
