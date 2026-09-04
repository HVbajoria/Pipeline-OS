import { useId, type ReactNode } from 'react';

export const ROLE_ACCESS_TOOLTIP =
  'Please ask the admin to upgrade your role to access this page, or sign up with a new email and choose the role during sign-up.';

interface AccessTooltipProps {
  children: ReactNode;
  message?: string;
}

/**
 * Tooltip wrapper for disabled controls. Native disabled buttons cannot be
 * focused or reliably hovered, so the wrapper owns the interaction states.
 */
export function AccessTooltip({
  children,
  message = ROLE_ACCESS_TOOLTIP
}: AccessTooltipProps) {
  const tooltipId = useId();

  return (
    <span
      className="access-tooltip"
      tabIndex={0}
      aria-describedby={tooltipId}
      aria-label={message}
      title={message}
    >
      {children}
      <span id={tooltipId} role="tooltip" className="access-tooltip__content">
        {message}
      </span>
    </span>
  );
}
