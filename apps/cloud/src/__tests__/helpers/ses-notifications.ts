/**
 * SES event fixtures, copied VERBATIM from AWS's own documentation:
 * "Examples of event data that Amazon SES publishes to Amazon SNS",
 * https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-examples.html
 * (retrieved 2026-08-11).
 *
 * Copied rather than invented on purpose. A normalizer tested against a shape
 * we made up is a normalizer tested against our own assumptions, and the first
 * real bounce is the worst place to find out the wire disagreed. The only
 * additions are the two tenant tags noted inline, which the examples predate.
 *
 * PRD 05 "Seams": replace these with captured production notifications once a
 * live SES account exists (PRD 01) if they differ.
 */

/** Deep-clone so a test that mutates a fixture cannot poison the next one. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** AWS's Bounce record, verbatim. */
export function sesBounceNotification(): Record<string, unknown> {
  return clone({
    eventType: "Bounce",
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [
        {
          emailAddress: "recipient@example.com",
          action: "failed",
          status: "5.1.1",
          diagnosticCode: "smtp; 550 5.1.1 user unknown",
        },
      ],
      timestamp: "2017-08-05T00:41:02.669Z",
      feedbackId:
        "01000157c44f053b-61b59c11-9236-11e6-8f96-7be8aexample-000000",
      reportingMTA: "dsn; mta.example.com",
    },
    mail: {
      timestamp: "2017-08-05T00:40:02.012Z",
      source: "Sender Name <sender@example.com>",
      sourceArn:
        "arn:aws:ses:us-east-1:123456789012:identity/sender@example.com",
      sendingAccountId: "123456789012",
      messageId: "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000",
      destination: ["recipient@example.com"],
      headersTruncated: false,
      headers: [
        { name: "From", value: "Sender Name <sender@example.com>" },
        { name: "To", value: "recipient@example.com" },
        { name: "Subject", value: "Message sent from Amazon SES" },
        { name: "MIME-Version", value: "1.0" },
        {
          name: "Content-Type",
          value:
            'multipart/alternative; boundary="----=_Part_7307378_1629847660.1516840721503"',
        },
      ],
      commonHeaders: {
        from: ["Sender Name <sender@example.com>"],
        to: ["recipient@example.com"],
        messageId:
          "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000",
        subject: "Message sent from Amazon SES",
      },
      tags: {
        "ses:configuration-set": ["ConfigSet"],
        "ses:source-ip": ["192.0.2.0"],
        "ses:from-domain": ["example.com"],
        "ses:caller-identity": ["ses_user"],
      },
    },
  });
}

/** AWS's Complaint record, verbatim. */
export function sesComplaintNotification(): Record<string, unknown> {
  return clone({
    eventType: "Complaint",
    complaint: {
      complainedRecipients: [{ emailAddress: "recipient@example.com" }],
      timestamp: "2017-08-05T00:41:02.669Z",
      feedbackId:
        "01000157c44f053b-61b59c11-9236-11e6-8f96-7be8aexample-000000",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36",
      complaintFeedbackType: "abuse",
      arrivalDate: "2017-08-05T00:41:02.669Z",
    },
    mail: {
      timestamp: "2017-08-05T00:40:01.123Z",
      source: "Sender Name <sender@example.com>",
      sourceArn:
        "arn:aws:ses:us-east-1:123456789012:identity/sender@example.com",
      sendingAccountId: "123456789012",
      messageId: "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000",
      destination: ["recipient@example.com"],
      headersTruncated: false,
      headers: [
        { name: "From", value: "Sender Name <sender@example.com>" },
        { name: "To", value: "recipient@example.com" },
        { name: "Subject", value: "Message sent from Amazon SES" },
        { name: "MIME-Version", value: "1.0" },
        {
          name: "Content-Type",
          value:
            'multipart/alternative; boundary="----=_Part_7298998_679725522.1516840859643"',
        },
      ],
      commonHeaders: {
        from: ["Sender Name <sender@example.com>"],
        to: ["recipient@example.com"],
        messageId:
          "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000",
        subject: "Message sent from Amazon SES",
      },
      tags: {
        "ses:configuration-set": ["ConfigSet"],
        "ses:source-ip": ["192.0.2.0"],
        "ses:from-domain": ["example.com"],
        "ses:caller-identity": ["ses_user"],
      },
    },
  });
}

/** AWS's Delivery record, verbatim. */
export function sesDeliveryNotification(): Record<string, unknown> {
  return clone({
    eventType: "Delivery",
    mail: {
      timestamp: "2016-10-19T23:20:52.240Z",
      source: "sender@example.com",
      sourceArn:
        "arn:aws:ses:us-east-1:123456789012:identity/sender@example.com",
      sendingAccountId: "123456789012",
      messageId: "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000",
      destination: ["recipient@example.com"],
      headersTruncated: false,
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "recipient@example.com" },
        { name: "Subject", value: "Message sent from Amazon SES" },
        { name: "MIME-Version", value: "1.0" },
        { name: "Content-Type", value: "text/html; charset=UTF-8" },
        { name: "Content-Transfer-Encoding", value: "7bit" },
      ],
      commonHeaders: {
        from: ["sender@example.com"],
        to: ["recipient@example.com"],
        messageId:
          "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000",
        subject: "Message sent from Amazon SES",
      },
      tags: {
        "ses:configuration-set": ["ConfigSet"],
        "ses:source-ip": ["192.0.2.0"],
        "ses:from-domain": ["example.com"],
        "ses:caller-identity": ["ses_user"],
        "ses:outgoing-ip": ["192.0.2.0"],
        myCustomTag1: ["myCustomTagValue1"],
        myCustomTag2: ["myCustomTagValue2"],
      },
    },
    delivery: {
      timestamp: "2016-10-19T23:21:04.133Z",
      processingTimeMillis: 11893,
      recipients: ["recipient@example.com"],
      smtpResponse: "250 2.6.0 Message received",
      remoteMtaIp: "123.456.789.012",
      reportingMTA: "mta.example.com",
    },
  });
}

