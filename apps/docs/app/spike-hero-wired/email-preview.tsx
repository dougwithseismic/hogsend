import type { EmailPreview } from "./minted-files";

/* ==========================================================================
 *  SPIKE — an email window shows the rendered template, not its source.
 *
 *  A journey file answers "what runs"; the email answers "what lands in the
 *  inbox". Showing source for both wastes the second window. This renders a
 *  light-on-dark client chrome (from / subject / preheader) over a white
 *  email body, which is how these actually arrive.
 * ========================================================================== */

export function EmailPane({ email }: { email: EmailPreview }) {
  return (
    <div className="h-full overflow-auto [scrollbar-width:thin]">
      {/* client chrome */}
      <div className="border-white/[0.08] border-b px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] text-white/35 uppercase tracking-[0.08em]">
            From
          </span>
          <span className="text-[12px] text-white/70">
            Hogsend &lt;hello@hogsend.com&gt;
          </span>
        </div>
        <p className="mt-1.5 font-medium text-[14px] text-white/90">
          {email.subject}
        </p>
        <p className="mt-0.5 text-[12px] text-white/40">{email.preheader}</p>
      </div>

      {/* the email body, as it renders */}
      <div className="p-4">
        <div className="rounded-[6px] bg-white px-6 py-7 text-[#1c1917]">
          <p className="font-mono text-[10px] text-[#f64838] uppercase tracking-[0.1em]">
            Hogsend
          </p>

          <h3 className="mt-4 font-semibold text-[19px] leading-[1.25] tracking-[-0.01em]">
            {email.heading}
          </h3>

          {email.body.map((paragraph) => (
            <p
              key={paragraph.slice(0, 32)}
              className="mt-3 text-[13.5px] leading-[1.6] text-[#44403c]"
            >
              {paragraph}
            </p>
          ))}

          {email.cta ? (
            <div className="mt-6">
              <span className="inline-block rounded-[5px] bg-[#f64838] px-4 py-2.5 font-medium text-[13px] text-white">
                {email.cta.label}
              </span>
              {email.cta.note ? (
                <p className="mt-2 text-[11px] text-[#78716c]">
                  {email.cta.note}
                </p>
              ) : null}
            </div>
          ) : null}

          {email.footer ? (
            <p className="mt-7 border-[#e7e5e4] border-t pt-4 text-[11px] text-[#a8a29e]">
              {email.footer} · <span className="underline">Unsubscribe</span>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
