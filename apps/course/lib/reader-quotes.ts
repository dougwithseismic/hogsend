import type { ReaderQuote } from "@/components/ds/reader-quotes";

/**
 * Real reader feedback, verbatim — shared by the catalog and the flagship
 * landing page. Append new quotes as they arrive; the ReaderQuotes section
 * renders one as a pull-quote and several as a grid. Never add a quote that
 * wasn't actually said by a real reader.
 */
export const READER_QUOTES: ReaderQuote[] = [
  {
    quote:
      "I can see some real value in here. There is a ton of content — I'm quite shocked that it's so free. The first two chapters were amazing.",
    name: "Will",
    role: "Early reader",
  },
];
