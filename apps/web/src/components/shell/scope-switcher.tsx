'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * One switchable segment of the scope chain.
 *
 * THE SCOPE CHAIN
 *   The header's left edge is a chain of segments, one per level of the tenancy
 *   model, and how many you get is decided by who you are. A doctor gets a
 *   branch. An org owner gets their clinic and a branch. A super admin gets a
 *   *switchable* clinic and then a branch. So the header renders ADR-0001
 *   literally — organization is the tenant, branch is the place — rather than
 *   decorating the gap between them.
 *
 *   That is why this component is generic over what it switches. A second
 *   dropdown with its own markup for clinics would let the two drift, and the
 *   whole point is that a clinic and a branch look like the same kind of thing
 *   because they *are* the same kind of thing: the scope this session acts in.
 *
 * A SWITCH IS A SERVER ROUND TRIP, NEVER A FILTER
 *   Which scope you are in decides what you can see and what you can do, so it
 *   is a re-issued token, not client state. The caller owns that call; this
 *   component owns the disclosure. `onSwitch` is not given the chance to be
 *   optimistic — the menu closes, `pending` disables everything, and the caller
 *   navigates when the server has agreed.
 *
 * One option is not a choice. With a single scope the control renders as a plain
 * label with no affordance, because offering a menu that cannot change anything
 * is a lie about what is available.
 */

export interface ScopeOption {
  id: string;
  name: string;
  /** The identifier line under the name — a code, a subdomain, a city. */
  detail?: string | null;
}

export function ScopeSwitcher({
  label,
  options,
  currentId,
  placeholder,
  pending = false,
  onSwitch,
  confirm,
}: {
  /** What this segment names: 'Clinic', 'Branch'. Sentence case, singular. */
  label: string;
  options: ScopeOption[];
  currentId: string | null;
  /** Shown when nothing is selected yet. An instruction, not a dash. */
  placeholder: string;
  pending?: boolean;
  /** Called on a plain pick. Not called at all when `confirm` is supplied. */
  onSwitch: (id: string) => void;
  /**
   * Turns the popover into two steps: pick, then confirm.
   *
   * Entering a clinic needs a stated reason (ADR-0012), and switching branch does
   * not. Rather than build a second dropdown for the one that asks a question —
   * with its own markup, its own focus handling and its own chance to drift — the
   * caller supplies the second step and it renders inside this same popover,
   * anchored to this same control. Return the form; call `cancel` to go back to
   * the list.
   */
  confirm?: (option: ScopeOption, cancel: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const listId = useId();

  const current = options.find((option) => option.id === currentId);
  const confirming = options.find((option) => option.id === confirmingId);

  /*
   * With a confirm step there is always something to do — restating the reason for
   * the clinic you are already in is a legitimate re-entry — so a single option is
   * still a choice. Without one, picking the scope you are already in does
   * nothing, and a menu that cannot change anything should not open.
   */
  const switchable = options.length > 1 || Boolean(confirm);

  const close = (): void => {
    setOpen(false);
    setConfirmingId(null);
  };

  /*
   * Escape closes it and a click elsewhere closes it. Both are what anyone
   * expects of a menu, and neither was here before — a dropdown that can only be
   * dismissed by re-clicking the exact button it came from is a trap on a narrow
   * screen, where that button may well have scrolled away.
   */
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      close();
      // Focus goes back where it came from, or it lands on the document body and
      // a keyboard user has to tab in from the top of the page again.
      container.current?.querySelector('button')?.focus();
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (container.current?.contains(event.target as Node)) return;
      close();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={pending || !switchable}
        aria-expanded={switchable ? open : undefined}
        aria-haspopup={switchable ? 'listbox' : undefined}
        aria-controls={switchable && open ? listId : undefined}
        className={cn(
          'text-ink flex items-center gap-2 rounded-md px-2 py-2 text-[0.875rem] transition-colors',
          switchable ? 'hover:bg-paper' : 'cursor-default'
        )}
      >
        <span className="text-muted text-[0.75rem]">{label}</span>
        <span className="font-medium">{current?.name ?? placeholder}</span>
        {switchable ? (
          <span aria-hidden="true" className="text-muted text-[0.6875rem]">
            ▾
          </span>
        ) : null}
      </button>

      {open && switchable && confirming && confirm ? (
        <div className="border-rule bg-card absolute z-20 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-md border p-4 shadow-lg">
          <p className="text-ink text-[0.875rem] font-medium">{confirming.name}</p>
          {confirming.detail ? (
            <p className="text-muted mt-0.5 font-mono text-[0.75rem]">{confirming.detail}</p>
          ) : null}
          <div className="mt-3">{confirm(confirming, () => setConfirmingId(null))}</div>
        </div>
      ) : null}

      {open && switchable && !confirming ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={`Switch ${label.toLowerCase()}`}
          className="border-rule bg-card absolute z-20 mt-1 max-h-80 min-w-64 overflow-y-auto rounded-md border py-1 shadow-lg"
        >
          {options.map((option) => {
            const isCurrent = option.id === currentId;
            return (
              <li key={option.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  disabled={pending}
                  onClick={() => {
                    if (confirm) {
                      setConfirmingId(option.id);
                      return;
                    }
                    setOpen(false);
                    if (!isCurrent) onSwitch(option.id);
                  }}
                  className={cn(
                    'hover:bg-paper flex w-full flex-col items-start px-3 py-2 text-left text-[0.875rem] transition-colors',
                    isCurrent && 'bg-drape-tint/40'
                  )}
                >
                  <span className="text-ink font-medium">
                    {option.name}
                    {/* Highlight alone must not carry meaning (WCAG 1.4.1). */}
                    {isCurrent ? <span className="sr-only"> (current)</span> : null}
                  </span>
                  {option.detail ? (
                    <span className="text-muted font-mono text-[0.75rem]">{option.detail}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A segment of the chain that cannot be switched — the clinic you belong to.
 *
 * Rendered as the identifier it is, in mono, so it reads as the same class of
 * fact as a branch code rather than as prose.
 */
export function ScopeLabel({ label, name }: { label: string; name: string }) {
  return (
    <span className="flex items-center gap-2 px-2 py-2">
      <span className="text-muted text-[0.75rem]">{label}</span>
      <span className="text-ink font-mono text-[0.8125rem]">{name}</span>
    </span>
  );
}
