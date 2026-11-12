import './styles.css';
export { FilePreview, TextEditor, type PreviewExtension, type PreviewProps } from './FilePreview.tsx';
export { canEdit, fileSize, MAX_PREVIEW_BYTES, type PreviewFile } from './preview-policy.ts';
export { setPdfWorkerSrc } from './pdf-worker-src.ts';
