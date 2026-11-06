import { memo } from "react";

import { Button } from "../ui/button";

const SKILL_ONLY_REPLY = /^\$[\w.:-]+$/;

/** A reply that is only a skill, such as `$pstack:bro`, reads as its slash command `/bro`. */
function quickReplyLabel(reply: string): string {
  const trimmed = reply.trim();
  return SKILL_ONLY_REPLY.test(trimmed) ? `/${trimmed.slice(1).split(":").at(-1)}` : reply;
}

export const ComposerQuickReplies = memo(function ComposerQuickReplies(props: {
  readonly replies: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onSelect: (reply: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Quick replies"
      className="flex gap-1.5 overflow-x-auto px-1 pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {props.replies.map((reply, index) => (
        <Button
          // oxlint-disable-next-line react/no-array-index-key -- replies are free text and may repeat
          key={`${index}:${reply}`}
          variant="glass"
          size="xs"
          className="max-w-64"
          title={reply}
          disabled={props.disabled}
          // Keeps focus, and the mobile keyboard, on the composer.
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => props.onSelect(reply)}
        >
          <span className="truncate">{quickReplyLabel(reply)}</span>
        </Button>
      ))}
    </div>
  );
});
