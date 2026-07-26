"use client";

import { useEffect, useState, type FormEvent } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { createAudience, deleteAudience, getAudiences, getTags, updateAudience } from "@/lib/api";
import type { Audience, AudienceInput, Tag } from "@/lib/types";

export default function AudiencesPage() {
  return (
    <RequireAuth>
      <AudiencesContent />
    </RequireAuth>
  );
}

interface AudienceFormState {
  name: string;
  tagIds: string[];
  city: string;
  customFieldKey: string;
  customFieldValue: string;
}

const emptyForm: AudienceFormState = {
  name: "",
  tagIds: [],
  city: "",
  customFieldKey: "",
  customFieldValue: "",
};

// Builds the AudienceFilter the API expects out of the flat form fields
// above — tagIds/city/customFields are omitted (rather than sent as ""
// or []) whenever empty, mirroring how toContactInput() on the Contacts
// page turns blank strings into nulls before hitting the API.
function toAudienceInput(form: AudienceFormState): AudienceInput {
  return {
    name: form.name.trim(),
    filter: {
      tagIds: form.tagIds.length ? form.tagIds : undefined,
      city: form.city.trim() ? form.city.trim() : undefined,
      customFields:
        form.customFieldKey.trim() && form.customFieldValue.trim()
          ? { [form.customFieldKey.trim()]: form.customFieldValue.trim() }
          : undefined,
    },
  };
}

function toggleTag(current: string[], tagId: string): string[] {
  return current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId];
}

function AudiencesContent() {
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<AudienceFormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<AudienceFormState>(emptyForm);

  useEffect(() => {
    loadTags();
    loadAudiences();
  }, []);

  async function loadTags() {
    try {
      const result = await getTags();
      setTags(result);
    } catch (err) {
      // Tag list only feeds the filter checkboxes; audience loading below
      // has its own error state, so this stays non-blocking but should
      // still be visible during development.
      console.error("Failed to load tags", err);
    }
  }

  async function loadAudiences() {
    setLoading(true);
    setError(null);
    try {
      const result = await getAudiences();
      setAudiences(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audiences");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError("Provide a name for the audience");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createAudience(toAudienceInput(form));
      setForm(emptyForm);
      await loadAudiences();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create audience");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteAudience(id);
      await loadAudiences();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete audience");
    }
  }

  function startEdit(audience: Audience) {
    setEditingId(audience.id);
    const customFieldEntries = audience.filter.customFields ? Object.entries(audience.filter.customFields) : [];
    setEditDraft({
      name: audience.name,
      tagIds: audience.filter.tagIds ?? [],
      city: audience.filter.city ?? "",
      customFieldKey: customFieldEntries[0] ? customFieldEntries[0][0] : "",
      customFieldValue: customFieldEntries[0] ? String(customFieldEntries[0][1] ?? "") : "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(emptyForm);
  }

  async function handleSaveEdit(id: string) {
    if (!editDraft.name.trim()) {
      setError("Provide a name for the audience");
      return;
    }
    setError(null);
    try {
      await updateAudience(id, toAudienceInput(editDraft));
      setEditingId(null);
      await loadAudiences();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update audience");
    }
  }

  function filterSummary(audience: Audience): string {
    const parts: string[] = [];
    if (audience.filter.tagIds?.length) {
      const names = audience.filter.tagIds.map((id) => tags.find((t) => t.id === id)?.name).filter(Boolean);
      if (names.length) parts.push(`Tag: ${names.join(", ")}`);
    }
    if (audience.filter.city) parts.push(`City: ${audience.filter.city}`);
    if (audience.filter.customFields && Object.keys(audience.filter.customFields).length) {
      const [key, value] = Object.entries(audience.filter.customFields)[0];
      parts.push(`${key}: ${value}`);
    }
    return parts.length ? parts.join(" · ") : "All contacts";
  }

  return (
    <div className="container">
      <h1 className="card-title">Audiences</h1>

      <form onSubmit={handleCreate}>
        <div className="toolbar">
          <input
            className="input"
            type="text"
            placeholder="Audience name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="input"
            type="text"
            placeholder="City"
            value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
          />
          <input
            className="input"
            type="text"
            placeholder="Custom field key (e.g. plan)"
            value={form.customFieldKey}
            onChange={(e) => setForm({ ...form, customFieldKey: e.target.value })}
          />
          <input
            className="input"
            type="text"
            placeholder="Custom field value"
            value={form.customFieldValue}
            onChange={(e) => setForm({ ...form, customFieldValue: e.target.value })}
          />
          <button className="button" type="submit" disabled={submitting}>
            {submitting ? "Adding..." : "Add audience"}
          </button>
        </div>

        {tags.length > 0 && (
          <div>
            {tags.map((tag) => (
              <label key={tag.id} className="tag-pill">
                <input
                  type="checkbox"
                  checked={form.tagIds.includes(tag.id)}
                  onChange={() => setForm({ ...form, tagIds: toggleTag(form.tagIds, tag.id) })}
                />
                {tag.name}
              </label>
            ))}
          </div>
        )}
      </form>

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <p>Loading...</p>
      ) : audiences.length === 0 ? (
        <p className="empty-state">No audiences yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Filter</th>
              <th>Members</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {audiences.map((audience) => {
              const isEditing = editingId === audience.id;
              return (
                <tr key={audience.id}>
                  {isEditing ? (
                    <>
                      <td>
                        <input
                          className="input"
                          type="text"
                          value={editDraft.name}
                          onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          type="text"
                          placeholder="City"
                          value={editDraft.city}
                          onChange={(e) => setEditDraft({ ...editDraft, city: e.target.value })}
                        />
                        <input
                          className="input"
                          type="text"
                          placeholder="Custom field key"
                          value={editDraft.customFieldKey}
                          onChange={(e) => setEditDraft({ ...editDraft, customFieldKey: e.target.value })}
                        />
                        <input
                          className="input"
                          type="text"
                          placeholder="Custom field value"
                          value={editDraft.customFieldValue}
                          onChange={(e) => setEditDraft({ ...editDraft, customFieldValue: e.target.value })}
                        />
                        {tags.length > 0 && (
                          <div>
                            {tags.map((tag) => (
                              <label key={tag.id} className="tag-pill">
                                <input
                                  type="checkbox"
                                  checked={editDraft.tagIds.includes(tag.id)}
                                  onChange={() =>
                                    setEditDraft({ ...editDraft, tagIds: toggleTag(editDraft.tagIds, tag.id) })
                                  }
                                />
                                {tag.name}
                              </label>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>{audience.memberCount ?? 0}</td>
                      <td>
                        <button className="button" type="button" onClick={() => handleSaveEdit(audience.id)}>
                          Save
                        </button>
                        <button className="button button-secondary" type="button" onClick={cancelEdit}>
                          Cancel
                        </button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{audience.name}</td>
                      <td>{filterSummary(audience)}</td>
                      <td>{audience.memberCount ?? 0}</td>
                      <td>
                        <button className="button button-secondary" type="button" onClick={() => startEdit(audience)}>
                          Edit
                        </button>
                        <button
                          className="button button-secondary"
                          type="button"
                          onClick={() => handleDelete(audience.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}