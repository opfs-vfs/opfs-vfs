import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './button';
import { Input } from './input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';

type Request = {
  title: string;
  description?: string;
  initial?: string;
  input?: boolean;
  destructive?: boolean;
  action?: string;
};
export function useActionDialog() {
  const [request, setRequest] = useState<Request | null>(null);
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const pending = useRef<((value: string | null) => void) | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const previousFocusRoot = useRef<Document | ShadowRoot>(null);
  const finish = useCallback((value: string | null) => {
    const resolve = pending.current;
    pending.current = null;
    setOpen(false);
    resolve?.(value);
  }, []);
  useEffect(
    () => () => {
      pending.current?.(null);
      pending.current = null;
    },
    [],
  );
  const ask = useCallback((options: Request) => {
    if (pending.current) return Promise.resolve(null);
    // The explorer keeps its focused row inside a shadow root.
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    previousFocus.current = focused instanceof HTMLElement ? focused : null;
    const root = focused?.getRootNode();
    previousFocusRoot.current = root instanceof ShadowRoot || root instanceof Document ? root : null;
    setValue(options.initial ?? '');
    setRequest(options);
    setOpen(true);
    return new Promise<string | null>((resolve) => {
      pending.current = resolve;
    });
  }, []);
  const confirmAction = useCallback(
    async (title: string, description?: string) =>
      (await ask({ title, description, destructive: true, action: 'Continue' })) !== null,
    [ask],
  );
  const invalidName = !value.trim() || ['.', '..'].includes(value.trim()) || /[/\\]/.test(value);
  const dialog = (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogContent
        showCloseButton={false}
        finalFocus={() => {
          const target = previousFocus.current;
          return target?.isConnected
            ? target
            : target?.id
              ? previousFocusRoot.current?.getElementById(target.id)
              : false;
        }}
      >
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!request?.input || !invalidName) finish(request?.input ? value.trim() : 'confirmed');
          }}
        >
          <DialogHeader>
            <DialogTitle>{request?.title}</DialogTitle>
            <DialogDescription>
              {request?.description ??
                (request?.input
                  ? 'Use a name without slashes. Existing files will not be overwritten.'
                  : 'This action changes the selected files or volume.')}
            </DialogDescription>
          </DialogHeader>
          {request?.input && (
            <Input
              aria-label={request.title}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              maxLength={255}
              autoFocus
            />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" autoFocus={!request?.input} onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={request?.destructive ? 'destructive' : 'default'}
              disabled={request?.input && invalidName}
            >
              {request?.action ?? (request?.input ? 'Save' : 'Continue')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
  return { ask, confirmAction, dialog };
}
