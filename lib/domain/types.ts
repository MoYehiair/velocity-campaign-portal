export type TenantId = 'kilele' | 'karoo' | 'marrakech';
export type Channel = 'email' | 'sms';
export interface Membership {
  user_id: string;
  tenant_id: TenantId;
  email: string;
  role: 'owner' | 'analyst';
}
export interface Campaign {
  external_id: string;
  campaign_name: string;
  channel: Channel;
  target_country: string | null;
  reported_sent: number | null;
  reported_delivered: number | null;
  reported_bounced: number | null;
  reported_opens: number | null;
  reported_clicks: number | null;
  spend: number | null;
  sent_at_utc: string | null;
}
export interface Contact {
  external_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  signup_at: string | null;
  status: string;
  consent_marketing: boolean;
  email_contactable: boolean;
  sms_contactable: boolean;
}
export interface Dashboard {
  customers: number;
  contactable: number;
  email_contactable: number;
  sms_contactable: number;
  campaigns: number;
  signup_days: { day: string; count: number }[];
  as_of: string;
}
export interface SendJob {
  id: string;
  tenant_id: TenantId;
  approval_id: string;
  campaign_external_id: string;
  status: string;
  accepted_count: number;
  rejected_count: number;
  skipped_count: number;
  last_error: string | null;
  created_at: string;
  lease_token: string;
}
export interface Approval {
  id: string;
  campaign_name: string;
  campaign_external_id: string;
  channel: Channel;
  recipient_count: number;
  created_at: string;
  approved_at: string | null;
  expires_at: string;
}
export const brands: Record<
  TenantId,
  { name: string; country: string; timezone: string; initials: string }
> = {
  kilele: {
    name: 'Kilele Rides',
    country: 'Kenya',
    timezone: 'Africa/Nairobi',
    initials: 'KR',
  },
  karoo: {
    name: 'Karoo Coaches',
    country: 'South Africa',
    timezone: 'Africa/Johannesburg',
    initials: 'KC',
  },
  marrakech: {
    name: 'Marrakech Express',
    country: 'Morocco',
    timezone: 'Africa/Casablanca',
    initials: 'ME',
  },
};
