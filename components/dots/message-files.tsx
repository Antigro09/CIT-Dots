import { Download, FileText } from "lucide-react";
import type { Message } from "@/src/shared/types";

export function fileSizeLabel(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function MessageFiles({
  files,
}: {
  files: NonNullable<Message["files"]>;
}) {
  return (
    <div className="attachment-list" aria-label="Files shared with you">
      {files.map((file) => (
        <a
          className="attachment"
          href={`/api/local/files/${encodeURIComponent(file.id)}`}
          download={file.name}
          key={file.id}
          aria-label={`Download ${file.name}, ${fileSizeLabel(file.size)}`}
          title={`Download ${file.name} · ${fileSizeLabel(file.size)}`}
        >
          <FileText size={14} aria-hidden="true" />
          <span>{file.name}</span>
          <span>{fileSizeLabel(file.size)}</span>
          <Download size={12} aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}
