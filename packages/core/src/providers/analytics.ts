export interface PostHogService {
  getPersonProperties(distinctId: string): Promise<Record<string, unknown>>;

  captureEvent(opts: CaptureOptions): void;

  identify(distinctId: string, properties: Record<string, unknown>): void;

  isFeatureEnabled(opts: {
    distinctId: string;
    flag: string;
  }): Promise<boolean>;

  shutdown(): Promise<void>;
}

export interface CaptureOptions {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}
