"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { RequireAuth } from "@/components/RequireAuth";
import { createCampaign, getAudiences, getTags, resolveRecipients } from "@/lib/api";
import type {
  Audience,
  CampaignInput,
  ResolveRecipientsResult,
  SelectionType,
  SelectionValue,
  Tag,
} from "@/lib/types";

export default function NewCampaignPage() {
  return (
    <RequireAuth>
      <NewCampaignContent />
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

function NewCampaignContent() {
  const router = useRouter();

  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");

  const [selectionType, setSelectionType] = useState<SelectionType>("audience");
  const [audienceId, setAudienceId] = useState("");
  const [tagId, setTagId] = useState("");
  const [pastedText, setPastedText] = useState("");

  const [preview, setPreview] = useState<ResolveRecipientsResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAudiences()
      .then(setAudiences)
      .catch((err) => console.error("Failed to load audiences", err));
    getTags()
      .then(setTags)
      .catch((err) => console.error("Failed to load tags", err));
  }, []);

  // Turns the current selection UI state into the wire-shaped
  // selectionValue the API expects for the active selectionType.
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

  async function handleSubmit(e: FormEvent) {
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

    setSubmitting(true);
    setError(null);
    try {
      const campaign = await createCampaign(input);
      // replace, not push — a freshly created draft has no "back to the
      // create form" state worth returning to.
      router.replace(`/campaigns/${campaign.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create campaign");
      setSubmitting(false);
    }
  }

  return (
    <div className="container">
      <h1 className="card-title">New campaign</h1>

      <form onSubmit={handleSubmit}>
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
          <button className="button button-secondary" type="button" onClick={handlePreview} disabled={previewing}>
            {previewing ? "Checking..." : "Preview recipients"}
          </button>
          <button className="button" type="submit" disabled={submitting}>
            {submitting ? "Creating..." : "Create draft"}
          </button>
        </div>
      </form>

      {error && <p className="form-error">{error}</p>}

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
    </div>
  );
}