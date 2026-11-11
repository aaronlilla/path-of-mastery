import { TimelineEditor } from './TimelineEditor';
import { TimelineLibrary } from './TimelineLibrary';
import type { TimelineEditorProps, TimelineLibraryProps } from './types.js';
import './timelines.css';
export function TimelineArea({ library, editor, objectKey }: { library: TimelineLibraryProps; editor?: TimelineEditorProps; objectKey?: string }) {
  return editor ? <TimelineEditor key={objectKey} {...editor} /> : <TimelineLibrary {...library} />;
}
