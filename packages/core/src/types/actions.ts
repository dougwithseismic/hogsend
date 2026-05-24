export interface SendEmailAction {
  type: "send_email";
  templateKey: string;
  subject: string;
  category?: string;
}

export interface FireEventAction {
  type: "fire_event";
  eventName: string;
  properties?: Record<string, unknown>;
}

export interface WebhookAction {
  type: "webhook";
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface EnrollJourneyAction {
  type: "enroll_journey";
  journeyId: string;
}

export type JourneyAction =
  | SendEmailAction
  | FireEventAction
  | WebhookAction
  | EnrollJourneyAction;
