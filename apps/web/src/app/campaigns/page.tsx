"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RequireAuth } from "@/components/RequireAuth";
import { deleteCampaign, getCampaigns } from "@/lib/api";
import type { Campaign } from "@/lib/types";

export default function CampaignsPage() {
  return (
    <RequireAuth>
      <CampaignsContent />
    </RequireAuth>
  );
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function CampaignsContent() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCampaigns();
  }, []);

  async function loadCampaigns() {
    setLoading(true);
    setError(null);
    try {
      const result = await getCampaigns();
      setCampaigns(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteCampaign(id);
      await loadCampaigns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete campaign");
    }
  }

  return (
    <div className="container">
      <div className="toolbar">
        <h1 className="card-title">Campaigns</h1>
        <Link className="button" href="/campaigns/new">
          New campaign
        </Link>
      </div>

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <p>Loading...</p>
      ) : campaigns.length === 0 ? (
        <p className="empty-state">No campaigns yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Subject</th>
              <th>Status</th>
              <th>Scheduled</th>
              <th>Sent</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => (
              <tr key={campaign.id}>
                <td>{campaign.name}</td>
                <td>{campaign.subject}</td>
                <td>{campaign.status}</td>
                <td>{formatDate(campaign.scheduledAt)}</td>
                <td>{formatDate(campaign.sentAt)}</td>
                <td>
                  <Link className="button button-secondary" href={`/campaigns/${campaign.id}`}>
                    View
                  </Link>
                  {campaign.status === "draft" && (
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={() => handleDelete(campaign.id)}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}