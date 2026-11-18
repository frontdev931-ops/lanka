export interface WebsiteRequest {
  id: string;
  websiteOrigin: string;
  createdAt: string;
  installedAt: string | null;
  handledAt: string | null;
}
