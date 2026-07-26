// apps/web/src/app/contacts/page.tsx
"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import {
  addTagToContact,
  createContact,
  deleteContact,
  getContacts,
  getTags,
  importContacts,
  updateContact,
} from "@/lib/api";
import type { Contact, ContactInput, Tag } from "@/lib/types";

export default function ContactsPage() {
  return (
    <RequireAuth>
      <ContactsContent />
    </RequireAuth>
  );
}

const emptyContact: ContactInput = {
  email: "",
  phone: "",
  firstName: "",
  lastName: "",
  city: "",
};

// Blank strings from inputs must become null before hitting the API —
// contactSchema's z.string().email() rejects "" but accepts null.
function toContactInput(fields: ContactInput): ContactInput {
  return {
    email: fields.email?.trim() ? fields.email.trim() : null,
    phone: fields.phone?.trim() ? fields.phone.trim() : null,
    firstName: fields.firstName?.trim() ? fields.firstName.trim() : null,
    lastName: fields.lastName?.trim() ? fields.lastName.trim() : null,
    city: fields.city?.trim() ? fields.city.trim() : null,
  };
}

function ContactsContent() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [city, setCity] = useState("");
  const [tagId, setTagId] = useState("");

  const [newContact, setNewContact] = useState<ContactInput>(emptyContact);
  const [submitting, setSubmitting] = useState(false);

  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ContactInput>(emptyContact);

  useEffect(() => {
    loadTags();
    loadContacts();
  }, []);

  async function loadTags() {
    try {
      const result = await getTags();
      setTags(result);
    } catch (err) {
      // Tag list only feeds the filter/assign dropdowns; contact loading
      // below has its own error state, so this stays non-blocking but
      // should still be visible during development.
      console.error("Failed to load tags", err);
    }
  }

  async function loadContacts() {
    setLoading(true);
    setError(null);
    try {
      const result = await getContacts({
        search: search || undefined,
        city: city || undefined,
        tagId: tagId || undefined,
      });
      setContacts(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load contacts");
    } finally {
      setLoading(false);
    }
  }

  function handleFilterSubmit(e: FormEvent) {
    e.preventDefault();
    loadContacts();
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    const payload = toContactInput(newContact);
    if (!payload.email && !payload.phone) {
      setError("Provide at least an email or a phone number");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createContact(payload);
      setNewContact(emptyContact);
      await loadContacts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create contact");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteContact(id);
      await loadContacts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete contact");
    }
  }

  function startEdit(contact: Contact) {
    setEditingId(contact.id);
    setEditDraft({
      email: contact.email,
      phone: contact.phone,
      firstName: contact.firstName,
      lastName: contact.lastName,
      city: contact.city,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(emptyContact);
  }

  async function handleSaveEdit(id: string) {
    setError(null);
    try {
      await updateContact(id, toContactInput(editDraft));
      setEditingId(null);
      await loadContacts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update contact");
    }
  }

  async function handleAddTag(contactId: string, tagIdToAdd: string) {
    setError(null);
    try {
      await addTagToContact(contactId, tagIdToAdd);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add tag");
    }
  }

  async function handleImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportMessage(null);
    setError(null);
    try {
      const result = await importContacts(file);
      setImportMessage(result.message);
      await loadContacts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  }

  return (
    <div className="container">
      <h1 className="card-title">Contacts</h1>

      <form className="toolbar" onSubmit={handleFilterSubmit}>
        <input
          className="input"
          type="text"
          placeholder="Search name, email, phone"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <input
          className="input"
          type="text"
          placeholder="City"
          value={city}
          onChange={(e) => setCity(e.target.value)}
        />
        <select className="input" value={tagId} onChange={(e) => setTagId(e.target.value)}>
          <option value="">All tags</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
        <button className="button" type="submit">
          Filter
        </button>
        <label className="button button-secondary">
          {importing ? "Importing..." : "Import CSV"}
          <input
            type="file"
            accept=".csv"
            onChange={handleImport}
            disabled={importing}
            className="hidden-file-input"
          />
        </label>
      </form>

      {importMessage && <p className="card-subtitle">{importMessage}</p>}

      <form className="toolbar" onSubmit={handleCreate}>
        <input
          className="input"
          type="email"
          placeholder="Email"
          value={newContact.email ?? ""}
          onChange={(e) => setNewContact({ ...newContact, email: e.target.value })}
        />
        <input
          className="input"
          type="text"
          placeholder="Phone"
          value={newContact.phone ?? ""}
          onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })}
        />
        <input
          className="input"
          type="text"
          placeholder="First name"
          value={newContact.firstName ?? ""}
          onChange={(e) => setNewContact({ ...newContact, firstName: e.target.value })}
        />
        <input
          className="input"
          type="text"
          placeholder="Last name"
          value={newContact.lastName ?? ""}
          onChange={(e) => setNewContact({ ...newContact, lastName: e.target.value })}
        />
        <input
          className="input"
          type="text"
          placeholder="City"
          value={newContact.city ?? ""}
          onChange={(e) => setNewContact({ ...newContact, city: e.target.value })}
        />
        <button className="button" type="submit" disabled={submitting}>
          {submitting ? "Adding..." : "Add contact"}
        </button>
      </form>

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <p>Loading...</p>
      ) : contacts.length === 0 ? (
        <p className="empty-state">No contacts yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>City</th>
              <th>Tag</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((contact) => {
              const isEditing = editingId === contact.id;
              return (
                <tr key={contact.id}>
                  {isEditing ? (
                    <>
                      <td>
                        <input
                          className="input"
                          type="text"
                          placeholder="First name"
                          value={editDraft.firstName ?? ""}
                          onChange={(e) => setEditDraft({ ...editDraft, firstName: e.target.value })}
                        />
                        <input
                          className="input"
                          type="text"
                          placeholder="Last name"
                          value={editDraft.lastName ?? ""}
                          onChange={(e) => setEditDraft({ ...editDraft, lastName: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          type="email"
                          value={editDraft.email ?? ""}
                          onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          type="text"
                          value={editDraft.phone ?? ""}
                          onChange={(e) => setEditDraft({ ...editDraft, phone: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          type="text"
                          value={editDraft.city ?? ""}
                          onChange={(e) => setEditDraft({ ...editDraft, city: e.target.value })}
                        />
                      </td>
                      <td>—</td>
                      <td>
                        <button className="button" type="button" onClick={() => handleSaveEdit(contact.id)}>
                          Save
                        </button>
                        <button className="button button-secondary" type="button" onClick={cancelEdit}>
                          Cancel
                        </button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "—"}</td>
                      <td>{contact.email ?? "—"}</td>
                      <td>{contact.phone ?? "—"}</td>
                      <td>{contact.city ?? "—"}</td>
                      <td>
                        <select
                          className="input"
                          defaultValue=""
                          onChange={(e) => {
                            if (e.target.value) {
                              handleAddTag(contact.id, e.target.value);
                              e.target.value = "";
                            }
                          }}
                        >
                          <option value="" disabled>
                            Add tag
                          </option>
                          {tags.map((tag) => (
                            <option key={tag.id} value={tag.id}>
                              {tag.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <button className="button button-secondary" type="button" onClick={() => startEdit(contact)}>
                          Edit
                        </button>
                        <button className="button button-secondary" type="button" onClick={() => handleDelete(contact.id)}>
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