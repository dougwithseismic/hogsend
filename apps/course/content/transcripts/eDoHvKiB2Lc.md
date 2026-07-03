Email deliverability can be a black box. Why do some emails end up in the spam folder and others in the inbox? While we regularly share deliverability tips one at a time, in this video, we're going to cover 10 pro tips for landing in the inbox. You ready? Let's go. First, the domain you send emails from can significantly impact deliverability.

Generally speaking, you should send from a subdomain instead of your root domain. Sending from a subdomain helps you communicate the email's purpose and can limit any reputation damage to that subdomain. If you use subdomains, you can separate your reputation. In other words, if there's an issue with the subdomain you use for marketing emails, it's less likely to impact your transactional subdomain.

DMARC is an email authentication protocol that tells mail servers what to do if an email fails SPF and DKIM. In this way, it protects against email spoofing. A DMARC record builds trust with mailbox providers as it allows them to verify that your emails are authorized by your domain. We've linked guides below, but let us know if a full tutorial would be helpful.

Third, ensure that the URLs and the body of your email match the sending domain. Mismatched URLs can trigger spam filters since spammers often use this technique. Any images should also match the sending domain. Next, avoid link and open tracking in transactional emails like notifications, magic links, and more. Both can be great for marketing emails but not for transactional ones.

It can actually damage your deliverability. Setting up separate subdomains for transactional and marketing emails can often make it easier to include or remove these practices for different email types. Next, keep emails small and accessible. Gmail, for instance, has a size limit of 102 kilobytes for each email message. Once that limit is reached, the remaining content is clipped.

So avoid bloated emails or emails with a lot of images. Using a plain text version of your email is also good practice. This ensures that your message is accessible to all recipients, including those who have email clients that don't support HTML. Spammers often fish from cousin or lookalike domains, so avoid using them.

Instead of registering an email-specific domain, which can cause brand confusion and look like spam, separate your sending using the subdomains method we covered earlier. When testing, it's tempting to send to fake email addresses to test for bounces, among other things. While testing is important, intentionally hard-bouncing emails can impact deliverability. Because while the emails are fake, the bounces are very real and will damage your reputation.

Instead, you should use a testing email address provided by your email service or create a testing email account. Testing goes together with this next tip, list hygiene. Simply put, only send to those who've asked to be sent to, and don't send to unsubscribers, those who haven't engaged with your content, or those who've marked your previous emails as spam.

Testing should account for all these scenarios. To keep a clean email list, you can capture bounces or spam complaints using a webhook and remove those email addresses from your list. Ninth, don't use no-reply emails as this signals that communication is one-way and diminishes trust with email providers. It tells inboxes that they cannot provide feedback on your emails, like reporting spam.

Finally, mailbox providers are suspicious when you suddenly change the volume of sending. If you want to send millions of emails in a few months, you need to warm up your domain by sending them regularly ahead of time. Otherwise, you risk a large bounce rate and a big hit to your reputation, which can be hard to recover from in the future.

How many of these best practices are you following? And what else would you like to know about email deliverability? Let us know in the comments below. Thanks for watching. Happy sending.
