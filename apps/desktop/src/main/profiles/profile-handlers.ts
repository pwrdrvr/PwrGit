import { err, ok, type Profile } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { ProfileService } from "./profile-service";

export type ProfileHandlerDeps = {
  /** Kick a background rescan when a profile becomes active. */
  onActivated?: (profile: Profile) => void;
  /** Rebuild anything derived from the profile list (native Profiles menu). */
  onChanged?: () => void;
  /** Open-or-focus the window bound to a profile (one window per profile). */
  openWindow: (
    profileId: string,
    revealRepoId?: string,
    revealWorktreeId?: string
  ) => boolean;
  /** Hand a queued reveal to the window that just booted for a profile. */
  consumeReveal: (
    profileId: string
  ) => { repoId: string; worktreeId: string | null } | null;
};

export function registerProfileHandlers(
  bus: CommandBus,
  profiles: ProfileService,
  deps: ProfileHandlerDeps
): void {
  const { onActivated, onChanged, openWindow, consumeReveal } = deps;

  bus.register("profile:list", () => ok(profiles.snapshot()));

  bus.register("profile:switch", (req) => {
    const profile = profiles.get(req.profileId);
    if (profile === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${req.profileId}"`
      });
    }
    const snapshot = profiles.switch(req.profileId);
    emitEvent("profile:changed", snapshot);
    onActivated?.(profile);
    onChanged?.();
    return ok(snapshot);
  });

  bus.register("profile:openWindow", (req) => {
    const opened = openWindow(req.profileId, req.revealRepoId, req.revealWorktreeId);
    if (!opened) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${req.profileId}"`
      });
    }
    emitEvent("profile:changed", profiles.snapshot());
    return ok(null);
  });

  bus.register("window:consumeReveal", (req) => {
    const reveal = consumeReveal(req.profileId);
    return ok({
      repoId: reveal?.repoId ?? null,
      worktreeId: reveal?.worktreeId ?? null
    });
  });

  bus.register("profile:update", (req) => {
    if (req.name !== undefined && req.name.trim() === "") {
      return err({
        kind: "validation",
        code: "name_required",
        message: "Profile name can't be empty"
      });
    }
    if (req.email !== undefined && req.email.trim() === "") {
      return err({
        kind: "validation",
        code: "email_required",
        message: "Commit email can't be empty"
      });
    }
    const profile = profiles.update(req);
    if (profile === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${req.profileId}"`
      });
    }
    emitEvent("profile:changed", profiles.snapshot());
    onChanged?.();
    return ok(profile);
  });

  bus.register("profile:create", (req) => {
    if (req.name.trim() === "") {
      return err({
        kind: "validation",
        code: "name_required",
        message: "Profile name is required"
      });
    }
    if (req.email.trim() === "") {
      return err({
        kind: "validation",
        code: "email_required",
        message: "Commit email is required"
      });
    }
    const profile = profiles.create(req);
    emitEvent("profile:changed", profiles.snapshot());
    onChanged?.();
    return ok(profile);
  });
}
