import { Badge } from './ui/badge';

type Note = { id: string; title: string; excerpt: string; pinned: boolean; updated: string };

export function NoteListItem({ note, active }: { note: Note; active: boolean }) {
  return (
    <li
      className={
        active
          ? 'rounded-[6px] bg-[oklch(0.97_0_0)] p-[13px]'
          : 'rounded-[6px] p-[13px] hover:bg-[#f5f5f5]'
      }
    >
      <div className="flex items-center justify-between gap-[10px]">
        <span className="truncate text-[15px] font-medium text-[#0a0a0a]">{note.title}</span>
        {note.pinned && <Badge>Pinned</Badge>}
      </div>
      <p className="mt-[4px] line-clamp-2 text-[13px]/5 text-[#737373]">{note.excerpt}</p>
      <time className="mt-[6px] block text-xs text-[#a1a1a1]">{note.updated}</time>
    </li>
  );
}
