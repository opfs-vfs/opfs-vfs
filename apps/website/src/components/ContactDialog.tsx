import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

export default function ContactDialog() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const show = (event: Event) => {
      trigger.current = (event as CustomEvent<HTMLElement>).detail;
      setStatus('idle');
      setOpen(true);
    };
    window.addEventListener('opfs:contact', show);
    return () => window.removeEventListener('opfs:contact', show);
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setStatus('sending');
    const values = Object.fromEntries(new FormData(form));
    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!response.ok) throw new Error();
      setStatus('sent');
      form.reset();
    } catch {
      setStatus('error');
    }
  };
  const changeOpen = (next: boolean) => {
    if (status === 'sending') return;
    setOpen(next);
    if (!next) requestAnimationFrame(() => trigger.current?.focus());
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <form className="contact-form" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Get in touch</DialogTitle>
            <DialogDescription>Tell us what you’re building with OPFS VFS.</DialogDescription>
          </DialogHeader>
          {status === 'sent' ? (
            <p className="contact-status" role="status">
              Thanks, your message is on its way.
            </p>
          ) : (
            <>
              <label>
                Email <Input name="email" type="email" autoComplete="email" maxLength={254} required />
              </label>
              <label>
                Name <Input name="name" autoComplete="name" maxLength={120} required />
              </label>
              <label>
                Company <span className="contact-optional">Optional</span>
                <Input name="company" autoComplete="organization" maxLength={120} />
              </label>
              <label>
                Message <Textarea name="message" rows={6} maxLength={10_000} required />
              </label>
              {status === 'error' && (
                <p className="contact-status" role="alert">
                  We couldn’t send that. Please try again.
                </p>
              )}
              <DialogFooter>
                <Button type="submit" disabled={status === 'sending'}>
                  {status === 'sending' ? 'Sending…' : 'Send message'}
                </Button>
              </DialogFooter>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
