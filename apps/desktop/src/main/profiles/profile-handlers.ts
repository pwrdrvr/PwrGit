import {
  err,
  isProfileThemeOverride,
  ok,
  type Profile,
  type BranchReveal
} from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { ProfileService } from "./profile-service";

export type ProfileHandlerDeps = {
  /** Rebuild profile-derived state and repaint an open profile window. */
  onChanged?: (profile: Profile) => void;
  /** Open-or-focus the window bound to a profile (one window per profile). */
  openWindow: (
    profileId: string,
    revealRepoId?: string,
    revealWorktreeId?: string,
    revealBranch?: BranchReveal
  ) => boolean;
  /** Hand a queued reveal to the window that just booted for a profile. */
  consumeReveal: (
    profileId: string
  ) => {
    repoId: string;
    worktreeId: string | null;
    branch: BranchReveal | null;
  } | null;
};

export function registerProfileHandlers(
  bus: CommandBus,
  profiles: ProfileService,
  deps: ProfileHandlerDeps
): void {
  const { onChanged, openWindow, consumeReveal } = deps;

  bus.register("profile:list", () => ok(profiles.snapshot()));
  bus.register("profile:openWindow", (req) => {
    const opened = openWindow(
      req.profileId,
      req.revealRepoId,
      req.revealWorktreeId,
      req.revealBranch
    );
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
      worktreeId: reveal?.worktreeId ?? null,
      branch: reveal?.branch ?? null
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
    if (
      req.theme !== undefined &&
      req.theme !== null &&
      !isProfileThemeOverride(req.theme)
    ) {
      return err({
        kind: "validation",
        code: "theme_invalid",
        message: "Profile theme must inherit the app setting, Dark, or Light"
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
    onChanged?.(profile);
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
    if (req.theme !== undefined && !isProfileThemeOverride(req.theme)) {
      return err({
        kind: "validation",
        code: "theme_invalid",
        message: "Profile theme must inherit the app setting, Dark, or Light"
      });
    }
    const profile = profiles.create(req);
    emitEvent("profile:changed", profiles.snapshot());
    onChanged?.(profile);
    return ok(profile);
  });
}
