"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// HTML mentah tidak dirender (react-markdown default: skipHtml untuk node html → di-escape).
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
}
