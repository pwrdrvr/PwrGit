import { useCallback, useEffect, useState } from "react";
import { dispatch, subscribe } from "../../lib/pwrgit";

/**
 * The sync menu's "Check tags after sync" (`general.tagCheckAfterSync`). It
 * is main's setting, because main runs the check after every Fetch and Pull,
 * including timed ones. Null until the first read answers, so the menu never
 * shows a guessed state.
 */
export function useTagCheckAfterSync(): [boolean | null, (on: boolean) => void] {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    void dispatch("settings:read", undefined).then((result) => {
      if (active && result.ok) setOn(result.value.general.tagCheckAfterSync);
    });
    const off = subscribe("settings:changed", (snapshot) => {
      setOn(snapshot.general.tagCheckAfterSync);
    });
    return () => {
      active = false;
      off();
    };
  }, []);
  const choose = useCallback((next: boolean) => {
    setOn(next);
    void dispatch("settings:update", { patch: { general: { tagCheckAfterSync: next } } }).then((result) => {
      if (!result.ok) setOn(!next);
    });
  }, []);
  return [on, choose];
}
