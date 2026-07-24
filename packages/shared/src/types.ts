export interface Account {
  id: string;
  name: string;
  createdAt: string;
}

export interface Contact {
  id: string;
  accountId: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  city: string | null;
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Tag {
  id: string;
  accountId: string;
  name: string;
}

export interface AudienceFilter {
  tagIds?: string[];
  city?: string;
  customFields?: Record<string, unknown>;
}

export interface Audience {
  id: string;
  accountId: string;
  name: string;
  filter: AudienceFilter;
  memberCount?: number; // computed, not stored
}

export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "failed";
export type SelectionType = "audience" | "tag" | "pasted_list";

export type SelectionValue =
  | { audienceId: string }
  | { tagId: string }
  | { lines: string[] };

export interface Campaign {
  id: string;
  accountId: string;
  name: string;
  subject: string;
  bodyHtml: string;
  status: CampaignStatus;
  selectionType: SelectionType;
  selectionValue: SelectionValue;
  scheduledAt: string | null;
  sentAt: string | null;
}

export type RecipientStatus = "pending" | "sent" | "delivered" | "opened" | "failed";

export interface CampaignRecipient {
  id: string;
  campaignId: string;
  contactId: string | null;
  rawInput: string | null;
  matched: boolean;
  status: RecipientStatus;
  providerMessageId: string | null;
}

export interface CampaignAnalytics {
  campaignId: string;
  totalRecipients: number;
  sent: number;
  delivered: number;
  opened: number;
}

export interface ImportSummary {
  added: number;
  merged: number;
  skippedInvalid: number;
}
