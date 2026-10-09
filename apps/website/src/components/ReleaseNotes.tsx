import Markdown from 'react-markdown';

export default function ReleaseNotes({ body }: { body: string }) {
  return <Markdown>{body}</Markdown>;
}
