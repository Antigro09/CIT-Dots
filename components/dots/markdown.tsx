"use client";

import { Streamdown } from "streamdown";

export function Markdown({ content }: { content: string }) {
  return (
    <Streamdown skipHtml controls={false} className="dots-markdown">
      {content}
    </Streamdown>
  );
}
