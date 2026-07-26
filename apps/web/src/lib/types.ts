import type {
  Contact,
  Tag,
  ImportSummary,
  Audience,
  AudienceFilter,
  Campaign,
  CampaignStatus,
  SelectionType,
  SelectionValue,
  CampaignAnalytics,
} from "@email-app/shared";

export type {
  Contact,
  Tag,
  Audience,
  AudienceFilter,
  Campaign,
  CampaignStatus,
  SelectionType,
  SelectionValue,
  CampaignAnalytics,
};

export interface User {
  id: string;
  email: string;
}

export interface AccountSummary {
  id: string;
  name: string;
}

export interface SignupResponse {
  user: User;
  account: AccountSummary;
}

export interface LoginResponse {
  user: User;
}

export interface MeResponse {
  id: string;
  email: string;
  accountId: string;
}

export interface ContactInput {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  customFields?: Record<string, unknown>;
}

export interface CreateTagInput {
  name: string;
}

export interface ContactCreateResult {
  merged: boolean;
  message: string;
}

export interface ImportResult extends ImportSummary {
  message: string;
}

export interface GetContactsParams {
  city?: string;
  tagId?: string;
  search?: string;
}

// --- Audiences ---

export interface AudienceInput {
  name: string;
  filter: AudienceFilter;
}

// --- Campaigns ---

export interface CampaignInput {
  name: string;
  subject: string;
  bodyHtml: string;
  selectionType: SelectionType;
  selectionValue: SelectionValue;
}

export interface ResolveRecipientsInput {
  selectionType: SelectionType;
  selectionValue: SelectionValue;
}

// Shape returned by POST /api/campaigns/resolve-recipients. Matched
// contacts carry rawInput only for the pasted_list case (audience/tag
// matches have no corresponding raw line), so it stays optional.
export interface ResolvedContact {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  rawInput?: string;
}

export interface ResolveRecipientsResult {
  matched: ResolvedContact[];
  unmatched: { rawInput: string; reason: string }[];
}

export interface SendCampaignInput {
  scheduledAt?: string;
}