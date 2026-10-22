import { useCallback, useEffect, useRef } from 'react';

/**
 * Whether the component is still mounted, for answers that arrive after the
 * merchant has left the page: they may update storage, never the page.
 */
export function useIsActive(): () => boolean {
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return useCallback(() => active.current, []);
}