/** AWS's DeliveryDelay record, verbatim. */
export function sesDeliveryDelayNotification(): Record<string, unknown> {
  return clone({
    eventType: "DeliveryDelay",
    mail: {
      timestamp: "2020-06-16T00:15:40.641Z",
      source: "sender@example.com",
      sourceArn:
        "arn:aws:ses:us-east-1:123456789012:identity/sender@example.com",
      sendingAccountId: "123456789012",
      messageId: "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000",
      destination: ["recipient@example.com"],
      headersTruncated: false,
      tags: { "ses:configuration-set": ["ConfigSet"] },
    },
    deliveryDelay: {
      timestamp: "2020-06-16T00:25:40.095Z",
      delayType: "TransientCommunicationFailure",
      expirationTime: "2020-06-16T00:25:40.914Z",
      delayedRecipients: [
        {
          emailAddress: "recipient@example.com",
          status: "4.4.1",
          diagnosticCode: "smtp; 421 4.4.1 Unable to connect to remote host",
        },
      ],
    },
  });
}

/** AWS's Send record, verbatim — one of the types we deliberately DROP. */
export function sesSendNotification(): Record<string, unknown> {
  return clone({
    eventType: "Send",
    mail: {
      timestamp: "2016-10-14T05:02:16.645Z",
      source: "sender@example.com",
      sendingAccountId: "123456789012",
      messageId: "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000",
      destination: ["recipient@example.com"],
      headersTruncated: false,
      tags: { "ses:configuration-set": ["ConfigSet"] },
    },
    send: {},
  });
}

/** AWS's Open record, trimmed to the shape the normalizer sees. Never consumed. */
export function sesOpenNotification(): Record<string, unknown> {
  return clone({
    eventType: "Open",
    mail: {
      timestamp: "2017-08-09T21:59:49.927Z",
      source: "sender@example.com",
      sendingAccountId: "123456789012",
      messageId: "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000",
      destination: ["recipient@example.com"],
      headersTruncated: false,
      tags: { "ses:configuration-set": ["ConfigSet"] },
    },
    open: {
      ipAddress: "192.0.2.1",
      timestamp: "2017-08-09T22:00:19.652Z",
      userAgent: "Mozilla/5.0",
      isBotEvent: "Unlikely",
    },
  });
}

/** AWS's Click record, trimmed. Never consumed — clicks are first-party. */
export function sesClickNotification(): Record<string, unknown> {
  return clone({
    eventType: "Click",
    click: {
      ipAddress: "192.0.2.1",
      link: "https://example.com/",
      timestamp: "2017-08-09T23:51:25.570Z",
      userAgent: "Mozilla/5.0",
      isBotEvent: "Likely",
    },
    mail: {
      timestamp: "2017-08-09T23:50:05.795Z",
      source: "sender@example.com",
      sendingAccountId: "123456789012",
      messageId: "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000",
      destination: ["recipient@example.com"],
      headersTruncated: false,
      tags: { "ses:configuration-set": ["ConfigSet"] },
    },
  });
}

/**
 * Re-tag a fixture for one environment, the way a real send through this
 * control plane's configuration set arrives.
 *
 * `ses:tenant-name` is SES's own auto-tag on tenanted sends and
 * `ses:configuration-set` is the one every example above already carries; both
 * are `env-<environmentId>` here (`src/ses/names.ts`).
 */
export function tagForEnvironment(
  notification: Record<string, unknown>,
  environmentId: string,
  opts: { tenantTag?: boolean } = {},
): Record<string, unknown> {
  const mail = notification.mail as Record<string, unknown>;
  const tags = { ...((mail.tags as Record<string, string[]>) ?? {}) };
  tags["ses:configuration-set"] = [`env-${environmentId}`];
  if (opts.tenantTag !== false)
    tags["ses:tenant-name"] = [`env-${environmentId}`];
  return { ...notification, mail: { ...mail, tags } };
}

let messageSeq = 0;

/**
 * Give a fixture its own `mail.messageId`.
 *
 * Every example above carries AWS's one placeholder id, so two fixtures are the
 * SAME event as far as the dedupe key is concerned — which is correct, and
 * which makes two tests sharing an id collide on the unique index. A test that
 * wants a distinct event asks for one; a test exercising redelivery reuses one
 * object deliberately.
 */
export function withFreshMessageId(
  notification: Record<string, unknown>,
): Record<string, unknown> {
  messageSeq += 1;
  const mail = notification.mail as Record<string, unknown>;
  return {
    ...notification,
    mail: { ...mail, messageId: `test-message-${messageSeq}` },
  };
}
