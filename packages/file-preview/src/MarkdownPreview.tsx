import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { lazy } from 'react';
import { fileSize } from './preview-policy';
import type { PreviewProps } from './FilePreview';
const TextEditor = lazy(() => import('./TextEditor'));
const BinaryPreview = lazy(() => import('./BinaryPreview'));
export default function MarkdownPreview({ file }: PreviewProps) {
  if (file.bytes) return <BinaryPreview file={file} />;
  // ponytail: large Markdown uses the virtualized source view; AST rendering is bounded to 256 KiB.
  if (fileSize(file) > 256 * 1024) return <TextEditor path={file.path} value={file.content} preview />;
  return (
    <div className="fp-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ alt }) => <span>[image: {alt || 'blocked'}]</span>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {file.content}
      </ReactMarkdown>
    </div>
  );
}
