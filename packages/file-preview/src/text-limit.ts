import { EditorState } from '@codemirror/state';
import { MAX_PREVIEW_BYTES } from './preview-policy.ts';

export const textFits = (value: string) =>
  value.length <= MAX_PREVIEW_BYTES && new TextEncoder().encode(value).byteLength <= MAX_PREVIEW_BYTES;
export function limitTextChanges(onLimit: (limited: boolean) => void) {
  return EditorState.transactionFilter.of((transaction) => {
    if (!transaction.docChanged) return transaction;
    const limited = !textFits(transaction.newDoc.toString());
    onLimit(limited);
    return limited ? [] : transaction;
  });
}
