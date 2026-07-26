import type {
  LoginResponse,
  MeResponse,
  SignupResponse,
  Contact,
  Tag,
  ContactInput,
  CreateTagInput,
  ContactCreateResult,
  ImportResult,
  GetContactsParams,
  Audience,
  AudienceInput,
  Campaign,
  CampaignInput,
  CampaignAnalytics,
  ResolveRecipientsInput,
  ResolveRecipientsResult,
  ResolvedContact,
  SendCampaignInput,
} from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(res.status, data.error || "Request failed");
  }

  return data as T;
}

// Maps a raw contacts table row (snake_case) to the Contact shape used
// throughout the frontend. Only lists known top-level columns —
// custom_fields is passed through untouched, since it holds arbitrary
// user-defined keys (e.g. from CSV import) that must not be rewritten.
function mapContact(row: Record<string, any>): Contact {
  return {
    id: row.id,
    accountId: row.account_id,
    email: row.email,
    phone: row.phone,
    firstName: row.first_name,
    lastName: row.last_name,
    city: row.city,
    customFields: row.custom_fields,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTag(row: Record<string, any>): Tag {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
  };
}

// memberCount arrives already camelCase — the audiences router spreads it
// onto the row in JS (`{ ...row, memberCount }`) rather than selecting it
// as a SQL column, so it's the one field on this row that isn't
// snake_case. filter is jsonb and comes back already parsed by pg.
function mapAudience(row: Record<string, any>): Audience {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    filter: row.filter,
    memberCount: row.memberCount,
  };
}

function mapCampaign(row: Record<string, any>): Campaign {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    subject: row.subject,
    bodyHtml: row.body_html,
    status: row.status,
    selectionType: row.selection_type,
    selectionValue: row.selection_value,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
  };
}

// Maps a row from POST /resolve-recipients, which returns raw SQL
// columns (first_name/last_name/raw_input) rather than a mapped Contact —
// that endpoint is a lightweight preview, not the contacts resource, so
// it never goes through mapContact.
function mapResolvedContact(row: Record<string, any>): ResolvedContact {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    firstName: row.first_name,
    lastName: row.last_name,
    rawInput: row.raw_input ?? undefined,
  };
}

export function signup(accountName: string, email: string, password: string) {
  return request<SignupResponse>("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ accountName, email, password }),
  });
}

export function login(email: string, password: string) {
  return request<LoginResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function logout() {
  return request<void>("/api/auth/logout", { method: "POST" });
}

export function me() {
  return request<MeResponse>("/api/auth/me");
}

export function getContacts(params?: GetContactsParams): Promise<Contact[]> {
  const query = new URLSearchParams();
  if (params?.city) query.set("city", params.city);
  if (params?.tagId) query.set("tagId", params.tagId);
  if (params?.search) query.set("search", params.search);
  const qs = query.toString();

  return request<Record<string, any>[]>(`/api/contacts${qs ? `?${qs}` : ""}`).then((rows) =>
    rows.map(mapContact)
  );
}

export function createContact(input: ContactInput): Promise<ContactCreateResult> {
  return request<ContactCreateResult>("/api/contacts", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateContact(id: string, input: ContactInput): Promise<Contact> {
  return request<Record<string, any>>(`/api/contacts/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }).then(mapContact);
}

export function deleteContact(id: string): Promise<void> {
  return request<void>(`/api/contacts/${id}`, { method: "DELETE" });
}

export function addTagToContact(contactId: string, tagId: string): Promise<void> {
  return request<void>(`/api/contacts/${contactId}/tags`, {
    method: "POST",
    body: JSON.stringify({ tagId }),
  });
}

export function removeTagFromContact(contactId: string, tagId: string): Promise<void> {
  return request<void>(`/api/contacts/${contactId}/tags/${tagId}`, {
    method: "DELETE",
  });
}

// Deliberately does not use request(): a multipart upload must let the
// browser set its own Content-Type (with boundary), and request() always
// forces Content-Type: application/json. This is the one place that
// talks to fetch directly rather than through the shared helper.
export async function importContacts(file: File): Promise<ImportResult> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_URL}/api/contacts/import`, {
    method: "POST",
    credentials: "include",
    body: formData,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(res.status, data.error || "Import failed");
  }

  return data as ImportResult;
}

export function getTags(): Promise<Tag[]> {
  return request<Record<string, any>[]>("/api/tags").then((rows) => rows.map(mapTag));
}

export function createTag(input: CreateTagInput): Promise<Tag> {
  return request<Record<string, any>>("/api/tags", {
    method: "POST",
    body: JSON.stringify(input),
  }).then(mapTag);
}

export function deleteTag(id: string): Promise<void> {
  return request<void>(`/api/tags/${id}`, { method: "DELETE" });
}

// --- Audiences ---

export function getAudiences(): Promise<Audience[]> {
  return request<Record<string, any>[]>("/api/audiences").then((rows) => rows.map(mapAudience));
}

export function createAudience(input: AudienceInput): Promise<Audience> {
  return request<Record<string, any>>("/api/audiences", {
    method: "POST",
    body: JSON.stringify(input),
  }).then(mapAudience);
}

export function updateAudience(id: string, input: AudienceInput): Promise<Audience> {
  return request<Record<string, any>>(`/api/audiences/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }).then(mapAudience);
}

export function deleteAudience(id: string): Promise<void> {
  return request<void>(`/api/audiences/${id}`, { method: "DELETE" });
}

// --- Campaigns ---

export function getCampaigns(): Promise<Campaign[]> {
  return request<Record<string, any>[]>("/api/campaigns").then((rows) => rows.map(mapCampaign));
}

export function getCampaign(id: string): Promise<Campaign> {
  return request<Record<string, any>>(`/api/campaigns/${id}`).then(mapCampaign);
}

export function createCampaign(input: CampaignInput): Promise<Campaign> {
  return request<Record<string, any>>("/api/campaigns", {
    method: "POST",
    body: JSON.stringify(input),
  }).then(mapCampaign);
}

export function updateCampaign(id: string, input: CampaignInput): Promise<Campaign> {
  return request<Record<string, any>>(`/api/campaigns/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }).then(mapCampaign);
}

export function deleteCampaign(id: string): Promise<void> {
  return request<void>(`/api/campaigns/${id}`, { method: "DELETE" });
}

export function resolveRecipients(input: ResolveRecipientsInput): Promise<ResolveRecipientsResult> {
  return request<{
    matched: Record<string, any>[];
    unmatched: { raw_input: string; reason: string }[];
  }>("/api/campaigns/resolve-recipients", {
    method: "POST",
    body: JSON.stringify(input),
  }).then((result) => ({
    matched: result.matched.map(mapResolvedContact),
    unmatched: result.unmatched.map((u) => ({ rawInput: u.raw_input, reason: u.reason })),
  }));
}

export function sendCampaign(id: string, input: SendCampaignInput = {}): Promise<Campaign> {
  return request<Record<string, any>>(`/api/campaigns/${id}/send`, {
    method: "POST",
    body: JSON.stringify(input),
  }).then(mapCampaign);
}

export function cancelSchedule(id: string): Promise<Campaign> {
  return request<Record<string, any>>(`/api/campaigns/${id}/cancel-schedule`, {
    method: "POST",
  }).then(mapCampaign);
}

// CampaignAnalytics is already built camelCase server-side (see
// GET /:id/analytics in campaigns.ts), so no mapper is needed here.
export function getCampaignAnalytics(id: string): Promise<CampaignAnalytics> {
  return request<CampaignAnalytics>(`/api/campaigns/${id}/analytics`);
}