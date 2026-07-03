import transcripts from "@/lib/transcripts.generated.json";

/**
 * Collapsible full transcript for a video, rendered from the committed
 * transcripts manifest (scripts/generate-transcripts.mjs) — so the caption text
 * never passes through the MDX parser and isn't shipped in the client bundle
 * (this is a server component). Authored right under a <VideoEmbed> as the
 * read-instead-of-watch half of a "watch & digest" atom: <VideoTranscript
 * id="<youtube-id>" />. Renders nothing if no transcript exists for the id.
 */

const TRANSCRIPTS = transcripts as Record<string, string>;

export function VideoTranscript({ id }: { id: string }) {
  const text = TRANSCRIPTS[id];
  if (!text) return null;
  const paras = text.split(/\n{2,}/);

  return (
    <details className="group not-prose mb-8 rounded-md border border-white/[0.08] bg-white/[0.01]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm text-white/55 transition-colors hover:text-white/80 [&::-webkit-details-marker]:hidden">
        <span className="text-white/30 transition-transform group-open:rotate-90">
          ▸
        </span>
        Read the transcript
        <span className="text-white/25 text-xs">
          ({paras.length > 1 ? `${text.split(/\s+/).length} words` : "1-min"})
        </span>
      </summary>
      <div className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto border-white/[0.06] border-t px-4 py-4 text-sm text-white/55 leading-relaxed">
        {paras.map((p) => (
          <p key={p.slice(0, 48)}>{p}</p>
        ))}
      </div>
    </details>
  );
}
