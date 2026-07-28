"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { RequireAuth } from "@/components/RequireAuth";
import {
  cancelSchedule,
  getAudiences,
  getCampaign,
  getCampaignAnalytics,
  getTags,
  resolveRecipients,
  sendCampaign,
  updateCampaign,
} from "@/lib/api";
import type {
  Audience,
  Campaign,
  CampaignAnalytics,
  CampaignInput,
  ResolveRecipientsResult,
  SelectionType,
  SelectionValue,
  Tag,
} from "@/lib/types";

export default function CampaignDetailPage() {
  return (
    <RequireAuth>
      <CampaignDetailContent />
    </RequireAuth>
  );
}

function contactLabel(c: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
}): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
  return name || c.email || c.phone || "Unknown";
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

// Statuses for which the analytics panel (and its polling) is relevant —
// a draft/scheduled campaign has no recipients snapshot yet, so there's
// nothing to poll for.
const ANALYTICS_STATUSES = ["sending", "sent", "failed"];

function CampaignDetailContent() {
  const { id } = useParams<{ id: string }>();

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit form state — only rendered/used while the campaign is a draft.
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [selectionType, setSelectionType] = useState<SelectionType>("audience");
  const [audienceId, setAudienceId] = useState("");
  const [tagId, setTagId] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [saving, setSaving] = useState(false);

  const [preview, setPreview] = useState<ResolveRecipientsResult | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [scheduledAt, setScheduledAt] = useState("");
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const [analytics, setAnalytics] = useState<CampaignAnalytics | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

  useEffect(() => {
    loadCampaign();
    getAudiences()
      .then(setAudiences)
      .catch((err) => console.error("Failed to load audiences", err));
    getTags()
      .then(setTags)
      .catch((err) => console.error("Failed to load tags", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function loadCampaign() {
    setLoading(true);
    setError(null);
    try {
      const result = await getCampaign(id);
      setCampaign(result);
      setName(result.name);
      setSubject(result.subject);
      setBodyHtml(result.bodyHtml);
      setSelectionType(result.selectionType);
      if (result.selectionType === "audience" && "audienceId" in result.selectionValue) {
        setAudienceId(result.selectionValue.audienceId);
      } else if (result.selectionType === "tag" && "tagId" in result.selectionValue) {
        setTagId(result.selectionValue.tagId);
      } else if (result.selectionType === "pasted_list" && "lines" in result.selectionValue) {
        setPastedText(result.selectionValue.lines.join("\n"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load campaign");
    } finally {
      setLoading(false);
    }
  }

  // Analytics polling — only while the campaign is in flight or done
  // sending. Fetches immediately, then every 5 seconds, and always
  // cleans up on unmount or when the campaign's status changes.
  useEffect(() => {
    if (!campaign || !ANALYTICS_STATUSES.includes(campaign.status)) return;

    let cancelled = false;

    async function fetchAnalytics() {
      try {
        const result = await getCampaignAnalytics(id);
        if (!cancelled) {
          setAnalytics(result);
          setAnalyticsError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setAnalyticsError(err instanceof Error ? err.message : "Failed to load analytics");
        }
      }
    }

    fetchAnalytics();
    const interval = setInterval(fetchAnalytics, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [campaign?.status, id]);

  function buildSelectionValue(): SelectionValue | null {
    if (selectionType === "audience") {
      return audienceId ? { audienceId } : null;
    }
    if (selectionType === "tag") {
      return tagId ? { tagId } : null;
    }
    const lines = pastedText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.length ? { lines } : null;
  }

  async function handlePreview() {
    const selectionValue = buildSelectionValue();
    if (!selectionValue) {
      setError("Choose an audience, a tag, or paste at least one email or phone number");
      return;
    }
    setPreviewing(true);
    setError(null);
    try {
      const result = await resolveRecipients({ selectionType, selectionValue });
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resolve recipients");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !subject.trim() || !bodyHtml.trim()) {
      setError("Name, subject, and body are all required");
      return;
    }
    const selectionValue = buildSelectionValue();
    if (!selectionValue) {
      setError("Choose an audience, a tag, or paste at least one email or phone number");
      return;
    }
    const input: CampaignInput = {
      name: name.trim(),
      subject: subject.trim(),
      bodyHtml,
      selectionType,
      selectionValue,
    };
    setSaving(true);
    setError(null);
    try {
      const updated = await updateCampaign(id, input);
      setCampaign(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save campaign");
    } finally {
      setSaving(false);
    }
  }

  async function handleSendNow() {
    setSending(true);
    setError(null);
    try {
      const updated = await sendCampaign(id, {});
      setCampaign(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send campaign");
    } finally {
      setSending(false);
    }
  }

  async function handleSchedule() {
    if (!scheduledAt) {
      setError("Choose a date and time to schedule this campaign");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const updated = await sendCampaign(id, { scheduledAt: new Date(scheduledAt).toISOString() });
      setCampaign(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to schedule campaign");
    } finally {
      setSending(false);
    }
  }

  async function handleCancelSchedule() {
    setCancelling(true);
    setError(null);
    try {
      const updated = await cancelSchedule(id);
      setCampaign(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel schedule");
    } finally {
      setCancelling(false);
    }
  }

  if (loading) {
    return (
      <div className="container">
        <p>Loading...</p>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="container">
        <p className="form-error">{error ?? "Campaign not found"}</p>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="toolbar">
        <h1 className="card-title">{campaign.name}</h1>
        <Link className="button button-secondary" href="/campaigns">
          Back to campaigns
        </Link>
      </div>

      <p className="card-subtitle">Status: {campaign.status}</p>

      {error && <p className="form-error">{error}</p>}

      {campaign.status === "draft" && (
        <>
          <form onSubmit={handleSave}>
            <div className="form-group">
              <label>Name</label>
              <input className="input" type="text" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="form-group">
              <label>Subject</label>
              <input className="input" type="text" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>

            <div className="form-group">
              <label>Body</label>
              <textarea className="input" rows={8} value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} />
            </div>

            <div className="form-group">
              <label>Send to</label>
              <div>
                <label>
                  <input
                    type="radio"
                    checked={selectionType === "audience"}
                    onChange={() => {
                      setSelectionType("audience");
                      setPreview(null);
                    }}
                  />{" "}
                  An audience
                </label>{" "}
                <label>
                  <input
                    type="radio"
                    checked={selectionType === "tag"}
                    onChange={() => {
                      setSelectionType("tag");
                      setPreview(null);
                    }}
                  />{" "}
                  A tag
                </label>{" "}
                <label>
                  <input
                    type="radio"
                    checked={selectionType === "pasted_list"}
                    onChange={() => {
                      setSelectionType("pasted_list");
                      setPreview(null);
                    }}
                  />{" "}
                  Paste emails or phone numbers
                </label>
              </div>
            </div>

            {selectionType === "audience" && (
              <div className="form-group">
                <select className="input" value={audienceId} onChange={(e) => setAudienceId(e.target.value)}>
                  <option value="">Select an audience</option>
                  {audiences.map((audience) => (
                    <option key={audience.id} value={audience.id}>
                      {audience.name} ({audience.memberCount ?? 0})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {selectionType === "tag" && (
              <div className="form-group">
                <select className="input" value={tagId} onChange={(e) => setTagId(e.target.value)}>
                  <option value="">Select a tag</option>
                  {tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {selectionType === "pasted_list" && (
              <div className="form-group">
                <textarea
                  className="input"
                  rows={6}
                  placeholder="One email or phone number per line"
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                />
              </div>
            )}

            <div className="toolbar">
              <button
                className="button button-secondary"
                type="button"
                onClick={handlePreview}
                disabled={previewing}
              >
                {previewing ? "Checking..." : "Preview recipients"}
              </button>
              <button className="button" type="submit" disabled={saving}>
                {saving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </form>

          {preview && (
            <div>
              <p className="card-subtitle">
                {preview.matched.length} matched, {preview.unmatched.length} unmatched
              </p>
              {preview.matched.length > 0 && (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Phone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.matched.map((contact) => (
                      <tr key={contact.id}>
                        <td>{contactLabel(contact)}</td>
                        <td>{contact.email ?? "—"}</td>
                        <td>{contact.phone ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {preview.unmatched.length > 0 && (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Input</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.unmatched.map((u, i) => (
                      <tr key={i}>
                        <td>{u.rawInput}</td>
                        <td>{u.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {error && <p className="form-error">{error}</p>}
<div className="toolbar">
  <input
    className="input"
    type="datetime-local"
    value={scheduledAt}
    onChange={(e) => setScheduledAt(e.target.value)}
  />
  <button className="button button-secondary" type="button" onClick={handleSchedule} disabled={sending}>
    {sending ? "Scheduling..." : "Schedule send"}
  </button>
  <button className="button" type="button" onClick={handleSendNow} disabled={sending || !!scheduledAt}>
  {sending ? "Sending..." : "Send now"}
</button>
</div>
        </>
      )}

      {campaign.status === "scheduled" && (
        <div>
          <p>Scheduled for {formatDate(campaign.scheduledAt)}</p>
          <button
            className="button button-secondary"
            type="button"
            onClick={handleCancelSchedule}
            disabled={cancelling}
          >
            {cancelling ? "Cancelling..." : "Cancel schedule"}
          </button>
        </div>
      )}

      {ANALYTICS_STATUSES.includes(campaign.status) && (
        <div>
          <h2 className="card-title">Analytics</h2>
          {analyticsError && <p className="form-error">{analyticsError}</p>}
          {analytics ? (
            <table className="table">
              <tbody>
                <tr>
                  <td>Total recipients</td>
                  <td>{analytics.totalRecipients}</td>
                </tr>
                <tr>
                  <td>Pending</td>
                  <td>{analytics.pending}</td>
                </tr>
                <tr>
                  <td>Sent</td>
                  <td>{analytics.sent}</td>
                </tr>
                <tr>
                  <td>Delivered</td>
                  <td>
                    {analytics.delivered} ({analytics.deliveryRate}%)
                  </td>
                </tr>
                <tr>
                  <td>Opened</td>
                  <td>
                    {analytics.opened} ({analytics.openRate}%)
                  </td>
                </tr>
                <tr>
                  <td>Failed / bounced</td>
                  <td>{analytics.failed}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p>Loading analytics...</p>
          )}
        </div>
      )}
    </div>
  );
}