import { err, ok, type Profile } from "@pwrgit/shared";
import type { CommandBus } from "../command-bus";
import { emitEvent } from "../ipc";
import type { ProfileService } from "./profile-service";

export function registerProfileHandlers(
  bus: CommandBus,
  profiles: ProfileService,
  onActivated?: (profile: Profile) => void
): void {
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
    return ok(snapshot);
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
    return ok(profile);
  });
}
