"use client";

import { useEffect, useState, type FormEvent } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { createTag, deleteTag, getTags } from "@/lib/api";
import type { Tag } from "@/lib/types";

export default function TagsPage() {
  return (
    <RequireAuth>
      <TagsContent />
    </RequireAuth>
  );
}

function TagsContent() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadTags();
  }, []);

  async function loadTags() {
    setLoading(true);
    setError(null);
    try {
      const result = await getTags();
      setTags(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tags");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createTag({ name });
      setName("");
      await loadTags();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create tag");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteTag(id);
      await loadTags();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete tag");
    }
  }

  return (
    <div className="container">
      <h1 className="card-title">Tags</h1>

      <form className="toolbar" onSubmit={handleCreate}>
        <input
          className="input"
          type="text"
          placeholder="New tag name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="button" type="submit" disabled={submitting}>
          {submitting ? "Adding..." : "Add tag"}
        </button>
      </form>

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <p>Loading...</p>
      ) : tags.length === 0 ? (
        <p className="empty-state">No tags yet.</p>
      ) : (
        <div>
          {tags.map((tag) => (
            <span key={tag.id} className="tag-pill">
              {tag.name}
              <button onClick={() => handleDelete(tag.id)} aria-label={`Delete ${tag.name}`}>
                &times;
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}